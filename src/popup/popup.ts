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
const queueActions = byId<HTMLElement>("queue-actions");
const selectedCount = byId<HTMLElement>("selected-count");
const clearSelected = byId<HTMLButtonElement>("clear-selected");
const downloadSelected = byId<HTMLButtonElement>("download-selected");
const manualForm = byId<HTMLFormElement>("manual-form");
const boardInput = byId<HTMLInputElement>("board-input");
const downloads = byId<HTMLElement>("downloads");
const progressTemplate = byId<HTMLTemplateElement>("progress-template");

interface Reply<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
  kind?: PinterestErrorKind;
}

let boards: BoardSummary[] = [];
const selected = new Set<string>();
const progressByKey = new Map<string, DownloadProgress>();
const cards = new Map<string, HTMLElement>();
const pendingKeys = new Set<string>();
const stopping = new Set<string>();
let syncing = false;
let polling = false;
let startsInFlight = 0;

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function send<T>(request: Request): Promise<Reply<T>> {
  return chrome.runtime.sendMessage(request) as Promise<Reply<T>>;
}

function setMessage(text: string, error = false, showConnect = false): void {
  message.textContent = text;
  message.classList.toggle("hidden", !text);
  message.classList.toggle("error", error);
  connectButton.classList.toggle("hidden", !showConnect);
}

