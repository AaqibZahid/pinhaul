// Reading an HLS playlist.
//
// A master playlist lists the renditions a video is offered in; a media playlist
// lists the segments one rendition is made of. Pinterest serves both shapes, and
// a media playlist addresses its segments either one URL each or by byte range
// inside a shared file, so both have to be read exactly.

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  codecs: string;
  resolution: string;
}

export interface HlsSegment {
  /** The segment's URL, or null when the playlist gives only a byte range. */
  uri: string | null;
  /** Where to read this segment inside its file, when the playlist says so. */
  bytes: { offset: number; length: number } | null;
  durationSeconds: number;
}

export interface HlsMap {
  uri: string | null;
  bytes: { offset: number; length: number } | null;
}

export interface MediaPlaylist {
  segments: HlsSegment[];
  /** The initialization segment a fragmented-MP4 rendition needs first. */
  map: HlsMap | null;
  /** How an encrypted rendition is keyed, when it is encrypted. */
  key: HlsKey | null;
  /** The number the first segment is, which an implicit IV is derived from. */
  mediaSequence: number;
  /** Whether the playlist says the stream has ended. */
  ended: boolean;
}

export interface HlsKey {
  method: string;
  uri: string;
  /** The 16 byte IV, from the playlist or from the media sequence number. */
  iv: Uint8Array | null;
}

/** The renditions a master playlist offers, best first. */
export function parseMasterPlaylist(text: string): HlsVariant[] {
  const lines = text.split("\n").map((line) => line.trim());
  const variants: HlsVariant[] = [];
  let attributes: Record<string, string> | null = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      attributes = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      continue;
    }
    if (attributes && line.length > 0 && !line.startsWith("#")) {
      variants.push({
        uri: line,
        bandwidth: Number(attributes.BANDWIDTH ?? 0),
        codecs: attributes.CODECS ?? "",
        resolution: attributes.RESOLUTION ?? "",
      });
      attributes = null;
    }
  }

  return variants;
}

/** The best rendition a master playlist offers: the highest bandwidth. */
export function pickVariant(text: string): HlsVariant | null {
  const variants = parseMasterPlaylist(text);
  if (variants.length === 0) return null;
  return variants.reduce((best, variant) => (variant.bandwidth > best.bandwidth ? variant : best));
}

/** The segments a media playlist is made of. */
export function parseMediaPlaylist(text: string): MediaPlaylist {
  const lines = text.split("\n").map((line) => line.trim());
  const segments: HlsSegment[] = [];
  let map: HlsMap | null = null;
  let key: HlsKey | null = null;
  let ended = false;
  let mediaSequence = 0;
  let pending: { duration: number; bytes: { offset: number; length: number } | null } | null = null;

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      pending = { duration: Number(line.slice("#EXTINF:".length).split(",")[0]) || 0, bytes: null };
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length)) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      // The length comes first and the offset is optional: "51501@51370".
      const raw = line.slice("#EXT-X-BYTERANGE:".length);
      const [length, offset] = raw.split("@");
      if (pending && length !== undefined) {
        pending.bytes = { offset: offset === undefined ? 0 : Number(offset), length: Number(length) };
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-MAP:".length));
      map = {
        uri: attributes.URI ?? null,
        bytes: byteRange(attributes.BYTERANGE),
      };
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-KEY:".length));
      const method = attributes.METHOD ?? "NONE";
      key = {
        method,
        uri: attributes.URI ?? "",
        iv: ivFromHex(attributes.IV),
      };
      continue;
    }
    if (line.startsWith("#EXT-X-ENDLIST")) {
      ended = true;
      continue;
    }
    if (line.length === 0 || line.startsWith("#")) continue;

    if (pending) {
      segments.push({ uri: line, bytes: pending.bytes, durationSeconds: pending.duration });
      pending = null;
    }
  }

  return { segments, map, key, mediaSequence, ended };
}

/** The 16 byte IV an `IV=0x...` attribute names. */
export function ivFromHex(raw: string | undefined): Uint8Array | null {
  if (!raw) return null;
  const hex = raw.toLowerCase().startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    iv[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2) || "00", 16);
  }
  return iv;
}

/** The IV a key uses: the playlist's own, or the media sequence number the HLS
 * specification says a playlist implies when it does not name one. */
export function ivFor(playlist: { mediaSequence: number; key: HlsKey | null }): Uint8Array | null {
  if (!playlist.key) return null;
  if (playlist.key.iv) return playlist.key.iv;
  const iv = new Uint8Array(16);
  let remaining = playlist.mediaSequence;
  for (let i = 15; i >= 0 && remaining > 0; i--) {
    iv[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return iv;
}

/** Whether a playlist is a master playlist rather than a media playlist. */
export function isMasterPlaylist(text: string): boolean {
  return /#EXT-X-STREAM-INF:/m.test(text);
}

/** Resolves a possibly relative URI against a playlist URL. */
export function resolveUri(playlistUrl: string, uri: string): string {
  if (/^https?:/i.test(uri)) return uri;
  return new URL(uri, playlistUrl).href;
}

function byteRange(raw: string | undefined): { offset: number; length: number } | null {
  if (!raw) return null;
  const [length, offset] = raw.split("@");
  if (length === undefined || length === "") return null;
  return { offset: offset === undefined ? 0 : Number(offset), length: Number(length) };
}

/** Parses `NAME=value` attributes, where a value may be quoted and may itself
 * contain commas, as a CODECS list does. */
function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let name = "";
  let value = "";
  let quoted = false;
  let inName = true;

  const store = () => {
    if (name) attributes[name] = value;
    name = "";
    value = "";
    inName = true;
  };

  for (const character of raw.trim()) {
    if (quoted) {
      if (character === '"') quoted = false;
      else value += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ",") {
      store();
      continue;
    }
    if (character === "=" && inName) {
      inName = false;
      continue;
    }
    if (inName) name += character;
    else value += character;
  }
  store();

  return attributes;
}
