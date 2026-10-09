// Reading a board reference the way a person writes it.
//
// Three shapes are accepted: the current Pinterest tab's URL, a full board URL,
// and `username/boardname`. Everything else is refused with a reason, because a
// wrong board is worse than no board.

import type { BoardRef } from "./types";

const RESERVED = new Set([
  "pin",
  "idea",
  "ideas",
  "search",
  "explore",
  "today",
  "business",
  "settings",
  "hub",
  "following",
  "followers",
  "topics",
  "shop",
]);

export type BoardRefResult =
  | { ok: true; ref: BoardRef; canonicalUrl: string }
  | { ok: false; error: string };

/** Parses a board reference. Never throws. */
export function parseBoardRef(input: string): BoardRefResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "Enter a board." };

  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith("//");
  if (looksLikeUrl) return parseUrl(trimmed);

  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 1) {
    return { ok: false, error: `"${trimmed}" is not a board. Use username/boardname.` };
  }
  return build(segments[0], segments[1], trimmed);
}

function parseUrl(input: string): BoardRefResult {
  let url: URL;
  try {
    url = new URL(input.startsWith("//") ? `https:${input}` : input);
  } catch {
    return { ok: false, error: `"${input}" is not a valid URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http and https URLs are supported." };
  }
  // pinterest.com and its regional domains, with any subdomain.
  const host = url.hostname.toLowerCase();
  if (!/^([a-z0-9-]+\.)*pinterest\.[a-z.]+$/.test(host)) {
    return { ok: false, error: "That URL is not on Pinterest." };
  }
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return { ok: false, error: "That URL is not a board. Open a board first." };
  }
  if (RESERVED.has(segments[0].toLowerCase())) {
    return { ok: false, error: `"${segments[0]}" is not a username, so this is not a board.` };
  }
  return build(segments[0], segments[1], input);
}

function build(username: string, slug: string, original: string): BoardRefResult {
  const name = username.startsWith("@") ? username.slice(1) : username;
  const problem = validate(name, "username", original) ?? validate(slug, "board name", original);
  if (problem) return { ok: false, error: problem };
  if (RESERVED.has(name.toLowerCase())) {
    return { ok: false, error: `"${name}" is not a username, so this is not a board.` };
  }
  return { ok: true, ref: { username: name, slug }, canonicalUrl: boardUrl(name, slug) };
}

function validate(segment: string, what: string, original: string): string | null {
  if (segment.length === 0) return `Empty ${what} in "${original}".`;
  if (segment === "." || segment === "..") return `"${segment}" is not a valid ${what}.`;
  // A separator would let a board climb out of its download folder.
  if (segment.includes("/") || segment.includes("\\")) return `The ${what} contains a path separator.`;
  if (/\s/.test(segment)) return `The ${what} contains whitespace.`;
  if (/[#?%]/.test(segment)) return `The ${what} contains an illegal character.`;
  return null;
}

/** The canonical URL of a board. */
export function boardUrl(username: string, slug: string): string {
  return `https://www.pinterest.com/${username}/${slug}/`;
}

/** The key a board's work is stored under. */
export function boardKey(ref: BoardRef): string {
  return `${ref.username}/${ref.slug}`;
}
