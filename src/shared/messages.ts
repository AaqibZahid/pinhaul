// What the popup asks and what the service worker answers.

import type { BoardRef } from "./types";

export type Request =
  | { type: "syncBoards" }
  | { type: "downloadBoard"; ref: BoardRef; saveAs: boolean }
  | { type: "status" }
  | { type: "cancel" }
  | { type: "openPinterest" };
