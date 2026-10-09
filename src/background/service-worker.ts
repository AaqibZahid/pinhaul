import type { Request } from "../shared/messages";
import type { BoardRef, BoardSummary, BoardSyncResult, DownloadProgress } from "../shared/types";
import { listAccountBoards } from "./account";
import { downloadBoard } from "./download";
import { PinterestClient, PinterestError, type PinterestErrorKind } from "./pinterest";

const client = new PinterestClient({ intervalMs: 110 });
const BOARDS_KEY = "accountBoards";
const OFFSCREEN_PATH = "offscreen/offscreen.html";
const blobChannel = new BroadcastChannel("pinpull-blobs");
let creatingOffscreen: Promise<void> | null = null;

let active: {
  controller: AbortController;
  progress: DownloadProgress;
  downloadId?: number;
  objectUrl?: string;
  promise: Promise<void>;
} | null = null;
let lastProgress: DownloadProgress | null = null;

chrome.runtime.onMessage.addListener((message: Request, _sender, respond) => {
  handle(message).then(respond, (error: unknown) => respond({ ok: false, error: messageOf(error), kind: errorKind(error) }));
  return true;
});

async function handle(message: Request): Promise<unknown> {
  switch (message.type) {
    case "syncBoards":
      return { ok: true, value: await syncBoards() };
    case "downloadBoard": {
      const started = startDownload(message.ref, message.saveAs);
      if (!started.ok) return started.reply;
      await started.promise;
      return { ok: true, value: lastProgress };
    }
    case "status":
      return { ok: true, value: active?.progress ?? lastProgress };
    case "cancel":
      await cancelDownload();
      return { ok: true, value: lastProgress };
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

function startDownload(ref: BoardRef, saveAs: boolean): {
  ok: boolean;
  reply: { ok: boolean; value?: DownloadProgress; error?: string };
  promise?: Promise<void>;
} {
  if (active) return { ok: false, reply: { ok: false, error: "A board download is already in progress." } };
  const controller = new AbortController();
  const progress: DownloadProgress = {
    phase: "idle",
    board: { ...ref, id: "", name: ref.slug, url: `https://www.pinterest.com/${ref.username}/${ref.slug}/`, pinCount: null, sectionCount: null },
    discovered: 0,
    processed: 0,
    files: 0,
    skipped: 0,
    failed: 0,
    detail: "Starting",
    updatedAt: Date.now(),
  };
  const promise = runDownload(ref, saveAs, controller);
  active = { controller, progress, promise };
  return { ok: true, reply: { ok: true, value: progress }, promise };
}

async function runDownload(ref: BoardRef, saveAs: boolean, controller: AbortController): Promise<void> {
  try {
    const result = await downloadBoard(
      ref,
      saveAs,
      {
        client,
        save: (blob, filename, ask) => saveZip(blob, filename, ask),
        wait: waitForDownload,
      },
      (progress) => {
        if (active?.controller === controller) active.progress = progress;
      },
      controller.signal,
    );
    lastProgress = result;
  } catch (error) {
    const current = active?.progress;
    if (isAbort(error)) {
      lastProgress = current ? { ...current, phase: "cancelled", detail: "Download cancelled", updatedAt: Date.now() } : null;
    } else {
      lastProgress = current
        ? { ...current, phase: "error", detail: "Download failed", error: messageOf(error), updatedAt: Date.now() }
        : null;
    }
  } finally {
    if (active?.controller === controller && active.objectUrl) revokeObjectUrl(active.objectUrl);
    active = null;
  }
}

async function saveZip(blob: Blob, filename: string, saveAs: boolean): Promise<number> {
  const objectUrl = await createObjectUrl(blob);
  try {
    const id = await chrome.downloads.download({ url: objectUrl, filename, saveAs, conflictAction: "uniquify" });
    if (active) {
      active.downloadId = id;
      active.objectUrl = objectUrl;
      if (active.controller.signal.aborted) {
        await chrome.downloads.cancel(id).catch(() => undefined);
        await chrome.downloads.removeFile(id).catch(() => undefined);
        throw new DOMException("Download cancelled", "AbortError");
      }
    }
    return id;
  } catch (error) {
    revokeObjectUrl(objectUrl);
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

async function cancelDownload(): Promise<void> {
  const current = active;
  if (!current) return;
  current.controller.abort();
  if (current.downloadId === undefined) return;
  await chrome.downloads.cancel(current.downloadId).catch(() => undefined);
  await chrome.downloads.removeFile(current.downloadId).catch(() => undefined);
}

function waitForDownload(id: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      chrome.downloads.onChanged.removeListener(listener);
      signal.removeEventListener("abort", aborted);
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

