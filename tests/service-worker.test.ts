import { afterEach, expect, it, vi } from "vitest";
import type { Request } from "../src/shared/messages";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../src/background/download");
  vi.resetModules();
});

it("cancels and removes a ZIP even when abort clears the active download ID", async () => {
  let writing!: () => void;
  const writingStarted = new Promise<void>((resolve) => { writing = resolve; });
  vi.doMock("../src/background/download", () => ({
    downloadBoard: async (_ref: unknown, _saveAs: boolean, deps: {
      save: (blob: Blob, filename: string, saveAs: boolean) => Promise<number>;
      wait: (id: number, signal: AbortSignal) => Promise<void>;
    }, _progress: unknown, signal: AbortSignal) => {
      const id = await deps.save(new Blob(["zip"]), "board.zip", false);
      writing();
      await deps.wait(id, signal);
    },
  }));

  class Channel {
    private listener?: (event: { data: unknown }) => void;
    addEventListener(_type: string, listener: (event: { data: unknown }) => void): void { this.listener = listener; }
    removeEventListener(): void { this.listener = undefined; }
    postMessage(message: { type: string; id?: string }): void {
      if (message.type === "create") this.listener?.({ data: { type: "created", id: message.id, url: "blob:test" } });
    }
  }
  vi.stubGlobal("BroadcastChannel", Channel);
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
      download: async () => 42,
      cancel,
      removeFile,
      search: async () => [{ id: 42, state: "in_progress" }],
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  await import("../src/background/service-worker");
  const listener = onMessage.mock.calls[0]![0] as (request: Request, sender: unknown, respond: (reply: unknown) => void) => void;
  const dispatch = (request: Request) => new Promise<{ ok: boolean; value?: { phase: string } }>((resolve) => listener(request, {}, (reply) => resolve(reply as { ok: boolean; value?: { phase: string } })));
  const download = dispatch({ type: "downloadBoards", refs: [{ username: "alice", slug: "ideas" }], saveAs: false });
  await writingStarted;
  const stopped = await dispatch({ type: "cancel" });
  expect(stopped).toMatchObject({ ok: true, value: { phase: "cancelled" } });
  expect(cancel).toHaveBeenCalledWith(42);
  expect(removeFile).toHaveBeenCalledWith(42);
  await download;
});
