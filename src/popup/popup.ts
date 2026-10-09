// The popup: a window onto the job, not the owner of it.
//
// It reads the job from the service worker once a second, so closing and
// reopening the popup changes nothing about a download in progress.

import { parseBoardRef } from "../shared/boardref";
import type { JobProgress } from "../shared/types";
import type { Request } from "../shared/messages";

const form = document.getElementById("board-form") as HTMLFormElement;
const input = document.getElementById("board-input") as HTMLInputElement;
const downloadButton = document.getElementById("download") as HTMLButtonElement;
const boardLabel = document.getElementById("board") as HTMLParagraphElement;
const progressPanel = document.getElementById("progress") as HTMLElement;
const phaseLabel = document.getElementById("phase") as HTMLSpanElement;
const detailLabel = document.getElementById("detail") as HTMLSpanElement;
const barFill = document.getElementById("bar-fill") as HTMLDivElement;
const found = document.getElementById("found") as HTMLElement;
const downloaded = document.getElementById("downloaded") as HTMLElement;
const skipped = document.getElementById("skipped") as HTMLElement;
const failed = document.getElementById("failed") as HTMLElement;
const message = document.getElementById("message") as HTMLParagraphElement;
const actionsRow = document.getElementById("actions") as HTMLElement;
const pauseButton = document.getElementById("pause") as HTMLButtonElement;
const retryButton = document.getElementById("retry") as HTMLButtonElement;
const folderButton = document.getElementById("folder") as HTMLButtonElement;

interface BoardRef {
  username: string;
  slug: string;
}

interface Reply {
  ok: boolean;
  value?: JobProgress | null;
  error?: string;
  board?: BoardRef | null;
}

let detected: BoardRef | null = null;
let paused = false;

function send(request: Request): Promise<Reply> {
  return chrome.runtime.sendMessage(request) as Promise<Reply>;
}

function setMessage(text: string, isError = false): void {
  message.textContent = text;
  message.classList.toggle("error", isError);
  message.classList.toggle("hidden", text.length === 0);
}

/** Reads the board the user is looking at. */
async function detectBoard(): Promise<void> {
  const reply = await send({ type: "detectBoard" });
  detected = reply.board ?? null;
  if (detected) {
    boardLabel.textContent = `${detected.username}/${detected.slug}`;
    input.value = `${detected.username}/${detected.slug}`;
    return;
  }
  boardLabel.textContent = "No board on this tab";
}

function boardToUse(): BoardRef | null {
  const typed = input.value.trim();
  if (typed) {
    const parsed = parseBoardRef(typed);
    if (!parsed.ok) {
      setMessage(parsed.error, true);
      return null;
    }
    return parsed.ref;
  }
  if (detected) return detected;
  setMessage("Open a Pinterest board, or paste a board link.", true);
  return null;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void startDownload();
});

async function startDownload(): Promise<void> {
  const board = boardToUse();
  if (!board) return;
  setMessage("");
  downloadButton.disabled = true;
  const same = detected && board.username === detected.username && board.slug === detected.slug;
  const reply = await send({ type: "start", ref: board, source: same ? "tab" : "input" });
  if (reply.ok === false) {
    setMessage(reply.error ?? "The download could not start.", true);
    downloadButton.disabled = false;
    return;
  }
  await refresh();
}

pauseButton.addEventListener("click", () => {
  paused = !paused;
  void send(paused ? { type: "pause" } : { type: "resume" }).then(() => refresh());
});

retryButton.addEventListener("click", () => {
  void send({ type: "retry" }).then(() => refresh());
});

folderButton.addEventListener("click", () => {
  void send({ type: "openFolder" });
});

/** Mirrors the job onto the screen. */
function show(progress: JobProgress | null): void {
  const running = progress !== null && !["done", "error", "paused"].includes(progress.phase);
  const pausedNow = progress?.phase === "paused";

  downloadButton.disabled = running;
  downloadButton.textContent = running ? "Downloading…" : pausedNow ? "Resume" : "Download board";
  downloadButton.classList.toggle("primary", !running);
  progressPanel.classList.toggle("hidden", progress === null);
  actionsRow.classList.toggle("hidden", progress === null || progress.phase === "done");

  if (!progress) {
    setMessage("");
    return;
  }

  phaseLabel.textContent = pausedNow ? "Paused" : labelFor(progress.phase);
  const boardName = progress.board ? progress.board.name : progress.boardKey;
  detailLabel.textContent = `${boardName} · ${progress.detail}`;
  const total = progress.discovered;
  const done = progress.downloaded + progress.skipped + progress.failed;
  const fraction = total > 0 ? Math.min(1, done / total) : 0;
  barFill.style.width = `${(fraction * 100).toFixed(1)}%`;
  found.textContent = String(progress.discovered);
  downloaded.textContent = String(progress.downloaded);
  skipped.textContent = String(progress.skipped);
  failed.textContent = String(progress.failed);
  pauseButton.textContent = pausedNow ? "Resume" : "Pause";
  retryButton.disabled = progress.failed === 0;

  if (progress.phase === "error") {
    setMessage(progress.error ?? "The job stopped.", true);
    return;
  }
  if (progress.phase === "done") {
    const files = progress.filesDone > 0 ? ` and ${progress.filesDone} files` : "";
    setMessage(
      `Finished: ${progress.downloaded} downloaded, ${progress.skipped} skipped, ${progress.failed} failed${files}.`,
    );
    return;
  }
  setMessage("");
}

function labelFor(phase: string): string {
  if (phase === "resolving") return "Finding the board";
  if (phase === "discovering") return "Collecting pins";
  if (phase === "downloading") return "Downloading";
  return phase;
}

async function refresh(): Promise<void> {
  const reply = await send({ type: "status" });
  show(reply.value ?? null);
}

void detectBoard().then(() => refresh());
setInterval(() => void refresh(), 1000);
