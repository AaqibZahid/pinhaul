// Walking a board: its metadata, its sections, and every pin in each.
//
// The board feed alone does not hold a sectioned board's pins — a 4,133-pin
// board with 81 sections serves a feed of a few hundred and leaves the rest in
// the sections — so both are enumerated and merged by pin id. Every step is one
// page so the job can be checkpointed between them, and a page that comes back
// empty is retried because Pinterest serves a transient empty page now and then,
// which would otherwise truncate a board silently.

import type { BoardInfo, BoardRef, DiscoveryStream } from "../shared/types";
import { isPinItem, pinIdOf } from "../shared/pins";
import { PinterestError, type PinterestGateway } from "./pinterest";


export interface ResolvedBoard {
  info: BoardInfo;
  /** `true` when the board's own record said it has sections. */
  hasSections: boolean;
}

/** Reads the board Pinterest actually holds, including its real name. */
export async function resolveBoard(client: PinterestGateway, ref: BoardRef, sourceUrl: string): Promise<ResolvedBoard> {
  const data = (await client.getData<Record<string, unknown>>(
    "BoardResource",
    { slug: ref.slug, username: ref.username, field_set_key: "detailed" },
    sourceUrl,
  )) as Record<string, unknown>;

  const id = text(data.id);
  if (!id) {
    throw new PinterestError("invalid", "BoardResource", "Pinterest's board record carried no id");
  }
  const name = text(data.name) ?? ref.slug;
  const url = text(data.url);
  return {
    info: {
      id,
      name,
      url: url ? absolute(url) : boardUrl(ref.username, ref.slug),
      pinCount: number(data.pin_count),
      sectionCount: number(data.section_count),
    },
    hasSections: (number(data.section_count) ?? 0) > 0,
  };
}

export interface Section {
  id: string;
  name: string;
}

/** Every section of a board, by name and id. */
export async function loadSections(client: PinterestGateway, boardId: string): Promise<Section[]> {
  const sections: Section[] = [];
  let bookmark: string | null = null;
  for (let page = 0; page < 50; page++) {
    const options: Record<string, unknown> = { board_id: boardId, field_set_key: "detailed" };
    if (bookmark) options.bookmarks = [bookmark];
    const envelope = await client.getResource("BoardSectionsResource", options, "/");
    const items = itemsOf(envelope);
    if (items.length === 0) break;
    for (const raw of items) {
      const item = (raw ?? {}) as Record<string, unknown>;
      const id = text(item.id);
      if (!id) continue;
      sections.push({ id, name: text(item.name) ?? text(item.slug) ?? id });
    }
    const next = nextBookmarkOf(envelope, bookmark);
    if (!next) break;
    bookmark = next;
  }
  return sections;
}

/** The work of walking one board's pins, one page at a time. */
export class BoardCrawler {
  private readonly streams: DiscoveryStream[];
  private index = 0;

  constructor(
    private readonly client: PinterestGateway,
    private readonly boardId: string,
    streams: DiscoveryStream[],
  ) {
    this.streams = streams;
  }

  /** The initial work: the board feed plus a stream per section. */
  static start(boardId: string, sections: Section[]): DiscoveryStream[] {
    const streams: DiscoveryStream[] = [{ kind: "feed", id: boardId, bookmark: null }];
    for (const section of sections) {
      streams.push({ kind: "section", id: section.id, name: section.name, bookmark: null });
    }
    return streams;
  }

  /** How much discovery work is left. */
  get remaining(): number {
    return this.streams.filter((stream) => !stream.done).length;
  }

  /** Fetches the next page of pins. Returns null when the board is walked. */
  async nextPage(): Promise<PageResult | null> {
    const stream = this.streams.find((candidate) => !candidate.done);
    if (!stream) return null;

    const options: Record<string, unknown> =
      stream.kind === "feed"
        ? { board_id: this.boardId, field_set_key: "react_grid_pin", prepend: false }
        : { section_id: stream.id, field_set_key: "react_grid_pin" };
    if (stream.bookmark) options.bookmarks = [stream.bookmark];

    const resource = stream.kind === "feed" ? "BoardFeedResource" : "BoardSectionPinsResource";
    let page: Page | null;
    try {
      page = await this.fetchPage(resource, options);
    } catch (error) {
      // One stream failing must not lose the board: it is marked walked and the
      // reason is reported with the rest of the job.
      stream.done = true;
      return { pinIds: [], duplicates: 0, error: messageOf(error), stream: stream.kind };
    }

    let items = page?.items ?? [];
    let bookmark = page?.bookmark ?? null;
    if (items.length === 0) {
      // A page that comes back empty is retried on the same cursor, because
      // Pinterest serves one now and then in the middle of a board.
      const retried = await this.retryPage(resource, options);
      if (retried === null) {
        stream.done = true;
        return { pinIds: [], duplicates: 0, stream: stream.kind };
      }
      items = retried.items;
      bookmark = retried.bookmark;
    }

    stream.bookmark = bookmark;
    if (!bookmark) stream.done = true;

    return {
      pinIds: pinIdsOf(items),
      duplicates: 0,
      stream: stream.kind,
      sectionName: stream.name,
      pagesLeft: this.remaining,
    };
  }

  /** One page of a stream, or a refused page. */
  private async fetchPage(resource: string, options: Record<string, unknown>): Promise<Page> {
    const envelope = await this.client.getResource(resource, options, "/");
    return { items: itemsOf(envelope), bookmark: nextBookmarkOf(envelope, null) };
  }

  /** Asks for a page that came back empty again, on the same cursor. Returns
   * null when it stays empty, which ends that stream. */
  private async retryPage(resource: string, options: Record<string, unknown>): Promise<Page | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await this.fetchPage(resource, options);
      if (page.items.length > 0) return page;
      if (!page.bookmark) return null;
    }
    return null;
  }
}

interface Page {
  items: unknown[];
  bookmark: string | null;
}

export interface PageResult {
  pinIds: string[];
  duplicates: number;
  stream: "feed" | "section";
  sectionName?: string;
  pagesLeft?: number;
  error?: string;
}

/** The pin ids a page holds, ignoring the module the feed ends with. */
export function pinIdsOf(items: unknown[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (!isPinItem(item)) continue;
    const id = pinIdOf(item);
    if (id) ids.push(id);
  }
  return ids;
}

function itemsOf(envelope: unknown): unknown[] {
  if (!envelope || typeof envelope !== "object") return [];
  const response = (envelope as Record<string, unknown>).resource_response;
  if (!response || typeof response !== "object") return [];
  const data = (response as Record<string, unknown>).data;
  return Array.isArray(data) ? data : [];
}

function nextBookmarkOf(envelope: unknown, previous: string | null): string | null {
  if (!envelope || typeof envelope !== "object") return null;
  const response = (envelope as Record<string, unknown>).resource_response;
  if (!response || typeof response !== "object") return null;
  const raw = (response as Record<string, unknown>).bookmark;
  const cursor = cursorOf(raw);
  if (cursor === null) return null;
  if (cursor.length === 0 || cursor === "-end-" || cursor.startsWith("Y2JOb25lO")) return null;
  if (cursor === previous) return null;
  return cursor;
}

function cursorOf(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((value) => typeof value === "string");
    return typeof first === "string" ? first : null;
  }
  return null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function absolute(url: string): string {
  return url.startsWith("/") ? `https://www.pinterest.com${url}` : url;
}

function boardUrl(username: string, slug: string): string {
  return `https://www.pinterest.com/${username}/${slug}/`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

