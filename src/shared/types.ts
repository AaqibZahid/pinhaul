// Types shared between the popup, the service worker and the tests.

/** Whether Pinterest lets the current user download a pin. */
export type Eligibility = "eligible" | "ineligible" | "unknown";

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

/** A pin's terminal outcome. */
export type PinOutcome = "downloaded" | "skipped" | "failed";

/** Per-pin progress. `unknown` is a deliberate, reported state. */
export type PinStatus =
  | "queued"
  | "checking"
  | "downloading"
  | PinOutcome;

export interface PinRecord {
  id: string;
  status: PinStatus;
  /** Why the pin was skipped or failed. Absent when it downloaded. */
  reason?: string;
  /** Files written for this pin, relative to the board folder. */
  files?: string[];
}

/** Where a job is in its lifecycle. */
export type JobPhase =
  | "resolving"
  | "discovering"
  | "downloading"
  | "paused"
  | "done"
  | "error";

/** One piece of discovery work left to do. */
export interface DiscoveryStream {
  kind: "feed" | "section";
  /** Section id, when the stream is a section. */
  id: string;
  /** Cursor for the next page, or null for the first page. */
  bookmark: string | null;
  /** Sections are visited once; the board feed is enumerated to its end. */
  done?: boolean;
}

/** A single job: one download run of one board. */
export interface Job {
  version: 1;
  boardKey: string;
  board: BoardInfo | null;
  /** Where the board reference came from. */
  source: "tab" | "input";
  phase: JobPhase;
  streams: DiscoveryStream[];
  /** Every unique pin id discovered, in the order it was seen. */
  pinIds: string[];
  /** Index into `pinIds` of the next pin to process. */
  cursor: number;
  pins: Record<string, PinRecord>;
  /** Pin ids encountered more than once during discovery. */
  duplicateCount: number;
  /** Files queued or downloading, keyed by Chrome's download id. */
  files: Record<string, FileRecord>;
  /** Chrome download ids waiting for their turn. */

  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FileRecord {
  downloadId: string;
  pinId: string;
  filename: string;
  state: "in_progress" | "complete" | "interrupted";
}

/** Progress numbers the popup shows. */
export interface JobProgress {
  phase: JobPhase;
  boardKey: string;
  board: BoardInfo | null;
  discovered: number;
  downloaded: number;
  skipped: number;
  failed: number;
  duplicates: number;
  filesQueued: number;
  filesDone: number;
  /** Human readable line about what the job is doing right now. */
  detail: string;
  error?: string;
  updatedAt: number;
}
