// Turning a board and a pin into file names.
//
// Chrome writes every file inside Downloads/Pinhaul/<board>/, so a board name
// that is empty, absurdly long, or made of illegal characters has to become
// something a filesystem accepts. Pin ids are the file stem, so two pins never
// collide and a repeated run writes the same names.

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A folder-safe board name, falling back to the board's slug. */
export function boardFolderName(name: string, slug: string): string {
  const cleaned = clean(name) ?? clean(slug) ?? "board";
  return clipped(cleaned, 60);
}

/** The stem a pin's single file writes to, and the qualified stems it needs
 * when it carries several. */
export function fileStems(pinId: string, labels: string[]): string[] {
  if (labels.length === 0) return [];
  if (labels.length === 1) return [pinId];
  return labels.map((label) => `${pinId}_${label}`);
}

/** The extension a URL's path ends in, or a fallback for one that has none. */
export function extensionOf(url: string, fallback: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return fallback;
  }
  const match = /\.([a-z0-9]{2,5})$/i.exec(path);
  if (!match) return fallback;
  const ext = match[1];
  if (!ext) return fallback;
  return ALLOWED.has(ext.toLowerCase()) ? `.${ext.toLowerCase()}` : fallback;
}

const ALLOWED = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "bmp",
  "tif",
  "tiff",
  "svg",
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
  "ts",
]);

function clean(value: string): string | null {
  const trimmed = value.trim().replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return null;
  if (WINDOWS_RESERVED.test(trimmed)) return `_${trimmed}`;
  return trimmed.replace(/^\.+/, "");
}

function clipped(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max).trim() || "board";
}
