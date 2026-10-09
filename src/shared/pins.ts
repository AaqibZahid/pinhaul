// Reading a pin out of Pinterest's records.
//
// The two sources disagree on spelling: the board feed and the pin resource
// report snake_case, and the relay payload embedded in a pin page reports
// camelCase. Both show up in practice, so everything here matches on the raw
// JSON rather than on one struct.

import type { Eligibility, MediaItem, MediaKind } from "./types";

/** Which pin a record is about, whichever way it names itself.
 *
 * `node_id` decodes to "Pin:<id>"; a plain numeric `id` already names the pin. */
export function pinIdOf(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const nodeId = record.node_id;
  if (typeof nodeId === "string" && nodeId.length > 0) {
    const decoded = decodeBase64(nodeId);
    if (decoded?.startsWith("Pin:")) {
      const id = decoded.slice(4);
      if (id.length > 0) return id;
    }
  }
  const id = record.id;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number") return String(id);
  return null;
}

/** Whether a board feed item is a pin rather than a module the feed ends with.
 *
 * Pinterest closes a feed with modules such as "Related Interests", whose items
 * carry a fresh random id every request and hold no pin data. Counting one as a
 * pin would invent a pin the board does not have. */
export function isPinItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const record = item as Record<string, unknown>;
  if (typeof record.node_id === "string" && record.node_id.length > 0) {
    const decoded = decodeBase64(record.node_id);
    return decoded?.startsWith("Pin:") ?? false;
  }
  if (record.story_type !== undefined) return false;
  if (record.id === undefined || record.id === null) return false;
  if (record.type === "pin") return true;
  for (const key of ["images", "aggregated_pin_data", "pinner", "videos"]) {
    if (record[key] !== undefined && record[key] !== null) return true;
  }
  return false;
}

/** Whether Pinterest lets the current user download this pin.
 *
 * `true` downloads, `false` is skipped with a reason, and anything else is
 * reported as unverified rather than being silently treated either way. */
export function eligibilityOf(item: unknown): Eligibility {
  if (!item || typeof item !== "object") return "unknown";
  const record = item as Record<string, unknown>;
  for (const key of ["is_eligible_for_image_download", "isEligibleForImageDownload"]) {
    const value = record[key];
    if (value === true) return "eligible";
    if (value === false) return "ineligible";
  }
  return "unknown";
}

/** The files a pin contributes, in the order they are written. Ineligible pins
 * never reach this; the caller gates them. */
export function mediaItemsOf(pin: unknown): MediaItem[] {
  if (!pin || typeof pin !== "object") return [];
  const record = pin as Record<string, unknown>;
  const videos = selectVideos(record);
  if (videos.length > 0) return videos;
  return selectImages(record);
}

interface Candidate {
  label: string;
  url: string;
  kind: MediaKind;
  width: number;
  height: number;
  durationMs: number;
}

function toCandidate(kind: MediaKind, label: string, url: string, source: Record<string, unknown>): Candidate {
  return {
    label,
    url: absolute(url),
    kind,
    width: numberOf(source.width),
    height: numberOf(source.height),
    durationMs: numberOf(source.duration),
  };
}

/** A frame's size in pixels. A variant key such as `736x` names only a width, so
 * the width stands in for the area when the height is not reported. */
function sizeOf(candidate: Candidate): number {
  if (candidate.width > 0 && candidate.height > 0) return candidate.width * candidate.height;
  return Math.max(candidate.width, candidate.height);
}

/** A larger frame wins; at equal size a ready-made file beats an HLS playlist. */
function beats(candidate: Candidate, other: Candidate): boolean {
  return compare(
    [sizeOf(candidate), candidate.kind === "video" ? 1 : 0, candidate.durationMs],
    [sizeOf(other), other.kind === "video" ? 1 : 0, other.durationMs],
  ) > 0;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function classify(url: string): MediaKind {
  const withoutQuery = (url.split("#")[0] ?? url).split("?")[0] ?? url;
  if (withoutQuery.endsWith(".m3u8") || withoutQuery.includes("/hls/")) return "hls";
  return "video";
}

function selectVideos(record: Record<string, unknown>): MediaItem[] {
  const candidates: Candidate[] = [];
  for (const source of videoSources(record)) {
    collectVideoUrls(source, 3, candidates);
  }
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (!best || beats(candidate, best)) best = candidate;
  }
  return best ? [toItem(best)] : [];
}

