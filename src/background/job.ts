// The job: walk a board, decide each pin, download what Pinterest allows.
//
// Chrome's service worker can be stopped at any time, so the job is written to
// storage after every step and every step is re-entrant: a restart resumes from
// the job rather than from memory. The popup is only a window onto the job.

import type { BoardRef, FileRecord, Job, JobProgress, MediaItem, PinRecord } from "../shared/types";
import { boardKey, boardUrl } from "../shared/boardref";
import { boardFolderName, fileStems, extensionOf } from "../shared/filenames";
import { eligibilityOf, mediaItemsOf } from "../shared/pins";
import { OUTPUT_ROOT } from "./storage";
import { BoardCrawler, loadSections, resolveBoard, type PageResult } from "./discovery";
import type { Downloader, MediaFile, RunnerDeps } from "./ports";
import { assembleHlsVideo } from "./video-hls";

/** How many pins are worked on at once. Pinterest throttles hard, so this is
 * deliberately small. */
export const MAX_CONCURRENT_PINS = 3;

/** The gap between two pins, in milliseconds. */
export const PIN_INTERVAL_MS = 90;

/** The resource that returns a pin's own record, including its eligibility. */
const PIN_RESOURCE = "PinResource";

/** How long an assembled video's blob URL is kept alive. */
const BLOB_LIFETIME_MS = 10 * 60 * 1000;

interface Outcome {
  state: "complete" | "interrupted";
  error?: string;
}

export class JobRunner {
  private job: Job | null = null;
  private crawler: BoardCrawler | null = null;
  private readonly seen = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly waiters = new Map<number, (outcome: Outcome) => void>();
  private readonly blobs = new Set<string>();
  private readonly held = new Set<string>();
  private running = false;
  private stopped = true;
  private lastActivity = 0;

  constructor(private readonly deps: RunnerDeps) {}

