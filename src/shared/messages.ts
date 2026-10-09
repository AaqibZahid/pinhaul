// What the popup asks and what the service worker answers.

import type { BoardRef } from "./types";

export type Request =
  | { type: "detectBoard" }
  | { type: "start"; ref: BoardRef; source: "tab" | "input" }
  | { type: "status" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "retry" }
  | { type: "cancel" }
  | { type: "openFolder" };

export type BoardDetection =
  | { board: BoardRef; source: "tab" }
  | { board: null; error?: string };