function videoSources(record: Record<string, unknown>): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [];
  if (record.videos && typeof record.videos === "object") sources.push(record.videos as Record<string, unknown>);
  for (const page of storyPages(record)) {
    const blocks = asArray(page.blocks);
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const blockRecord = block as Record<string, unknown>;
      for (const key of ["videoDataV2", "video"]) {
        const value = blockRecord[key];
        if (value && typeof value === "object") sources.push(value as Record<string, unknown>);
      }
    }
  }
  return sources;
}

/** Walks a variant map down to the leaves that carry a URL. Pinterest reports
 * partial variants (a duration or a `__typename` only) that must not be taken
 * for a rendition. */
function collectVideoUrls(value: unknown, depth: number, out: Candidate[]): void {
  if (depth === 0 || !value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const url = stringOf(record.url);
  if (url) {
    out.push(toCandidate(classify(url), "video", url, record));
    return;
  }
  for (const nested of Object.values(record)) {
    collectVideoUrls(nested, depth - 1, out);
  }
}

function selectImages(record: Record<string, unknown>): MediaItem[] {
  const slots = carouselSlots(record);
  if (slots.length > 0) {
    const items: MediaItem[] = [];
    slots.forEach((slot, index) => {
      if (!slot || typeof slot !== "object") return;
      const best = bestImage(slot as Record<string, unknown>, String(index + 1));
      if (best) items.push(toItem(best));
    });
    return items;
  }

  const pages = storyPages(record);
  if (pages.length > 0) {
    const items: MediaItem[] = [];
    pages.forEach((page, index) => {
      if (pageHasVideo(page)) return;
      const best = bestImage(page, String(index + 1));
      if (best) items.push(toItem(best));
    });
    return items;
  }

  const best = bestImage(record, "image");
  return best ? [toItem(best)] : [];
}

function toItem(candidate: Candidate): MediaItem {
  return { label: candidate.label, url: candidate.url, kind: candidate.kind };
}

/** The largest rendition a source offers, preferring the untouched original
 * whenever Pinterest published one. */
function bestImage(container: Record<string, unknown>, label: string): Candidate | null {
  const variants = imageVariants(container);
  if (variants.length === 0) return null;
  for (const variant of variants) {
    for (const key of ["orig", "originals"]) {
      const original = variant[key];
      if (original && typeof original === "object") {
        const originalRecord = original as Record<string, unknown>;
        const url = stringOf(originalRecord.url);
        if (url) return toCandidate("image", label, url, originalRecord);
      }
    }
  }
  const candidates: Candidate[] = [];
  for (const variant of variants) {
    candidates.push(...imageCandidates(variant, label));
  }
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (!best || beats(candidate, best)) best = candidate;
  }
  return best;
}

/** Where a container keeps image variants: page level, or one per story block.
 *
 * A story page reports its originals at page level, but a page that holds only
 * one image puts it on the block itself, named for its own size. */
function imageVariants(container: Record<string, unknown>): Record<string, unknown>[] {
  const variants: Record<string, unknown>[] = [];
  for (const key of ["images_originals", "imageAdjustedSpec_orig", "images_orig", "images"]) {
    const value = container[key];
    if (value && typeof value === "object") variants.push(value as Record<string, unknown>);
  }
  for (const block of asArray(container.blocks)) {
    if (!block || typeof block !== "object") continue;
    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      if (isImageField(key) && value && typeof value === "object" && value !== null && (value as Record<string, unknown>).url !== undefined) {
        variants.push(value as Record<string, unknown>);
      }
    }
  }
  return variants;
}