  /** Starts a new job for a board, replacing whatever was running. */
  async start(ref: BoardRef, source: "tab" | "input"): Promise<Job> {
    const job: Job = {
      version: 1,
      boardKey: boardKey(ref),
      board: null,
      source,
      phase: "resolving",
      streams: [],
      pinIds: [],
      cursor: 0,
      pins: {},
      duplicateCount: 0,
      files: {},

      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.job = job;
    this.crawler = null;
    this.seen.clear();
    this.blobs.clear();
    this.stopped = false;
    await this.deps.store.save(job);
    void this.run();
    return job;
  }

  /** Re-enters the job in storage, if there is one worth finishing. */
  async resume(): Promise<void> {
    const job = await this.deps.store.load();
    if (!job || job.phase === "done" || job.phase === "paused") return;
    this.job = job;
    this.crawler =
      job.streams.length > 0 && job.board
        ? new BoardCrawler(this.deps.client as never, job.board.id, job.streams)
        : null;
    this.seen.clear();
    for (const id of job.pinIds) this.seen.add(id);
    this.resetUnfinished(job);
    this.stopped = false;
    void this.run();
  }

  /** Pauses between steps; the job remembers where it was. */
  pause(): void {
    if (this.job) this.job.phase = "paused";
    this.stopped = true;
    void this.deps.store.save(this.job as Job);
  }

  /** Retries every pin that did not finish. */
  async retryFailed(): Promise<void> {
    const job = this.job ?? (await this.deps.store.load());
    if (!job) return;
    for (const id of Object.keys(job.pins)) {
      const record = job.pins[id];
      if (record && !isTerminal(record)) delete job.pins[id];
    }
    this.resetUnfinished(job);
    job.phase = "downloading";
    job.error = undefined;
    await this.deps.store.save(job);
    void this.run();
  }

  /** Drops the job and stops. */
  async cancel(): Promise<void> {
    this.stopped = true;
    this.job = null;
    this.crawler = null;
    await this.deps.store.clear();
  }

  progress(): JobProgress | null {
    return this.job ? progressOf(this.job, this.lastActivity) : null;
  }

  /** Reports a Chrome download changing state, so whoever waited for it wakes. */
  reportDownloadChange(downloadId: number, state: string, error?: string): void {
    const waiter = this.waiters.get(downloadId);
    if (!waiter) return;
    this.waiters.delete(downloadId);
    waiter({ state: state === "complete" ? "complete" : "interrupted", error });
  }

  /** The loop that carries a job through its phases. */
  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.job && !this.stopped) {
        const job = this.job;
        this.lastActivity = Date.now();
        job.updatedAt = this.lastActivity;

        if (job.phase === "paused" || job.phase === "done" || job.phase === "error") break;

        if (job.phase === "resolving") {
          await this.stepResolve(job);
          continue;
        }
        if (job.phase === "discovering") {
          const walked = await this.stepDiscover(job);
          await this.save(job);
          if (!walked) {
            job.phase = "downloading";
            await this.save(job);
          }
          await this.delay(BETWEEN_REQUESTS_MS);
          continue;
        }
        if (job.phase === "downloading") {
          const more = await this.downloadStep(job);
          await this.save(job);
          if (!more) {
            job.phase = "done";
            job.error = undefined;
            await this.save(job);
            break;
          }
          continue;
        }
        break;
      }
    } catch (error) {
      if (this.job) {
        this.job.phase = "error";
        this.job.error = message(error);
        await this.save(this.job);
      }
    } finally {
      this.running = false;
    }
  }

  /** Asks Pinterest about the board, then lists its sections. */
  private async stepResolve(job: Job): Promise<void> {
    const ref = refOf(job);
    const resolved = await resolveBoard(this.deps.client, ref, boardUrl(ref.username, ref.slug));
    job.board = resolved.info;
    const sections = resolved.hasSections ? await loadSections(this.deps.client, resolved.info.id) : [];
    job.streams = BoardCrawler.start(resolved.info.id, sections);
    this.crawler = new BoardCrawler(this.deps.client, resolved.info.id, job.streams);
    job.phase = "discovering";
    await this.save(job);
  }

  /** Fetches one more page of pins. Returns false when the board is walked. */
  private async stepDiscover(job: Job): Promise<boolean> {
    if (!this.crawler) return false;
    const page = await this.crawler.nextPage();
    if (!page) return false;
    this.recordPage(page);
    return this.crawler.remaining > 0;
  }

  private recordPage(page: PageResult): void {
    const job = this.job;
    if (!job) return;
    for (const id of page.pinIds) {
      if (this.seen.has(id)) {
        job.duplicateCount += 1;
        continue;
      }
      this.seen.add(id);
      job.pinIds.push(id);
    }
  }

  /** One round of downloads: start pins up to the concurrency cap, then wait for
   * a slot to free. Returns false when the board is finished. */
  private async downloadStep(job: Job): Promise<boolean> {
    await this.reconcileDownloads();

    while (job.cursor < job.pinIds.length && this.inflight.size < MAX_CONCURRENT_PINS) {
      const pinId = job.pinIds[job.cursor];
      if (!pinId) break;
      job.cursor += 1;
      if (job.pins[pinId] && isTerminal(job.pins[pinId])) continue;
      // A pin Chrome is still downloading for us is already being waited on.
      if (this.held.has(pinId)) continue;
      const work = this.processPin(job, pinId).finally(() => {
        this.inflight.delete(pinId);
      });
      this.inflight.set(pinId, work);
      await this.delay(0);
    }

    if (job.cursor >= job.pinIds.length && this.inflight.size === 0 && this.held.size === 0) return false;

    await Promise.race([...this.inflight.values()].map((work) => work.catch(() => undefined)));
    if (this.inflight.size > 0) await this.delay(PIN_INTERVAL_MS);
    return true;
  }

  /** Fetches one pin's record, decides whether it may be downloaded, and
   * downloads the media Pinterest makes available. */
  private async processPin(job: Job, pinId: string): Promise<void> {
    const record: PinRecord = job.pins[pinId] ?? { id: pinId, status: "checking" };
    job.pins[pinId] = record;
    record.status = "checking";

    try {
      const detail = await this.deps.client.getData(
        PIN_RESOURCE,
        { id: pinId, field_set_key: "detailed" },
        `/pin/${pinId}/`,
      );
      const eligibility = eligibilityOf(detail);

      if (eligibility === "ineligible") {
        record.status = "skipped";
        record.reason = "the pin's creator turned downloads off";
        return;
      }
      if (eligibility !== "eligible") {
        record.status = "failed";
        record.reason = "Pinterest did not say whether this pin may be downloaded";
        return;
      }

      const items: MediaItem[] = mediaItemsOf(detail);
      if (items.length === 0) {
        record.status = "skipped";
        record.reason = "this pin has no media Pinterest makes downloadable";
        return;
      }

      record.status = "downloading";
      const folder = `${OUTPUT_ROOT}/${this.folderOf(job)}`;
      const stems = fileStems(pinId, items.map((item) => item.label));
      // A file that already landed, or that Chrome is still downloading for us,
      // is never asked for twice.
      const known = new Set(Object.values(job.files).filter((record) => record.pinId === pinId).map((record) => record.filename));
      for (const filename of record.files ?? []) known.add(filename);
      const done: string[] = [];
      const failures: string[] = [];

      for (const [index, item] of items.entries()) {
        const stem = stems[index] ?? pinId;
        const extension = item.kind === "hls" ? ".mp4" : extensionOf(item.url, item.kind === "image" ? ".jpg" : ".mp4");
        const filename = `${folder}/${stem}${extension}`;
        if (known.has(filename)) continue;

        const file: MediaFile = { pinId, url: item.url, filename, kind: item.kind, index };
        try {
          const written = await this.downloadOne(job, file);
          done.push(written);
        } catch (error) {
          failures.push(`${message(error)}`);
        }
        await this.delay(0);
      }

      record.files = [...(record.files ?? []), ...done];
      if (failures.length > 0) {
        record.status = "failed";
        record.reason = failures.join("; ");
        return;
      }
      record.status = "downloaded";
      record.reason = undefined;
    } catch (error) {
      record.status = "failed";
      record.reason = message(error);
    }
  }

  /** Downloads one media file and waits for Chrome to actually finish it. */
  private async downloadOne(job: Job, file: MediaFile): Promise<string> {
    let url = file.url;
    let filename = file.filename;

    if (file.kind === "hls") {
      // A playlist is assembled here so that no playlist and no MPEG-TS stream
      // is ever written behind a video name.
      const video = await assembleHlsVideo(file.url, {
        fetchText: this.deps.fetchText,
        fetchBytes: this.deps.fetchBytes,
      });
      url = URL.createObjectURL(video.blob);
      this.blobs.add(url);
      filename = file.filename.replace(/\.[^./\\]+$/, "") + video.extension;
    }

    const downloadId = await this.deps.downloader.start({ url, filename });
    job.files[downloadId] = { downloadId, pinId: file.pinId, filename, state: "in_progress" };
    // Written immediately, so a job that is interrupted mid-download still knows
    // what Chrome is holding and never asks for the same file twice.
    await this.save(job);
    const outcome = await this.waitForDownload(downloadId);
    job.files[downloadId].state = outcome.state;
    const record = job.pins[file.pinId];
    if (outcome.state === "complete" && record) {
      record.files = [...(record.files ?? []), filename];
    }
    await this.save(job);
    if (outcome.state !== "complete") {
      throw new Error(outcome.error ?? "Chrome did not finish this download");
    }
    if (url.startsWith("blob:")) {
      URL.revokeObjectURL(url);
      this.blobs.delete(url);
    }
    return filename;
  }

  /** Waits for the download event that says a file really finished. */
  private waitForDownload(downloadId: number): Promise<Outcome> {
    return new Promise((resolve) => {
      this.waiters.set(downloadId, resolve);
    });
  }

  /** Looks at the downloads Chrome is still holding, so a restarted job keeps the
   * files that already landed and waits for the ones still running. */
  private async reconcileDownloads(): Promise<void> {
    const job = this.job;
    if (!job) return;
    const pending = Object.values(job.files).filter(
      (record) => record.state === "in_progress" && !this.waiters.has(record.downloadId),
    );
    if (pending.length === 0) return;

    const items = await this.deps.downloader.find(pending.map((record) => record.downloadId));
    for (const record of pending) {
      const item = items.find((candidate) => candidate.id === record.downloadId);
      if (!item || item.state === "interrupted") {
        record.state = "interrupted";
        continue;
      }
      if (item.state === "complete") {
        record.state = "complete";
        addFileTo(job, record);
        continue;
      }
      // Chrome is still writing this file. Wait for its event, then finish the
      // pin it belongs to, which starts whatever else the pin still needs.
      this.held.add(record.pinId);
      this.waiters.set(record.downloadId, (outcome) => {
        record.state = outcome.state === "complete" ? "complete" : "interrupted";
        if (record.state === "complete") addFileTo(job, record);
        const work = this.processPin(job, record.pinId).finally(() => {
          this.inflight.delete(record.pinId);
          this.held.delete(record.pinId);
        });
        this.inflight.set(record.pinId, work);
      });
    }
  }

  private folderOf(job: Job): string {
    return boardFolderName(job.board?.name ?? "", slugOfKey(job.boardKey));
  }

  private async save(job: Job): Promise<void> {
    await this.deps.store.save(job);
    this.deps.onJobUpdated?.(progressOf(job, this.lastActivity));
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) return;
    const sleep = this.deps.sleep ?? ((delay: number) => new Promise((resolve) => setTimeout(resolve, delay)));
    await sleep(ms);
  }

  /** Puts pins that did not finish back on the queue, so a resumed job picks up
   * exactly where it stopped and does not redo what is already on disk. */
  private resetUnfinished(job: Job): void {
    const firstUnfinished = job.pinIds.findIndex((id) => {
      const record = job.pins[id];
      return !record || !isTerminal(record);
    });
    job.cursor = firstUnfinished === -1 ? job.pinIds.length : firstUnfinished;
    if (job.phase === "done") job.phase = "downloading";
  }
}

