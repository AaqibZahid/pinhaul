import type { BoardSummary } from "../shared/types";
import { nextBookmark } from "../shared/pins";
import { PinterestError, type PinterestGateway } from "./pinterest";

/** Lists the boards visible to the signed-in Pinterest web session. */
export async function listAccountBoards(client: PinterestGateway): Promise<BoardSummary[]> {
  const user = await currentUser(client);
  const username = text(user.username) ?? text(user.slug) ?? text(user.name);
  const boards: BoardSummary[] = [];
  let bookmark: string | null = null;

  for (let page = 0; page < 100; page++) {
    const options: Record<string, unknown> = {
      field_set_key: "profile_grid_item",
      filter_stories: false,
      sort: "last_pinned_to",
    };
    if (username) options.username = username;
    if (bookmark) options.bookmarks = [bookmark];

    const envelope = await client.getResource("BoardsFeedResource", options, username ? `/${username}/_saved/` : "/");
    for (const raw of boardItems(envelope)) {
      const board = boardOf(raw, username ?? "");
      if (board && !boards.some((candidate) => candidate.id === board.id)) boards.push(board);
    }
    const next = nextBookmark(envelope, bookmark);
    if (!next) break;
    bookmark = next;
  }

  return boards;
}

async function currentUser(client: PinterestGateway): Promise<Record<string, unknown>> {
  for (const options of [{ field_set_key: "detailed" }, { username: "me", field_set_key: "detailed" }]) {
    try {
      const value = await client.getData<unknown>("UserResource", options, "/");
      if (value && typeof value === "object") return value as Record<string, unknown>;
    } catch {
      // Pinterest has used both forms for this resource. Try the other shape.
    }
  }
  throw new PinterestError("unauthorized", "UserResource", "Sign in to Pinterest in this browser, then refresh.");
}

function boardItems(envelope: unknown): unknown[] {
  if (!envelope || typeof envelope !== "object") return [];
  const response = (envelope as Record<string, unknown>).resource_response;
  const data = response && typeof response === "object" ? (response as Record<string, unknown>).data : null;
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["boards", "items", "data"]) {
    const value = (data as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function boardOf(raw: unknown, fallbackUsername: string): BoardSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = text(record.id) ?? text(record.board_id);
  const name = text(record.name) ?? text(record.title);
  const username = text(record.username) ?? fallbackUsername;
  const slug = text(record.slug) ?? text(record.url)?.split("/").filter(Boolean).at(-1);
  if (!id || !name || !username || !slug) return null;

  const url = text(record.url) ?? `https://www.pinterest.com/${username}/${slug}/`;
  return {
    id,
    name,
    url: url.startsWith("/") ? `https://www.pinterest.com${url}` : url,
    username,
    slug,
    pinCount: number(record.pin_count ?? record.pinCount),
    sectionCount: number(record.section_count ?? record.sectionCount),
    thumbnailUrl: thumbnailOf(record),
  };
}

function thumbnailOf(record: Record<string, unknown>): string | undefined {
  for (const key of ["image_thumbnail_url", "image_url", "cover_image_url"]) {
    const value = text(record[key]);
    if (value) return value.startsWith("/") ? `https://www.pinterest.com${value}` : value;
  }
  const cover = record.cover_image ?? record.cover;
  if (cover && typeof cover === "object") {
    const value = text((cover as Record<string, unknown>).url);
    if (value) return value.startsWith("/") ? `https://www.pinterest.com${value}` : value;
  }
  return undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