async function sync(): Promise<void> {
  if (syncing || hasRunning()) return;
  syncing = true;
  refreshButton.classList.add("spinning");
  setMessage("");
  const reply = await send<BoardSyncResult>({ type: "syncBoards" });
  syncing = false;
  refreshButton.classList.remove("spinning");
  if (!reply.ok) {
    accountLabel.textContent = reply.kind === "unauthorized" ? "Pinterest sign-in needed" : "Pinterest unavailable";
    renderBoards([]);
    setMessage(
      reply.kind === "unauthorized" ? "Sign in to Pinterest, then refresh." : "Pinterest is temporarily unavailable. Try again shortly.",
      true,
      reply.kind === "unauthorized",
    );
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
  const key = boardKey(board);
  card.dataset.key = key;
  card.classList.toggle("selected", selected.has(key));
  const pick = document.createElement("input");
  pick.className = "board-picker";
  pick.type = "checkbox";
  pick.checked = selected.has(key);
  pick.disabled = isRunning(key);
  pick.ariaLabel = `Select ${board.name}`;
  pick.addEventListener("change", () => {
    pick.checked ? selected.add(key) : selected.delete(key);
    card.classList.toggle("selected", pick.checked);
    renderQueueActions();
  });
  card.append(pick);
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
  button.disabled = isRunning(key);
  button.addEventListener("click", () => void start([board]));
  body.append(title, meta);
  card.append(body, button);
  return card;
}

function boardKey(board: BoardRef): string {
  return `${board.username}/${board.slug}`;
}

function renderQueueActions(): void {
  const count = selected.size;
  queueActions.classList.toggle("hidden", count === 0);
  selectedCount.textContent = `${count} board${count === 1 ? "" : "s"} selected`;
  downloadSelected.textContent = count === 1 ? "Download selected" : `Download ${count} boards`;
  downloadSelected.disabled = count === 0 || [...selected].every(isRunning);
  clearSelected.disabled = false;
}

function count(value: number | null, noun: string): string {
  if (value === null) return noun;
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

async function start(items: Array<BoardSummary | BoardRef>): Promise<void> {
  const fresh = items.filter((item) => !isRunning(boardKey(item)));
  if (fresh.length === 0) return;
  for (const item of fresh) {
    const key = boardKey(item);
    if (progressByKey.has(key)) {
      cards.get(key)?.remove();
      cards.delete(key);
      progressByKey.delete(key);
    }
    pendingKeys.add(key);
    const card = cardFor(key);
    card.classList.remove("hidden", "finished", "failed");
    card.querySelector<HTMLElement>(".phase")!.textContent = "Starting";
    card.querySelector<HTMLElement>(".progress-board")!.textContent = "name" in item ? item.name : item.slug;
    card.querySelector<HTMLElement>(".detail")!.textContent = "Preparing download";
    card.querySelector<HTMLElement>(".progress-stats")!.textContent = "0 pins · 0 files";
    card.querySelector<HTMLElement>(".bar-fill")!.style.width = "3%";
    card.querySelector<HTMLButtonElement>(".cancel")!.disabled = false;
  }
  selected.clear();
  renderBoards(boards);
  renderQueueActions();
  const refs = fresh.map(({ username, slug }) => ({ username, slug }));
  startsInFlight += 1;
  void send({ type: "downloadBoards", refs, saveAs: saveAs.checked }).then((reply) => {
    if (!reply.ok) setMessage(reply.error ?? "The download could not start.", true);
  }, () => setMessage("The download could not start.", true)).finally(() => {
    startsInFlight -= 1;
    for (const ref of refs) pendingKeys.delete(boardKey(ref));
    updateBoardAvailability();
    renderQueueActions();
  });
  void poll();
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    do {
      const reply = await send<DownloadProgress[]>({ type: "status" });
      if (reply.ok) showAll(reply.value ?? []);
      await new Promise((resolve) => setTimeout(resolve, 450));
    } while (hasRunning() || startsInFlight > 0);
  } finally {
    polling = false;
  }
}

function showAll(progresses: DownloadProgress[]): void {
  if (!Array.isArray(progresses)) {
    setMessage("Pinhaul was updated. Reload it in chrome://extensions and reopen the popup.", true);
    return;
  }
  const before = boards.map((board) => isRunning(boardKey(board))).join();
  for (const progress of progresses) {
    const board = progress.board;
    if (!board) continue;
    const key = boardKey(board);
    pendingKeys.delete(key);
    progressByKey.set(key, progress);
    if (progress.phase === "cancelled") {
      cards.get(key)?.remove();
      cards.delete(key);
    } else if (!stopping.has(key)) show(progress, cardFor(key));
  }
  if (before !== boards.map((board) => isRunning(boardKey(board))).join()) {
    updateBoardAvailability();
    renderQueueActions();
  }
}

function updateBoardAvailability(): void {
  for (const card of Array.from(boardList.querySelectorAll<HTMLElement>(".board-card"))) {
    const running = isRunning(card.dataset.key ?? "");
    card.querySelector<HTMLInputElement>(".board-picker")!.disabled = running;
    card.querySelector<HTMLButtonElement>(".download-button")!.disabled = running;
  }
}

function show(progress: DownloadProgress, card: HTMLElement): void {
  card.querySelector<HTMLElement>(".phase")!.textContent = labelFor(progress.phase);
  card.querySelector<HTMLElement>(".progress-board")!.textContent = progress.board?.name ?? "Board";
  card.querySelector<HTMLElement>(".detail")!.textContent = progress.error ?? progress.detail;
  const issues = [progress.skipped ? `${progress.skipped} skipped` : "", progress.failed ? `${progress.failed} failed` : ""].filter(Boolean);
  card.querySelector<HTMLElement>(".progress-stats")!.textContent = progress.phase === "done"
    ? `${progress.images} images · ${progress.videos} videos${issues.length ? ` · ${issues.join(" · ")}` : ""}`
    : `${progress.processed}/${progress.discovered} pins · ${progress.files} files${issues.length ? ` · ${issues.join(" · ")}` : ""}`;
  const fraction = progress.discovered ? progress.processed / progress.discovered : progress.phase === "packaging" || progress.phase === "saving" || progress.phase === "done" ? 1 : 0.05;
  card.querySelector<HTMLElement>(".bar-fill")!.style.width = `${Math.max(3, Math.min(100, fraction * 100))}%`;
  card.querySelector<HTMLButtonElement>(".cancel")!.disabled = !isRunning(boardKey(progress.board!));
  card.classList.toggle("finished", progress.phase === "done");
  card.classList.toggle("failed", progress.phase === "error");
}

function cardFor(key: string): HTMLElement {
  let card = cards.get(key);
  if (card) return card;
  card = progressTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
  card.querySelector<HTMLButtonElement>(".cancel")!.addEventListener("click", () => void stop(key));
  cards.set(key, card);
  downloads.prepend(card);
  return card;
}

function isRunning(key: string): boolean {
  const phase = progressByKey.get(key)?.phase;
  return pendingKeys.has(key) || (phase !== undefined && !["done", "cancelled", "error"].includes(phase));
}

function hasRunning(): boolean {
  return pendingKeys.size > 0 || [...progressByKey.keys()].some(isRunning);
}

function labelFor(phase: string): string {
  if (phase === "resolving") return "Reading board";
  if (phase === "idle") return "Waiting";
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

async function stop(key: string): Promise<void> {
  stopping.add(key);
  cards.get(key)?.classList.add("hidden");
  try {
    const reply = await send<DownloadProgress | null>({ type: "cancel", key });
    if (!reply.ok) throw new Error(reply.error ?? "Could not stop the download.");
    stopping.delete(key);
    if (reply.value?.phase === "done") cards.get(key)?.classList.remove("hidden");
    if (reply.value) showAll([reply.value]);
  } catch (error) {
    cards.get(key)?.classList.remove("hidden");
    setMessage(error instanceof Error ? error.message : "Could not stop the download.", true);
  } finally {
    stopping.delete(key);
  }
}
clearSelected.addEventListener("click", () => {
  selected.clear();
  renderBoards(boards);
  renderQueueActions();
});
downloadSelected.addEventListener("click", () => void start(boards.filter((board) => selected.has(boardKey(board)))));
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
  void start([parsed.ref]);
});

void initialize();
setInterval(() => void sync(), 30_000);

async function initialize(): Promise<void> {
  await sync();
  const reply = await send<DownloadProgress[]>({ type: "status" });
  if (reply.ok) showAll(reply.value ?? []);
  if (hasRunning()) await poll();
}
