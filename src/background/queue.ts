import type { BoardRef, DownloadProgress } from "../shared/types";

type RunBoard = (
  ref: BoardRef,
  onProgress: (progress: DownloadProgress) => void,
  signal: AbortSignal,
) => Promise<DownloadProgress>;

export async function runBoardQueue(
  refs: BoardRef[],
  run: RunBoard,
  onProgress: (progress: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<DownloadProgress> {
  if (refs.length === 0) throw new Error("Choose at least one board.");
  let last: DownloadProgress | null = null;
  for (const [index, ref] of refs.entries()) {
    last = await run(
      ref,
      (progress) => {
        const queued = { ...progress, queuePosition: index + 1, queueTotal: refs.length };
        if (queued.phase === "done" && index + 1 < refs.length) {
          queued.phase = "idle";
          queued.detail = `${queued.board?.name ?? ref.slug} saved · starting next board`;
        }
        onProgress(queued);
      },
      signal,
    );
    last = { ...last, queuePosition: index + 1, queueTotal: refs.length };
  }
  return last as DownloadProgress;
}
