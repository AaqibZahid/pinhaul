import type { Request } from "../shared/messages";
import type { BoardRef, BoardSummary, BoardSyncResult, DownloadProgress } from "../shared/types";
import { listAccountBoards } from "./account";
import { downloadBoard } from "./download";
import { PinterestClient, PinterestError, type PinterestErrorKind } from "./pinterest";

const client = new PinterestClient({ intervalMs: 110 });
const BOARDS_KEY = "accountBoards";
const OFFSCREEN_PATH = "offscreen/offscreen.html";
const blobChannel = new BroadcastChannel("pinhaul-blobs");
let creatingOffscreen: Promise<void> | null = null;

type Job = {
  ref: BoardRef;
  saveAs: boolean;
  controller: AbortController;
  progress: DownloadProgress;
  downloadId?: number;
  objectUrl?: string;
  promise: Promise<void>;
  finish: () => void;
};

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = 0;

chrome.runtime.onMessage.addListener((message: Request, _sender, respond) => {
  handle(message).then(respond, (error: unknown) => respond({ ok: false, error: messageOf(error), kind: errorKind(error) }));
  return true;
});

async function handle(message: Request): Promise<unknown> {
  switch (message.type) {
    case "syncBoards":
      return { ok: true, value: await syncBoards() };
    case "downloadBoard": {
      const started = startDownloads([message.ref], message.saveAs);
      if (!started.ok) return started.reply;
      await started.promise;
      return { ok: true, value: started.jobs[0]?.progress ?? null };
    }
    case "downloadBoards": {
      const started = startDownloads(message.refs, message.saveAs);
      if (!started.ok) return started.reply;
      await started.promise;
      return { ok: true, value: started.jobs.map((job) => job.progress) };
    }
    case "status":
      return { ok: true, value: [...jobs.values()].map((job) => job.progress) };
    case "cancel":
      return { ok: true, value: await cancelDownload(message.key) };
    case "openPinterest":
      await chrome.tabs.create({ url: "https://www.pinterest.com/" });
      return { ok: true, value: null };
    default:
      return { ok: false, error: "unknown message" };
  }
}

async function syncBoards(): Promise<BoardSyncResult> {
  try {
    const boards = await listAccountBoards(client);
    await chrome.storage.local.set({ [BOARDS_KEY]: boards });
    return { boards, stale: false };
  } catch (error) {
    if (error instanceof PinterestError && !isCacheableFailure(error.kind)) throw error;
    const cached = await chrome.storage.local.get(BOARDS_KEY);
    const boards = cached[BOARDS_KEY] as BoardSummary[] | undefined;
    if (boards?.length) return { boards, stale: true };
    throw error;
  }
}

function startDownloads(refs: BoardRef[], saveAs: boolean):
  | { ok: false; reply: { ok: false; error: string } }
  | { ok: true; jobs: Job[]; promise: Promise<void> } {
  if (refs.length === 0) return { ok: false, reply: { ok: false, error: "Choose at least one board." } };
  const requested = refs.map((ref) => {
    const key = `${ref.username}/${ref.slug}`;
    const existing = jobs.get(key);
    if (existing && !terminal(existing.progress.phase)) return existing;
    const job = createJob(ref, saveAs);
    jobs.set(key, job);
    queue.push(job);
    return job;
  });
  pump();
  return { ok: true, jobs: requested, promise: Promise.all(requested.map((job) => job.promise)).then(() => undefined) };
}

function createJob(ref: BoardRef, saveAs: boolean): Job {
  const controller = new AbortController();
  const progress: DownloadProgress = {
    phase: "idle",
    board: { ...ref, id: "", name: ref.slug, url: `https://www.pinterest.com/${ref.username}/${ref.slug}/`, pinCount: null, sectionCount: null },
    discovered: 0,
    processed: 0,
    files: 0,
    images: 0,
    videos: 0,
    skipped: 0,
    failed: 0,
    detail: "Queued",
    updatedAt: Date.now(),
  };
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  return { ref, saveAs, controller, progress, promise, finish };
}

function pump(): void {
  while (running < 2 && queue.length > 0) {
    const job = queue.shift()!;
    if (job.controller.signal.aborted) continue;
    running += 1;
    void runDownload(job).finally(() => {
      running -= 1;
      job.finish();
      pump();
    });
  }
}