const BETWEEN_REQUESTS_MS = 60;

function isTerminal(record: PinRecord): boolean {
  return record.status === "downloaded" || record.status === "skipped" || record.status === "failed";
}

/** Records a file that landed against the pin it belongs to. */
function addFileTo(job: Job, record: FileRecord): void {
  const pin = job.pins[record.pinId];
  if (!pin) return;
  const files = pin.files ?? [];
  if (!files.includes(record.filename)) pin.files = [...files, record.filename];
}

function refOf(job: Job): BoardRef {
  const [username, slug] = job.boardKey.split("/");
  return { username: username ?? "", slug: slug ?? "" };
}

function slugOfKey(key: string): string {
  const [username, slug] = key.split("/");
  return `${username ?? "board"}/${slug ?? "board"}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the popup shows. */
export function progressOf(job: Job, lastActivity: number): JobProgress {
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let filesDone = 0;
  let filesQueued = 0;
  for (const record of Object.values(job.pins)) {
    if (record.status === "downloaded") downloaded += 1;
    else if (record.status === "skipped") skipped += 1;
    else if (record.status === "failed") failed += 1;
    filesDone += record.files?.length ?? 0;
  }
  for (const record of Object.values(job.files)) {
    if (record.state !== "complete") filesQueued += 1;
    else filesQueued += 0;
  }

  return {
    phase: job.phase,
    boardKey: job.boardKey,
    board: job.board,
    discovered: job.pinIds.length,
    downloaded,
    skipped,
    failed,
    duplicates: job.duplicateCount,
    filesQueued: Object.keys(job.files).length,
    filesDone,
    detail: detailOf(job),
    error: job.error,
    updatedAt: lastActivity,
  };
}

function detailOf(job: Job): string {
  switch (job.phase) {
    case "resolving":
      return "asking Pinterest about the board";
    case "discovering":
      return `walking the board: ${job.pinIds.length} pins found`;
    case "downloading":
      return `${job.cursor} of ${job.pinIds.length} pins`;
    case "paused":
      return "paused";
    default:
      return job.error ?? "finished";
  }
}

/** The accounting a job must satisfy: every pin discovered in this run is
 * downloaded, skipped or failed, and nothing else. */
export function accountingProblems(job: Job): string[] {
  const problems: string[] = [];
  let accounted = 0;
  for (const id of job.pinIds) {
    const record = job.pins[id];
    if (record && isTerminal(record)) accounted += 1;
  }
  if (accounted > job.pinIds.length) {
    problems.push(`${accounted} pins are accounted for but only ${job.pinIds.length} were discovered`);
  }
  for (const id of Object.keys(job.pins)) {
    if (!job.pinIds.includes(id)) problems.push(`pin ${id} is recorded but was never discovered`);
  }
  return problems;
}
