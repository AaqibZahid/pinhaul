// Types shared between the popup, the service worker and the tests.

/** A Pinterest board, named the way the URL names it. */
export interface BoardRef {
  username: string;
  slug: string;
}

/** What Pinterest reports about a board. */
export interface BoardInfo {
  id: string;
  name: string;
  url: string;
  pinCount: number | null;
  sectionCount: number | null;
  thumbnailUrl?: string;
}

/** A board shown in the account picker or entered manually. */
export type BoardSummary = BoardInfo & { username: string; slug: string };

export interface BoardSyncResult {
  boards: BoardSummary[];
  stale: boolean;
}

/** How a chosen media candidate has to be fetched. */
export type MediaKind = "image" | "video" | "hls";

/** One file a pin contributes to the output directory. */
export interface MediaItem {
  /** Distinguishes several files from one pin (carousel slot, story page). */
  label: string;
  url: string;
  kind: MediaKind;
}

/** One piece of discovery work left to do. */
export interface DiscoveryStream {
  kind: "feed" | "section";
  /** Section id, when the stream is a section. */
  id: string;
  /** Section name, when this stream represents a board section. */
  name?: string;
  /** Cursor for the next page, or null for the first page. */
  bookmark: string | null;
  /** Sections are visited once; the board feed is enumerated to its end. */
  done?: boolean;
}

export type DownloadPhase =
  | "idle"
  | "resolving"
  | "discovering"
  | "downloading"
  | "packaging"
  | "saving"
  | "done"
  | "cancelled"
  | "error";

export interface DownloadProgress {
  phase: DownloadPhase;
  board: BoardSummary | null;
  discovered: number;
  processed: number;
  files: number;
  skipped: number;
  failed: number;
  detail: string;
  error?: string;
  queuePosition?: number;
  queueTotal?: number;
  updatedAt: number;
}
