import type { Request } from "../shared/messages";
import type { BoardRef, BoardSummary, DownloadProgress } from "../shared/types";
import { listAccountBoards } from "./account";
import { downloadBoard } from "./download";
import { PinterestClient } from "./pinterest";

const client = new PinterestClient({ intervalMs: 110 });
const BOARDS_KEY = "accountBoards";

let active: {
  controller: AbortController;
  progress: DownloadProgress;
  downloadId?: number;
} | null = null;
let lastProgress: DownloadProgress | null = null;

chrome.runtime.onMessage.addListener((message: Request, _sender, respond) => {
  handle(message).then(respond, (error: unknown) => respond({ ok: false, error: messageOf(error) }));
  return true;
});

async function handle(message: Request): Promise<unknown> {
  switch (message.type) {
    case "syncBoards":
      return { ok: true, value: await syncBoards() };
    case "downloadBoard":
      return startDownload(message.ref, message.saveAs);
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

async function syncBoards(): Promise<BoardSummary[]> {
  try {
    const boards = await listAccountBoards(client);
    await chrome.storage.local.set({ [BOARDS_KEY]: boards });
    return boards;
  } catch (error) {
    const cached = await chrome.storage.local.get(BOARDS_KEY);
    const boards = cached[BOARDS_KEY] as BoardSummary[] | undefined;
    if (boards?.length) return boards;
    throw error;
  }
}

function startDownload(ref: BoardRef, saveAs: boolean): { ok: boolean; value?: DownloadProgress; error?: string } {
  if (active) return { ok: false, error: "A board download is already in progress." };
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
  active = { controller, progress };
  void runDownload(ref, saveAs, controller);
  return { ok: true, value: progress };
}

async function runDownload(ref: BoardRef, saveAs: boolean, controller: AbortController): Promise<void> {
  try {
    const result = await downloadBoard(
      ref,
      saveAs,
      {
        client,
        save: (url, filename, ask) => saveZip(url, filename, ask),
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
    active = null;
  }
}

async function saveZip(url: string, filename: string, saveAs: boolean): Promise<number> {
  const id = await chrome.downloads.download({ url, filename, saveAs, conflictAction: "uniquify" });
  if (active) active.downloadId = id;
  return id;
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

