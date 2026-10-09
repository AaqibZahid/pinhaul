// Where a job lives between the service worker's restarts.
//
// The job is the only thing that has to survive, so it is one value under one
// key in chrome.storage.local. The popup reads it and never owns it, so closing
// the popup cannot stop or lose a download.

import type { Job } from "../shared/types";
import type { JobStore } from "./ports";

const KEY = "job";

/** The store that binds to chrome.storage.local. */
export function createStorageStore(storage: Pick<typeof chrome.storage.local, "get" | "set" | "remove">): JobStore {
  return {
    async load() {
      const record = await storage.get(KEY);
      return (record[KEY] as Job | undefined) ?? null;
    },
    async save(job) {
      await storage.set({ [KEY]: job });
    },
    async clear() {
      await storage.remove(KEY);
    },
  };
}

/** The jobs the extension remembers, so a repeated run can skip what is already
 * on disk. One entry per board. */
export interface BoardHistory {
  key: string;
  name: string;
  downloaded: number;
  skipped: number;
  failed: number;
  finishedAt: number;
}

const HISTORY_KEY = "history";

export async function loadHistory(storage: Pick<typeof chrome.storage.local, "get" | "set">): Promise<BoardHistory[]> {
  const record = await storage.get(HISTORY_KEY);
  return (record[HISTORY_KEY] as BoardHistory[] | undefined) ?? [];
}

export async function rememberBoard(
  storage: Pick<typeof chrome.storage.local, "get" | "set">,
  entry: BoardHistory,
): Promise<void> {
  const history = await loadHistory(storage);
  const kept = history.filter((item) => item.key !== entry.key);
  kept.unshift(entry);
  await storage.set({ [HISTORY_KEY]: kept.slice(0, 20) });
}

/** The output folder Chrome is asked to write into. */
export const OUTPUT_ROOT = "Pinpull";