async function runDownload(job: Job): Promise<void> {
  try {
    job.progress = await downloadBoard(
      job.ref,
      job.saveAs,
      {
        client,
        save: (blob, filename, ask) => saveZip(job, blob, filename, ask),
        wait: (id, signal) => waitForDownload(job, id, signal),
      },
      (progress) => { job.progress = progress; },
      job.controller.signal,
    );
  } catch (error) {
    if (job.controller.signal.aborted || isAbort(error)) {
      job.progress = { ...job.progress, phase: "cancelled", detail: "Download cancelled", updatedAt: Date.now() };
    } else {
      job.progress = { ...job.progress, phase: "error", detail: "Download failed", error: messageOf(error), updatedAt: Date.now() };
    }
  } finally {
    if (job.downloadId !== undefined) releaseObjectUrl(job, job.downloadId);
  }
}

async function saveZip(job: Job, blob: Blob, filename: string, saveAs: boolean): Promise<number> {
  if (job.controller.signal.aborted) throw new DOMException("Download cancelled", "AbortError");
  const objectUrl = await createObjectUrl(blob);
  try {
    if (job.controller.signal.aborted) throw new DOMException("Download cancelled", "AbortError");
    const id = await chrome.downloads.download({ url: objectUrl, filename, saveAs, conflictAction: "uniquify" });
    job.downloadId = id;
    job.objectUrl = objectUrl;
    if (job.controller.signal.aborted) {
      await discardDownload(id);
      releaseObjectUrl(job, id);
      throw new DOMException("Download cancelled", "AbortError");
    }
    return id;
  } catch (error) {
    if (job.objectUrl !== objectUrl) revokeObjectUrl(objectUrl);
    throw error;
  }
}

async function createObjectUrl(blob: Blob): Promise<string> {
  await ensureOffscreenDocument();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("The ZIP download helper did not respond")), 10_000);
    const listener = (event: MessageEvent) => {
      const message = event.data as { type?: string; id?: string; url?: string };
      if (message.type !== "created" || message.id !== id || !message.url) return;
      finish(undefined, message.url);
    };
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timeout);
      blobChannel.removeEventListener("message", listener);
      error ? reject(error) : resolve(url as string);
    };
    blobChannel.addEventListener("message", listener);
    blobChannel.postMessage({ type: "create", id, blob });
  });
}

function revokeObjectUrl(url: string): void {
  blobChannel.postMessage({ type: "revoke", url });
}

async function ensureOffscreenDocument(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: "Create a temporary object URL for the completed board ZIP.",
  }).finally(() => {
    creatingOffscreen = null;
  });
  await creatingOffscreen;
}

async function cancelDownload(key: string): Promise<DownloadProgress | null> {
  const job = jobs.get(key);
  if (!job) return null;
  if (terminal(job.progress.phase)) return job.progress;
  const downloadId = job.downloadId;
  job.controller.abort();
  if (downloadId !== undefined) {
    await discardDownload(downloadId);
    releaseObjectUrl(job, downloadId);
  } else if (queue.includes(job)) {
    queue.splice(queue.indexOf(job), 1);
    job.progress = { ...job.progress, phase: "cancelled", detail: "Download cancelled", updatedAt: Date.now() };
    job.finish();
  }
  await job.promise;
  return job.progress;
}

async function discardDownload(id: number): Promise<void> {
  await chrome.downloads.cancel(id).catch(() => undefined);
  await chrome.downloads.removeFile(id).catch(() => undefined);
}

function waitForDownload(job: Job, id: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      chrome.downloads.onChanged.removeListener(listener);
      signal.removeEventListener("abort", aborted);
      releaseObjectUrl(job, id);
      error ? reject(error) : resolve();
    };
    const check = async () => {
      const item = (await chrome.downloads.search({ id }))[0];
      if (item?.state === "complete") finish();
      else if (item?.state === "interrupted") finish(new Error(item.error ?? "Chrome interrupted the ZIP download"));
    };
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== id || !delta.state?.current) return;
      if (delta.state.current === "complete") finish();
      if (delta.state.current === "interrupted") finish(new Error(delta.error?.current ?? "Chrome interrupted the ZIP download"));
    };
    const aborted = () => finish(new DOMException("Download cancelled", "AbortError"));
    if (signal.aborted) {
      aborted();
      return;
    }
    chrome.downloads.onChanged.addListener(listener);
    signal.addEventListener("abort", aborted, { once: true });
    void check();
  });
}

function releaseObjectUrl(job: Job, downloadId: number): void {
  if (job.downloadId !== downloadId || !job.objectUrl) return;
  revokeObjectUrl(job.objectUrl);
  delete job.objectUrl;
  delete job.downloadId;
}

function terminal(phase: DownloadProgress["phase"]): boolean {
  return phase === "done" || phase === "cancelled" || phase === "error";
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorKind(error: unknown): PinterestErrorKind | undefined {
  return error instanceof PinterestError ? error.kind : undefined;
}

function isCacheableFailure(kind: PinterestErrorKind): boolean {
  return kind === "rate-limited" || kind === "server" || kind === "transport";
}

