import { afterEach, expect, it, vi } from "vitest";
import type { DownloadDeps } from "../src/background/download";
import type { Request } from "../src/shared/messages";
import type { BoardRef, DownloadProgress } from "../src/shared/types";

type Run = (
  ref: BoardRef,
  saveAs: boolean,
  deps: DownloadDeps,
  report: (progress: DownloadProgress) => void,
  signal: AbortSignal,
) => Promise<DownloadProgress>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../src/background/download");
  vi.resetModules();
});

it("runs two boards together, queues the third, and retains each result", async () => {
  const started: string[] = [];
  const finish = new Map<string, (progress: DownloadProgress) => void>();
  const { dispatch } = await setup(async (board, _saveAs, _deps, report) => {
    started.push(board.slug);
    report(progress(board, "downloading"));
    return new Promise((resolve) => finish.set(board.slug, resolve));
  });
  const refs = [ref("one"), ref("two"), ref("three")];
  const request = dispatch({ type: "downloadBoards", refs, saveAs: false });
  expect(started).toEqual(["one", "two"]);
  expect((await dispatch({ type: "status" })).value).toMatchObject([
    { phase: "downloading", board: { slug: "one" } },
    { phase: "downloading", board: { slug: "two" } },
    { phase: "idle", board: { slug: "three" } },
  ]);
  finish.get("one")!(progress(refs[0]!, "done"));
  await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
  finish.get("two")!(progress(refs[1]!, "done"));
  finish.get("three")!(progress(refs[2]!, "done"));
  expect((await request).value).toMatchObject([{ phase: "done" }, { phase: "done" }, { phase: "done" }]);
});

it("deduplicates active and queued boards, then permits a completed board to rerun", async () => {
  const started: string[] = [];
  const finish: Array<(progress: DownloadProgress) => void> = [];
  const { dispatch } = await setup(async (board, _saveAs, _deps, report) => {
    started.push(board.slug);
    report(progress(board, "downloading"));
    return new Promise((resolve) => finish.push(resolve));
  });
  const first = dispatch({ type: "downloadBoards", refs: [ref("one"), ref("two"), ref("three"), ref("three")], saveAs: false });
  const duplicate = dispatch({ type: "downloadBoards", refs: [ref("one"), ref("three")], saveAs: true });
  expect(started).toEqual(["one", "two"]);
  finish[0]!(progress(ref("one"), "done"));
  await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
  finish[1]!(progress(ref("two"), "done"));
  finish[2]!(progress(ref("three"), "done"));
  await Promise.all([first, duplicate]);
  const rerun = dispatch({ type: "downloadBoards", refs: [ref("one")], saveAs: false });
  expect(started).toEqual(["one", "two", "three", "one"]);
  finish[3]!(progress(ref("one"), "done"));
  await rerun;
});

it("cancels only the selected ZIP and removes its partial file", async () => {
  const { dispatch, cancel, removeFile, complete, downloads } = await setup(async (board, _saveAs, deps, report, signal) => {
    report(progress(board, "saving"));
    const id = await deps.save(new Blob([board.slug]), `${board.slug}.zip`, false);
    await deps.wait(id, signal);
    return progress(board, "done");
  });
  const request = dispatch({ type: "downloadBoards", refs: [ref("one"), ref("two")], saveAs: false });
  await vi.waitFor(() => expect(downloads).toHaveBeenCalledTimes(2));
  const stopped = await dispatch({ type: "cancel", key: "alice/one" });
  expect(stopped).toMatchObject({ ok: true, value: { phase: "cancelled", board: { slug: "one" } } });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledWith(1);
  expect(removeFile).toHaveBeenCalledTimes(1);
  expect(removeFile).toHaveBeenCalledWith(1);
  expect((await dispatch({ type: "status" })).value).toMatchObject([
    { phase: "cancelled", board: { slug: "one" } },
    { phase: "saving", board: { slug: "two" } },
  ]);
  complete(2);
  expect((await request).value).toMatchObject([{ phase: "cancelled" }, { phase: "done" }]);
});

