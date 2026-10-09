// Turning an HLS playlist into a video file.
//
// A direct MP4 rendition is downloaded as it is. A playlist rendition is
// assembled here so that no `.m3u8` and no raw MPEG-TS is ever written behind an
// `.mp4` name:
//
// - a playlist with an `EXT-X-MAP` initialization segment is fragmented MP4, and
//   its segments are concatenated as the specification intends;
// - a playlist of MPEG-TS segments is remuxed into fragmented MP4 with mux.js,
//   which moves the same H.264/AAC samples into the container without
//   re-encoding them.
//
// AES-128 segments are decrypted before either of those, with the key and IV the
// playlist names.

import mux from "mux.js";
import { isMasterPlaylist, ivFor, parseMediaPlaylist, pickVariant, resolveUri, type MediaPlaylist } from "../shared/hls";

export interface HlsFetchers {
  fetchText: (url: string) => Promise<string>;
  fetchBytes: (url: string, range?: { offset: number; length: number }) => Promise<Uint8Array>;
}

export interface HlsVideo {
  blob: Blob;
  /** The extension the assembled file has to be written with. */
  extension: string;
  /** True when MPEG-TS was remuxed, and false when the segments were already
   * fragmented MP4. */
  transmuxed: boolean;
  /** The rendition's playlist, once a master playlist was resolved. */
  playlistUrl: string;
}

/** Assembles the video a playlist URL points at. */
export async function assembleHlsVideo(
  playlistUrl: string,
  fetchers: HlsFetchers,
  onProgress?: (segmentsDone: number, segmentsTotal: number) => void,
): Promise<HlsVideo> {
  const resolved = await resolvePlaylist(playlistUrl, fetchers, 0);
  const playlist = parseMediaPlaylist(resolved.text);
  if (playlist.segments.length === 0) {
    throw new Error("the video playlist carries no segments");
  }

  const key = await loadKey(playlist, resolved.url, fetchers);
  const total = playlist.segments.length;
  const chunks: Uint8Array[] = [];

  if (playlist.map) {
    chunks.push(await fetchSegment(playlist.map, resolved.url, fetchers, key));
    onProgress?.(1, total + 1);
    for (const [index, segment] of playlist.segments.entries()) {
      chunks.push(await fetchSegment(segment, resolved.url, fetchers, key));
      onProgress?.(index + 2, total + 1);
    }
    return { blob: toBlob(chunks), extension: ".mp4", transmuxed: false, playlistUrl: resolved.url };
  }

  for (const [index, segment] of playlist.segments.entries()) {
    chunks.push(await fetchSegment(segment, resolved.url, fetchers, key));
    onProgress?.(index + 1, total);
  }

  const joined = concat(chunks);
  if (!looksLikeTransportStream(joined)) {
    // Segments that are not MPEG-TS are already fragmented MP4.
    return { blob: toBlob([joined]), extension: ".mp4", transmuxed: false, playlistUrl: resolved.url };
  }

  const remuxed = remuxTransportStream(joined);
  if (remuxed) {
    return { blob: toBlob([remuxed]), extension: ".mp4", transmuxed: true, playlistUrl: resolved.url };
  }

  // Remuxing could not make sense of the stream. The bytes are still written,
  // honestly named for what they are, and the caller reports the limitation.
  return { blob: toBlob([joined]), extension: ".ts", transmuxed: false, playlistUrl: resolved.url };
}

/** Follows a master playlist to the rendition it offers at the highest
 * bandwidth, and hands back the playlist it fetched along the way so a playlist
 * is never fetched twice. */
async function resolvePlaylist(url: string, fetchers: HlsFetchers, depth: number): Promise<{ url: string; text: string }> {
  const text = await fetchers.fetchText(url);
  if (depth > 3 || !isMasterPlaylist(text)) return { url, text };
  const variant = pickVariant(text);
  if (!variant) return { url, text };
  return resolvePlaylist(resolveUri(url, variant.uri), fetchers, depth + 1);
}

interface SegmentLike {
  uri: string | null;
  bytes: { offset: number; length: number } | null;
}

interface Decryptor {
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
}

async function loadKey(
  playlist: MediaPlaylist,
  playlistUrl: string,
  fetchers: HlsFetchers,
): Promise<Decryptor | null> {
  const declared = playlist.key;
  if (!declared || declared.method !== "AES-128" || !declared.uri) return null;
  const bytes = await fetchers.fetchBytes(resolveUri(playlistUrl, declared.uri));
  const key = await crypto.subtle.importKey("raw", bytes as unknown as BufferSource, "AES-CBC", false, ["decrypt"]);
  const iv = ivFor(playlist) as Uint8Array<ArrayBuffer> | null;
  if (!iv) throw new Error("the playlist names a key without an IV");
  return { key, iv };
}

interface SegmentLike {
  uri: string | null;
  bytes: { offset: number; length: number } | null;
}

async function fetchSegment(
  segment: SegmentLike,
  playlistUrl: string,
  fetchers: HlsFetchers,
  key: Decryptor | null,
): Promise<Uint8Array> {
  if (!segment.uri) throw new Error("the playlist names a segment without a URL");
  const url = resolveUri(playlistUrl, segment.uri);
  const bytes = await fetchers.fetchBytes(url, segment.bytes ?? undefined);
  if (!key) return bytes;
  return decrypt(bytes, key);
}

async function decrypt(bytes: Uint8Array, key: Decryptor): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: key.iv }, key.key, bytes as unknown as BufferSource);
  return new Uint8Array(plain);
}

/** Whether these bytes are MPEG-TS: 188-byte packets each starting with 0x47. */
export function looksLikeTransportStream(bytes: Uint8Array): boolean {
  if (bytes.length < 188) return false;
  return bytes[0] === 0x47 && bytes[188] === 0x47;
}

/** Remuxes MPEG-TS into fragmented MP4 with the same samples. Returns null when
 * mux.js cannot make sense of the stream. */
export function remuxTransportStream(bytes: Uint8Array): Uint8Array | null {
  const initParts: Uint8Array[] = [];
  const mediaParts: Uint8Array[] = [];
  let sawData = false;

  const transmuxer = new mux.mp4.Transmuxer();
  transmuxer.on("data", (segment: { initSegment?: ArrayBuffer; data?: ArrayBuffer }) => {
    if (segment.initSegment) initParts.push(new Uint8Array(segment.initSegment));
    if (segment.data) {
      mediaParts.push(new Uint8Array(segment.data));
      sawData = true;
    }
  });

  try {
    transmuxer.push(bytes as unknown as Uint8Array);
    transmuxer.flush();
  } catch {
    return null;
  }
  if (!sawData) return null;

  return concat([concat(initParts), concat(mediaParts)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Wraps byte parts in a Blob without claiming they share an ArrayBuffer. */
function toBlob(parts: Uint8Array[]): Blob {
  return new Blob(parts as unknown as BlobPart[]);
}
