import { parseBoardRef } from "../shared/boardref";
import type { Request } from "../shared/messages";
import type { BoardRef, BoardSummary, BoardSyncResult, DownloadProgress } from "../shared/types";
import type { PinterestErrorKind } from "../background/pinterest";

const refreshButton = byId<HTMLButtonElement>("refresh");
const connectButton = byId<HTMLButtonElement>("connect");
const accountLabel = byId<HTMLElement>("account");
const boardList = byId<HTMLElement>("board-list");
const empty = byId<HTMLElement>("empty");
const message = byId<HTMLParagraphElement>("message");
const saveAs = byId<HTMLInputElement>("save-as");
const manualForm = byId<HTMLFormElement>("manual-form");
const boardInput = byId<HTMLInputElement>("board-input");
const progressPanel = byId<HTMLElement>("progress");
const phaseLabel = byId<HTMLElement>("phase");
const detailLabel = byId<HTMLElement>("detail");
const statsLabel = byId<HTMLElement>("stats");
const barFill = byId<HTMLElement>("bar-fill");
const cancelButton = byId<HTMLButtonElement>("cancel");

interface Reply<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
  kind?: PinterestErrorKind;
}

let boards: BoardSummary[] = [];
let syncing = false;
let active = false;

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function send<T>(request: Request): Promise<Reply<T>> {
  return chrome.runtime.sendMessage(request) as Promise<Reply<T>>;
}

function setMessage(text: string, error = false): void {
  message.textContent = text;
  message.classList.toggle("hidden", !text);
  message.classList.toggle("error", error);
  connectButton.classList.toggle("hidden", !error);
}

async function sync(): Promise<void> {
  if (syncing || active) return;
  syncing = true;
  refreshButton.classList.add("spinning");
  setMessage("");
  const reply = await send<BoardSyncResult>({ type: "syncBoards" });
  syncing = false;
  refreshButton.classList.remove("spinning");
  if (!reply.ok) {
    accountLabel.textContent = reply.kind === "unauthorized" ? "Pinterest sign-in needed" : "Pinterest unavailable";
    renderBoards([]);
    setMessage(reply.kind === "unauthorized" ? "Sign in to Pinterest, then refresh." : "Pinterest is temporarily unavailable. Try again shortly.", true);
    return;
  }
  boards = reply.value?.boards ?? [];
  accountLabel.textContent = boards.length ? `${boards.length} board${boards.length === 1 ? "" : "s"}` : "Your boards";
  setMessage(reply.value?.stale ? "Showing cached boards while Pinterest is unavailable." : "");
  renderBoards(boards);
}

function renderBoards(items: BoardSummary[]): void {
  boardList.replaceChildren();
  empty.classList.toggle("hidden", items.length !== 0);
  for (const board of items) boardList.append(createBoardCard(board));
}

function createBoardCard(board: BoardSummary): HTMLElement {
  const card = document.createElement("article");
  card.className = "board-card";
  if (board.thumbnailUrl) {
    const image = document.createElement("img");
    image.src = board.thumbnailUrl;
    image.alt = "";
    image.loading = "lazy";
    card.append(image);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "thumb-placeholder";
    placeholder.textContent = "✦";
    card.append(placeholder);
  }

  const body = document.createElement("div");
  body.className = "board-body";
  const title = document.createElement("strong");
  title.textContent = board.name;
  const meta = document.createElement("span");
  meta.textContent = `${count(board.pinCount, "pin")} · ${count(board.sectionCount, "section")}`;
  const button = document.createElement("button");
  button.className = "download-button";
  button.type = "button";
  button.textContent = "ZIP";
  button.title = `Download ${board.name}`;
  button.disabled = active;
  button.addEventListener("click", () => void start(board));
  body.append(title, meta);
  card.append(body, button);
  return card;
}

function count(value: number | null, noun: string): string {
  if (value === null) return noun;
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

async function start(board: BoardSummary | BoardRef): Promise<void> {
  if (active) return;
  active = true;
  renderBoards(boards);
  progressPanel.classList.remove("hidden");
  void send<DownloadProgress>({ type: "downloadBoard", ref: { username: board.username, slug: board.slug }, saveAs: saveAs.checked }).then((reply) => {
    if (reply.ok) return;
    active = false;
    progressPanel.classList.add("hidden");
    setMessage(reply.error ?? "The download could not start.", true);
    renderBoards(boards);
  });
  await poll();
}

async function poll(): Promise<void> {
  while (active) {
    const reply = await send<DownloadProgress | null>({ type: "status" });
    show(reply.value ?? null);
    const phase = reply.value?.phase;
    if (phase === "done" || phase === "cancelled" || phase === "error") {
      active = false;
      renderBoards(boards);
      if (phase === "error") setMessage(reply.value?.error ?? "The download failed.", true);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
}

function show(progress: DownloadProgress | null): void {
  if (!progress) return;
  phaseLabel.textContent = labelFor(progress.phase);
  detailLabel.textContent = progress.detail;
  statsLabel.textContent = `${progress.processed}/${progress.discovered} pins · ${progress.files} files`;
  const fraction = progress.discovered ? progress.processed / progress.discovered : progress.phase === "packaging" || progress.phase === "saving" || progress.phase === "done" ? 1 : 0.05;
  barFill.style.width = `${Math.max(3, Math.min(100, fraction * 100))}%`;
  cancelButton.disabled = ["done", "cancelled", "error"].includes(progress.phase);
  progressPanel.classList.toggle("finished", progress.phase === "done");
}

function labelFor(phase: string): string {
  if (phase === "resolving") return "Reading board";
  if (phase === "discovering") return "Finding pins";
  if (phase === "downloading") return "Downloading";
  if (phase === "packaging") return "Building ZIP";
  if (phase === "saving") return "Saving ZIP";
  if (phase === "cancelled") return "Stopped";
  if (phase === "done") return "Complete";
  if (phase === "error") return "Could not finish";
  return "Starting";
}

refreshButton.addEventListener("click", () => void sync());
connectButton.addEventListener("click", () => void send({ type: "openPinterest" }));
cancelButton.addEventListener("click", () => void send({ type: "cancel" }));
saveAs.checked = localStorage.getItem("pinpull.saveAs") === "true";
saveAs.addEventListener("change", () => localStorage.setItem("pinpull.saveAs", String(saveAs.checked)));
manualForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const parsed = parseBoardRef(boardInput.value);
  if (!parsed.ok) {
    setMessage(parsed.error, true);
    return;
  }
  setMessage("");
  void start(parsed.ref);
});

void sync();
setInterval(() => void sync(), 30_000);
