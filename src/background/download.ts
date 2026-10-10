import type { BoardRef } from "../shared/types";
import type { BoardSummary, DownloadProgress, MediaItem } from "../shared/types";
import { boardFolderName, extensionOf, fileStems } from "../shared/filenames";
import { mediaItemsOf } from "../shared/pins";
import { assembleHlsVideo } from "./video-hls";
import { BoardCrawler, loadSections, resolveBoard } from "./discovery";
import type { PinterestGateway } from "./pinterest";
import { ZipWriter } from "./zip";

export interface DownloadDeps {
  client: PinterestGateway;
  save: (blob: Blob, filename: string, saveAs: boolean) => Promise<number>;
  wait: (downloadId: number, signal: AbortSignal) => Promise<void>;
}

export async function downloadBoard(
  ref: BoardRef,
  saveAs: boolean,
  deps: DownloadDeps,
  onProgress: (progress: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<DownloadProgress> {
  const progress = initialProgress(ref);
  report(progress, onProgress);
  throwIfAborted(signal);

  progress.phase = "resolving";
  progress.detail = "Reading board details";
  report(progress, onProgress);
  const resolved = await resolveBoard(deps.client, ref, `https://www.pinterest.com/${ref.username}/${ref.slug}/`);
  progress.board = { ...resolved.info, username: ref.username, slug: ref.slug };

  const sections = resolved.info.sectionCount === 0 ? [] : await loadSections(deps.client, resolved.info.id);
  const crawler = new BoardCrawler(deps.client, resolved.info.id, BoardCrawler.start(resolved.info.id, sections));
  const sectionForPin = new Map<string, string>();
  const feedForPin = new Map<string, unknown>();
  const pinIds: string[] = [];
  const seen = new Set<string>();

  progress.phase = "discovering";
  progress.detail = "Collecting pins and sections";
  report(progress, onProgress);
  for (;;) {
    throwIfAborted(signal);
    const page = await crawler.nextPage();
    if (!page) break;
    for (const pin of page.pins) {
      if (!feedForPin.has(pin.id)) feedForPin.set(pin.id, pin.data);
    }
    for (const id of page.pinIds) {
      if (page.sectionName && !sectionForPin.has(id)) sectionForPin.set(id, page.sectionName);
      if (seen.has(id)) continue;
      seen.add(id);
      pinIds.push(id);
    }
    progress.discovered = pinIds.length;
    progress.detail = `${pinIds.length} pins found`;
    report(progress, onProgress);
  }

  const zip = new ZipWriter();
  progress.phase = "downloading";
  progress.detail = "Downloading media";
  report(progress, onProgress);
  for (const pinId of pinIds) {
    throwIfAborted(signal);
    await addPin(zip, pinId, feedForPin.get(pinId), sectionForPin.get(pinId), progress, deps, signal);
    progress.processed += 1;
    progress.detail = `${progress.processed} of ${pinIds.length} pins`;
    report(progress, onProgress);
  }

  throwIfAborted(signal);
  progress.phase = "packaging";
  progress.detail = "Building ZIP archive";
  report(progress, onProgress);
  const blob = zip.build();
  throwIfAborted(signal);

  progress.phase = "saving";
  progress.detail = "Saving ZIP file";
  report(progress, onProgress);
  const downloadId = await deps.save(blob, `${boardFolderName(progress.board?.name ?? ref.slug, ref.slug)}.zip`, saveAs);
  await deps.wait(downloadId, signal);

  progress.phase = "done";
  progress.detail = [
    `${progress.files} files saved`,
    progress.skipped ? `${progress.skipped} without media` : "",
    progress.failed ? `${progress.failed} failed` : "",
  ].filter(Boolean).join(" · ");
  report(progress, onProgress);
  return progress;
}

async function addPin(
  zip: ZipWriter,
  pinId: string,
  feedPin: unknown,
  section: string | undefined,
  progress: DownloadProgress,
  deps: DownloadDeps,
  signal: AbortSignal,
): Promise<void> {
  try {
    const detail = await deps.client.getData("PinResource", { id: pinId, field_set_key: "detailed" }, `/pin/${pinId}/`);
    const items = mediaItemsOf(detail);
    if (items.length === 0) items.push(...mediaItemsOf(feedPin));
    if (items.length === 0) {
      progress.skipped += 1;
      return;
    }
    const stems = fileStems(pinId, items.map((item) => item.label));
    const boardFolder = boardFolderName(progress.board?.name ?? "", progress.board?.slug ?? "board");
    const sectionFolder = section ? boardFolderName(section, "section") : null;
    const folder = sectionFolder ? `${boardFolder}/${sectionFolder}` : boardFolder;

    for (const [index, item] of items.entries()) {
      throwIfAborted(signal);
      const file = await media(item, deps, signal);
      const stem = stems[index] ?? pinId;
      const extension = item.kind === "hls" ? ".mp4" : extensionOf(item.url, item.kind === "image" ? ".jpg" : ".mp4");
      zip.add(`${folder}/${stem}${extension}`, file.bytes);
      progress.files += 1;
    }
  } catch (error) {
    if (isAbort(error)) throw error;
    progress.failed += 1;
  }
}

async function media(item: MediaItem, deps: DownloadDeps, signal: AbortSignal): Promise<{ bytes: Uint8Array; extension: string }> {
  if (item.kind === "hls") {
    const video = await assembleHlsVideo(item.url, {
      fetchText: (url) => fetchText(url, signal),
      fetchBytes: (url, range) => fetchBytes(url, signal, range),
    });
    return { bytes: new Uint8Array(await video.blob.arrayBuffer()), extension: video.extension };
  }
  return { bytes: await fetchBytes(item.url, signal), extension: extensionOf(item.url, item.kind === "image" ? ".jpg" : ".mp4") };
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new Error(`media request failed (${response.status})`);
  return response.text();
}

async function fetchBytes(url: string, signal: AbortSignal, range?: { offset: number; length: number }): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
  const response = await fetch(url, { credentials: "include", headers, signal });
  if (!response.ok) throw new Error(`media request failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

function initialProgress(ref: BoardRef): DownloadProgress {
  return {
    phase: "idle",
    board: {
      id: "",
      name: ref.slug,
      url: `https://www.pinterest.com/${ref.username}/${ref.slug}/`,
      username: ref.username,
      slug: ref.slug,
      pinCount: null,
      sectionCount: null,
    },
    discovered: 0,
    processed: 0,
    files: 0,
    skipped: 0,
    failed: 0,
    detail: "Starting",
    updatedAt: Date.now(),
  };
}

function report(progress: DownloadProgress, onProgress: (progress: DownloadProgress) => void): void {
  progress.updatedAt = Date.now();
  onProgress({ ...progress });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Download cancelled", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
