// The extension's entry point.
//
// It owns the job: it starts it, listens for Chrome's download events, and starts
// again when the browser does or when a watchdog alarm fires. Nothing here
// depends on the popup being open.

import { parseBoardRef } from "../shared/boardref";
import type { Request } from "../shared/messages";
import { PinterestClient } from "./pinterest";
import { JobRunner, progressOf } from "./job";
import { createStorageStore } from "./storage";
import type { DownloadItem, Downloader } from "./ports";

const client = new PinterestClient({ intervalMs: 110 });
const store = createStorageStore(chrome.storage.local);
const downloader = createChromeDownloader();
const runner = new JobRunner({
  client,
  store,
  downloader,
  fetchText: (url) => clientText(url),
  fetchBytes: (url, range) => clientBytes(url, range),
});

/** Chrome's downloads API, behind the interface the runner expects. */
function createChromeDownloader(): Downloader {
  return {
    async start(request) {
      const id = await chrome.downloads.download({
        url: request.url,
        filename: request.filename,
        saveAs: false,
        conflictAction: "uniquify",
      });
      return id;
    },
    async find(ids) {
      // Chrome's search takes one id at a time.
      const items: DownloadItem[] = [];
      for (const id of ids) {
        const found = await chrome.downloads.search({ id });
        const item = found[0];
        if (!item) continue;
        items.push({ id: item.id, state: chromeDownloadState(item.state), error: item.error ?? undefined });
      }
      return items;
    },
    reveal() {
      chrome.downloads.showDefaultFolder();
    },
  };
}

function chromeDownloadState(state: string): DownloadItem["state"] {
  if (state === "complete") return "complete";
  if (state === "interrupted") return "interrupted";
  return "in_progress";
}

async function clientText(url: string): Promise<string> {
  const response = await fetch(url, { credentials: "include" });
  return response.text();
}

async function clientBytes(url: string, range?: { offset: number; length: number }): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (range) {
    const end = range.offset + range.length - 1;
    headers.Range = `bytes=${range.offset}-${end}`;
  }
  const response = await fetch(url, { headers, credentials: "include" });
  return new Uint8Array(await response.arrayBuffer());
}

/** Chrome's own download events, which only fire while the service worker is
 * listening, so the listener is registered at the top level. */
chrome.downloads.onChanged.addListener(({ id, state }) => {
  if (!state?.current) return;
  runner.reportDownloadChange(id, state.current, undefined);
});

chrome.runtime.onMessage.addListener((message: Request, _sender, respond) => {
  handle(message).then(respond, (error: unknown) =>
    respond({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

async function handle(message: Request): Promise<unknown> {
  switch (message.type) {
    case "detectBoard": {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tabs[0]?.url;
      if (!url) return { board: null, error: "Open a board, or paste a board link." };
      const parsed = parseBoardRef(url);
      return parsed.ok ? { board: parsed.ref } : { board: null };
    }
    case "start": {
      const started = await runner.start(message.ref, message.source);
      await watchJob();
      return { ok: true, value: started };
    }
    case "status":
      return { ok: true, value: await status() };
    case "pause":
      runner.pause();
      await watchJob();
      return { ok: true, value: await status() };
    case "resume":
      await runner.resume();
      await watchJob();
      return { ok: true, value: await status() };
    case "retry":
      await runner.retryFailed();
      await watchJob();
      return { ok: true, value: await status() };
    case "cancel":
      await runner.cancel();
      await watchJob();
      return { ok: true, value: null };
    case "openFolder":
      downloader.reveal();
      return { ok: true, value: null };
    default:
      return { ok: false, error: "unknown message" };
  }
}

/** The job as it stands, whether or not this run of the service worker owns the
 * job right now. */
async function status() {
  const job = await store.load();
  if (!job) return null;
  const memory = runner.progress();
  return memory ? memory : progressOf(job, job.updatedAt);
}

/** The watchdog that carries a job on if the service worker was stopped. */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "pinpull-watchdog") return;
  void runner.resume();
});

chrome.runtime.onStartup.addListener(() => void runner.resume());
chrome.runtime.onInstalled.addListener(() => void runner.resume());

const WATCHDOG = "pinpull-watchdog";

/** Keeps a scheduled wake-up while a job is running, and stops it when it is
 * not. Chrome resets it whenever the job asks again. */
async function watchJob(): Promise<void> {
  const job = await store.load();
  const running = job && job.phase !== "done" && job.phase !== "paused" && job.phase !== "error";
  const existing = await chrome.alarms.get(WATCHDOG);
  if (running && !existing) await chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  if (!running && existing) await chrome.alarms.clear(WATCHDOG);
}