function isImageField(key: string): boolean {
  return (
    (key.startsWith("images_") || key.startsWith("imageAdjustedSpec_")) &&
    key !== "images_60x60" &&
    key !== "images_136x136"
  );
}

/** Every rendition inside a variant map, read either as the REST shape
 * (`{"orig": {url, width, height}}`) or the relay shape (`{url, width, ...}`). */
function imageCandidates(variants: Record<string, unknown>, label: string): Candidate[] {
  const url = stringOf(variants.url);
  if (url) return [toCandidate("image", label, url, variants)];
  const candidates: Candidate[] = [];
  for (const [key, value] of Object.entries(variants)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const nested = stringOf(record.url);
    if (!nested) continue;
    // A variant map is keyed by its size ("736x", "orig"), which says how big the
    // rendition is even when the record carries no dimensions.
    const candidate = toCandidate("image", label, nested, record);
    if (candidate.width === 0 && candidate.height === 0) {
      const size = dimensionsFromKey(key);
      candidate.width = size.width;
      candidate.height = size.height;
    }
    candidates.push(candidate);
  }
  return candidates;
}

const SIZE_KEY = /^(\d+)x(\d*)$/;

/** The width and height a variant key like `736x` names. */
function dimensionsFromKey(key: string): { width: number; height: number } {
  const match = SIZE_KEY.exec(key);
  if (!match) return { width: 0, height: 0 };
  return { width: Number(match[1] ?? 0), height: Number(match[2] ?? 0) };
}

function carouselSlots(record: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ["carousel_data", "carouselData"]) {
    const carousel = record[key];
    if (!carousel || typeof carousel !== "object") continue;
    for (const nested of ["carousel_slots", "carouselSlots"]) {
      const slots = (carousel as Record<string, unknown>)[nested];
      if (Array.isArray(slots)) return slots as Record<string, unknown>[];
    }
    if (Array.isArray(carousel)) return carousel as Record<string, unknown>[];
  }
  return [];
}

function storyPages(record: Record<string, unknown>): Record<string, unknown>[] {
  const pages: Record<string, unknown>[] = [];
  for (const key of ["story_pin_data", "storyPinData"]) {
    const story = record[key];
    if (!story || typeof story !== "object") continue;
    const list = (story as Record<string, unknown>).pages;
    if (Array.isArray(list)) pages.push(...(list as Record<string, unknown>[]));
  }
  return pages;
}

function pageHasVideo(page: Record<string, unknown>): boolean {
  const found: Candidate[] = [];
  for (const block of asArray(page.blocks)) {
    if (!block || typeof block !== "object") continue;
    const blockRecord = block as Record<string, unknown>;
    for (const key of ["videoDataV2", "video"]) {
      const value = blockRecord[key];
      if (value && typeof value === "object") collectVideoUrls(value, 3, found);
    }
  }
  return found.length > 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function absolute(url: string): string {
  if (url.startsWith("/")) return `https://www.pinterest.com${url}`;
  return url;
}

/** Reads the `Pin:` id out of a base64 node id, or null when it is not one. */
function decodeBase64(value: string): string | null {
  if (typeof atob !== "function") return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** The pagination cursor a resource response carries, or null when the feed has
 * reached its end. */
export function nextBookmark(document: unknown, previous: string | null): string | null {
  if (!document || typeof document !== "object") return null;
  const paths = [
    (document as Record<string, unknown>).resource_response,
    ((document as Record<string, unknown>).resource as Record<string, unknown> | undefined)?.options,
  ];
  for (const container of paths) {
    if (!container || typeof container !== "object") continue;
    const raw = (container as Record<string, unknown>).bookmark;
    const cursor = bookmarksOf(raw);
    if (cursor === null) continue;
    if (cursor.length === 0 || cursor === "-end-" || cursor.startsWith("Y2JOb25lO")) return null;
    if (cursor === previous) return null;
    return cursor;
  }
  return null;
}

function bookmarksOf(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((value) => typeof value === "string");
    return typeof first === "string" ? first : null;
  }
  return null;
}
