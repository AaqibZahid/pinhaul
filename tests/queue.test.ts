import { describe, expect, it } from "vitest";
import { runBoardQueue } from "../src/background/queue";
import type { BoardRef, DownloadProgress } from "../src/shared/types";

describe("runBoardQueue", () => {
  it("runs boards in order and keeps intermediate completion inside the queue", async () => {
    const refs: BoardRef[] = [{ username: "alice", slug: "one" }, { username: "alice", slug: "two" }];
    const ran: string[] = [];
    const seen: DownloadProgress[] = [];
    const result = await runBoardQueue(
      refs,
      async (ref, report) => {
        ran.push(ref.slug);
        const progress = complete(ref);
        report(progress);
        return progress;
      },
      (progress) => seen.push(progress),
      new AbortController().signal,
    );

    expect(ran).toEqual(["one", "two"]);
    expect(seen.map(({ phase, queuePosition, queueTotal }) => ({ phase, queuePosition, queueTotal }))).toEqual([
      { phase: "idle", queuePosition: 1, queueTotal: 2 },
      { phase: "done", queuePosition: 2, queueTotal: 2 },
    ]);
    expect(result).toMatchObject({ phase: "done", queuePosition: 2, queueTotal: 2 });
  });
});

function complete(ref: BoardRef): DownloadProgress {
  return {
    phase: "done",
    board: { ...ref, id: ref.slug, name: ref.slug, url: "https://www.pinterest.com/", pinCount: 1, sectionCount: 0 },
    discovered: 1,
    processed: 1,
    files: 1,
    skipped: 0,
    failed: 0,
    detail: "1 file saved",
    updatedAt: Date.now(),
  };
}
