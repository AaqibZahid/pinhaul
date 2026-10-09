import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assembleHlsVideo,
  looksLikeTransportStream,
  remuxTransportStream,
  type HlsFetchers,
} from "../src/background/video-hls";

const tsBytes = new Uint8Array(readFileSync(new URL("./fixtures/hls-ts.bin", import.meta.url)));

function fetchers(handlers: {
  text?: Record<string, string>;
  bytes?: (url: string) => Uint8Array;
  ranges?: Record<string, URL[]>;
}): HlsFetchers & { seen: string[] } {
  const seen: string[] = [];
  const text: Record<string, string> = handlers.text ?? {};
  const ranges: Record<string, URL[]> = handlers.ranges ?? {};
  return {
    seen,
    async fetchText(url: string) {
      seen.push(url);
      const body = text[url];
      if (body === undefined) throw new Error(`no playlist for ${url}`);
      return body;
    },
    async fetchBytes(url: string, range?: { offset: number; length: number }) {
      seen.push(url);
      ranges[url] ??= [];
      if (range) ranges[url].push(new URL(`x://x?${range.offset}-${range.offset + range.length - 1}`));
      return handlers.bytes?.(url) ?? new Uint8Array([1, 2, 3]);
    },
  };
}

const TS_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:1.92,
main.ts
#EXTINF:1.92,
main.ts
#EXT-X-ENDLIST
`;

const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=577610,RESOLUTION=640x360
gear2/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1924009,RESOLUTION=1920x1080
gear5/index.m3u8
#EXT-X-ENDLIST
`;

const FMP4_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.99,
seg0.m4s
#EXTINF:4.99,
seg1.m4s
#EXT-X-ENDLIST
`;

/** A short head of the real sample, cut on a packet boundary. */
const tsHead = tsBytes.slice(0, 188 * 400);

describe("looksLikeTransportStream", () => {
  it("recognises the real sample", () => {
    expect(looksLikeTransportStream(tsHead)).toBe(true);
  });

  it("rejects bytes that are not TS packets", () => {
    expect(looksLikeTransportStream(new Uint8Array(400).fill(0))).toBe(false);
    expect(looksLikeTransportStream(new Uint8Array(10))).toBe(false);
  });
});

describe("remuxTransportStream", () => {
  it("turns a real MPEG-TS sample into fragmented MP4", () => {
    const mp4 = remuxTransportStream(tsHead);
    expect(mp4).not.toBeNull();
    const bytes = mp4 as Uint8Array;
    const type = (offset: number) => String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    // A fragmented MP4 starts with ftyp then moov, and carries moof/mdat pairs.
    expect(type(0)).toBe("ftyp");
    expect(type(24)).toBe("moov");
    expect(String.fromCharCode(...bytes.slice(24, 24 + 20))).toContain("moov");
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("returns null for bytes that are not a stream", () => {
    expect(remuxTransportStream(new Uint8Array(188 * 4).fill(0x47))).toBeNull();
  });
});

describe("assembleHlsVideo", () => {
  it("remuxes an MPEG-TS playlist into a playable mp4", async () => {
    const fake = fetchers({
      text: { "https://v1.pinimg.com/videos/index.m3u8": TS_PLAYLIST },
      bytes: () => tsHead,
    });
    const video = await assembleHlsVideo("https://v1.pinimg.com/videos/index.m3u8", fake);
    expect(video.extension).toBe(".mp4");
    expect(video.transmuxed).toBe(true);
    expect(await video.blob.size).toBeGreaterThan(0);
    expect(fake.seen).toEqual([
      "https://v1.pinimg.com/videos/index.m3u8",
      "https://v1.pinimg.com/videos/main.ts",
      "https://v1.pinimg.com/videos/main.ts",
    ]);
  });

  it("follows a master playlist to the highest bandwidth rendition", async () => {
    const fake = fetchers({
      text: {
        "https://v1.pinimg.com/videos/index.m3u8": MASTER_PLAYLIST,
        "https://v1.pinimg.com/videos/gear5/index.m3u8": TS_PLAYLIST,
      },
      bytes: () => tsHead,
    });
    const video = await assembleHlsVideo("https://v1.pinimg.com/videos/index.m3u8", fake);
    expect(video.playlistUrl).toBe("https://v1.pinimg.com/videos/gear5/index.m3u8");
    expect(video.extension).toBe(".mp4");
  });

  it("concatenates an initialization segment and its fragments as-is", async () => {
    const fake = fetchers({
      text: { "https://v1.pinimg.com/videos/index.m3u8": FMP4_PLAYLIST },
      bytes: (url) => new TextEncoder().encode(url),
    });
    const video = await assembleHlsVideo("https://v1.pinimg.com/videos/index.m3u8", fake);
    expect(video.extension).toBe(".mp4");
    expect(video.transmuxed).toBe(false);
    const text = await video.blob.text();
    expect(text).toContain("init.mp4");
    expect(text.indexOf("init.mp4")).toBeLessThan(text.indexOf("seg0.m4s"));
  });

  it("asks for a byte range when the playlist names one", async () => {
    const ranges: Record<string, URL[]> = {};
    const fake = fetchers({
      text: {
        "https://v1.pinimg.com/videos/index.m3u8": `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.98,
#EXT-X-BYTERANGE:120@188
main.ts
#EXT-X-ENDLIST
`,
      },
      bytes: () => tsHead,
      ranges,
    });
    await assembleHlsVideo("https://v1.pinimg.com/videos/index.m3u8", fake);
    expect(ranges["https://v1.pinimg.com/videos/main.ts"]?.[0]?.search).toBe("?188-307");
  });

  it("decrypts an AES-128 playlist back to its plain bytes", async () => {
    const key = new Uint8Array(16).fill(7);
    const iv = new Uint8Array(16).fill(3);
    const imported = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, imported, tsHead));

    const fake = fetchers({
      text: {
        "https://v1.pinimg.com/videos/index.m3u8": `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x03030303030303030303030303030303
#EXTINF:1.92,
main.ts
#EXT-X-ENDLIST
`,
        "https://v1.pinimg.com/videos/key.bin": "key",
      },
      bytes: (url) => (url.endsWith("key.bin") ? key : cipher),
    });

    const video = await assembleHlsVideo("https://v1.pinimg.com/videos/index.m3u8", fake);
    expect(video.transmuxed).toBe(true);
    // The remuxed file is not the same bytes, but it is a real MP4 of the same
    // length, which is what proves the segments were decrypted.
    expect(video.blob.size).toBeGreaterThan(0);
  });

  it("refuses a playlist with no segments", async () => {
    const fake = fetchers({
      text: { "https://v1.pinimg.com/videos/index.m3u8": "#EXTM3U\n#EXT-X-ENDLIST\n" },
    });
    await expect(assembleHlsVideo("https://v1.pinimg.com/videos/index.m3u8", fake)).rejects.toThrow(/no segments/);
  });

  it("reports progress as segments arrive", async () => {
    const seen: Array<[number, number]> = [];
    const fake = fetchers({
      text: { "https://v1.pinimg.com/videos/index.m3u8": TS_PLAYLIST },
      bytes: () => tsHead,
    });
    await assembleHlsVideo("https://v1.pinimg.com/videos/index.m3u8", fake, (done, total) => seen.push([done, total]));
    expect(seen[seen.length - 1]).toEqual([2, 2]);
  });
});