it("cancels a queued board without starting it or saving a ZIP", async () => {
  const finish: Array<(progress: DownloadProgress) => void> = [];
  const started: string[] = [];
  const { dispatch, downloads } = await setup(async (board, _saveAs, _deps, report) => {
    started.push(board.slug);
    report(progress(board, "downloading"));
    return new Promise((resolve) => finish.push(resolve));
  });
  const request = dispatch({ type: "downloadBoards", refs: [ref("one"), ref("two"), ref("three")], saveAs: false });
  expect((await dispatch({ type: "cancel", key: "alice/three" })).value).toMatchObject({ phase: "cancelled" });
  finish[0]!(progress(ref("one"), "done"));
  finish[1]!(progress(ref("two"), "done"));
  await request;
  expect(started).toEqual(["one", "two"]);
  expect(downloads).not.toHaveBeenCalled();
});

it("does not hand a ZIP to Chrome if stopped before the save begins", async () => {
  let continueToSave!: () => void;
  const paused = new Promise<void>((resolve) => { continueToSave = resolve; });
  const { dispatch, downloads } = await setup(async (board, _saveAs, deps, report) => {
    report(progress(board, "packaging"));
    await paused;
    await deps.save(new Blob([board.slug]), `${board.slug}.zip`, false);
    return progress(board, "done");
  });
  const request = dispatch({ type: "downloadBoards", refs: [ref("one")], saveAs: false });
  const stopped = dispatch({ type: "cancel", key: "alice/one" });
  continueToSave();
  expect((await stopped).value).toMatchObject({ phase: "cancelled" });
  await request;
  expect(downloads).not.toHaveBeenCalled();
});

function ref(slug: string): BoardRef {
  return { username: "alice", slug };
}

function progress(board: BoardRef, phase: DownloadProgress["phase"]): DownloadProgress {
  return {
    phase,
    board: { ...board, id: board.slug, name: board.slug, url: `https://www.pinterest.com/alice/${board.slug}/`, pinCount: 1, sectionCount: 0 },
    discovered: 1, processed: phase === "done" ? 1 : 0, files: phase === "done" ? 1 : 0,
    images: phase === "done" ? 1 : 0, videos: 0, skipped: 0, failed: 0,
    detail: phase, updatedAt: Date.now(),
  };
}

async function setup(run: Run) {
  vi.doMock("../src/background/download", () => ({ downloadBoard: run }));
  class Channel {
    private listener?: (event: { data: unknown }) => void;
    addEventListener(_type: string, listener: (event: { data: unknown }) => void): void { this.listener = listener; }
    removeEventListener(): void { this.listener = undefined; }
    postMessage(message: { type: string; id?: string }): void {
      if (message.type === "create") this.listener?.({ data: { type: "created", id: message.id, url: `blob:${message.id}` } });
    }
  }
  vi.stubGlobal("BroadcastChannel", Channel);
  let nextId = 0;
  const states = new Map<number, "in_progress" | "complete">();
  const listeners = new Set<(delta: chrome.downloads.DownloadDelta) => void>();
  const downloads = vi.fn(async () => {
    const id = ++nextId;
    states.set(id, "in_progress");
    return id;
  });
  const cancel = vi.fn(async () => undefined);
  const removeFile = vi.fn(async () => undefined);
  const onMessage = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: { addListener: onMessage },
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => [{}],
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
    },
    downloads: {
      download: downloads, cancel, removeFile,
      search: async ({ id }: { id: number }) => [{ id, state: states.get(id) }],
      onChanged: {
        addListener: (listener: (delta: chrome.downloads.DownloadDelta) => void) => listeners.add(listener),
        removeListener: (listener: (delta: chrome.downloads.DownloadDelta) => void) => listeners.delete(listener),
      },
    },
  });
  await import("../src/background/service-worker");
  const listener = onMessage.mock.calls[0]![0] as (request: Request, sender: unknown, respond: (reply: unknown) => void) => void;
  const dispatch = (request: Request) => new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => listener(request, {}, (reply) => resolve(reply as { ok: boolean; value?: unknown; error?: string })));
  const complete = (id: number) => {
    states.set(id, "complete");
    for (const listener of listeners) listener({ id, state: { current: "complete" } });
  };
  return { dispatch, downloads, cancel, removeFile, complete };
}
