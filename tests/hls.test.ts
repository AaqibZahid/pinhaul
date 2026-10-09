import { describe, expect, it } from "vitest";
import {
  ivFor,
  isMasterPlaylist,
  ivFromHex,
  parseMediaPlaylist,
  parseMasterPlaylist,
  pickVariant,
  resolveUri,
} from "../src/shared/hls";

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=263851,CODECS="mp4a.40.2, avc1.4d400d",RESOLUTION=416x234
gear1/prog_index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=577610,CODECS="mp4a.40.2, avc1.4d401f",RESOLUTION=640x360
gear2/prog_index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1924009,CODECS="mp4a.40.2, avc1.4d401f",RESOLUTION=1920x1080
gear5/prog_index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=28451,CODECS="avc1.4d400d",URI="gear1/iframe_index.m3u8"
`;

const MEDIA_TS = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-VERSION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:9.9846,
main.ts
#EXTINF:9.9846,
main.ts
#EXT-X-ENDLIST
`;

const MEDIA_BYTERANGE = `#EXTM3U
#EXT-X-TARGETDURATION:11
#EXT-X-VERSION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:9.9846,
#EXT-X-BYTERANGE:51370@0
main.aac
#EXTINF:9.9846,
#EXT-X-BYTERANGE:51501@51370
main.aac
#EXT-X-ENDLIST
`;

const MEDIA_FMP4 = `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-VERSION:7
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.99200,
seg0.m4s
#EXTINF:4.99200,
seg1.m4s
#EXT-X-ENDLIST
`;

const MEDIA_ENCRYPTED = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x9c7db8778570d05c
#EXTINF:9.9846,
sv0.ts
#EXT-X-ENDLIST
`;

const MEDIA_KEY_NO_IV = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:9.9846,
sv0.ts
#EXT-X-ENDLIST
`;

describe("parseMasterPlaylist", () => {
  it("lists every rendition and ignores the iframe stream", () => {
    const variants = parseMasterPlaylist(MASTER);
    expect(variants.map((variant) => variant.uri)).toEqual([
      "gear1/prog_index.m3u8",
      "gear2/prog_index.m3u8",
      "gear5/prog_index.m3u8",
    ]);
    expect(variants[0]?.bandwidth).toBe(263851);
    expect(variants[0]?.codecs).toBe("mp4a.40.2, avc1.4d400d");
    expect(variants[0]?.resolution).toBe("416x234");
  });

  it("picks the highest bandwidth", () => {
    expect(pickVariant(MASTER)?.uri).toBe("gear5/prog_index.m3u8");
  });

  it("has no variant for a media playlist", () => {
    expect(pickVariant("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\na.ts\n")).toBeNull();
  });

  it("recognises a master playlist", () => {
    expect(isMasterPlaylist(MASTER)).toBe(true);
    expect(isMasterPlaylist("#EXTM3U\n#EXTINF:9.98,\nmain.ts\n")).toBe(false);
  });
});

describe("parseMediaPlaylist", () => {
  it("reads plain segments", () => {
    const playlist = parseMediaPlaylist(MEDIA_TS);
    expect(playlist.segments).toEqual([
      { uri: "main.ts", bytes: null, durationSeconds: 9.9846 },
      { uri: "main.ts", bytes: null, durationSeconds: 9.9846 },
    ]);
    expect(playlist.map).toBeNull();
    expect(playlist.key).toBeNull();
    expect(playlist.ended).toBe(true);
    expect(playlist.mediaSequence).toBe(0);
  });

  it("reads byte ranges", () => {
    const playlist = parseMediaPlaylist(MEDIA_BYTERANGE);
    expect(playlist.segments).toEqual([
      { uri: "main.aac", bytes: { offset: 0, length: 51370 }, durationSeconds: 9.9846 },
      { uri: "main.aac", bytes: { offset: 51370, length: 51501 }, durationSeconds: 9.9846 },
    ]);
  });

  it("reads a byte range with no offset given", () => {
    const playlist = parseMediaPlaylist("#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:100\nmain.aac\n");
    expect(playlist.segments[0]?.bytes).toEqual({ offset: 0, length: 100 });
  });

  it("reads the initialization segment of a fragmented MP4 rendition", () => {
    const playlist = parseMediaPlaylist(MEDIA_FMP4);
    expect(playlist.map).toEqual({ uri: "init.mp4", bytes: null });
    expect(playlist.segments.map((segment) => segment.uri)).toEqual(["seg0.m4s", "seg1.m4s"]);
  });

  it("reads an AES key and its IV", () => {
    const playlist = parseMediaPlaylist(MEDIA_ENCRYPTED);
    expect(playlist.key?.method).toBe("AES-128");
    expect(playlist.key?.uri).toBe("key.bin");
    expect(Array.from(playlist.key?.iv ?? [])).toEqual([
      0x9c, 0x7d, 0xb8, 0x77, 0x85, 0x70, 0xd0, 0x5c, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("knows a live playlist has not ended", () => {
    const playlist = parseMediaPlaylist("#EXTM3U\n#EXTINF:4,\nseg0.m4s\n");
    expect(playlist.ended).toBe(false);
  });

  it("returns nothing for an empty playlist", () => {
    const playlist = parseMediaPlaylist("#EXTM3U\n");
    expect(playlist.segments).toEqual([]);
  });
});

describe("ivFromHex", () => {
  it("reads a 0x-prefixed IV", () => {
    expect(Array.from(ivFromHex("0x9c7db8778570d05c") ?? [])).toEqual([
      0x9c, 0x7d, 0xb8, 0x77, 0x85, 0x70, 0xd0, 0x5c, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("has nothing for a missing or malformed IV", () => {
    expect(ivFromHex(undefined)).toBeNull();
    expect(ivFromHex("not hex")).toBeNull();
    expect(ivFromHex("")).toBeNull();
  });
});

describe("ivFor", () => {
  it("derives the media sequence number when the playlist names no IV", () => {
    const playlist = parseMediaPlaylist(MEDIA_KEY_NO_IV);
    expect(Array.from(ivFor(playlist) ?? [])).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("uses the sequence the playlist actually starts at", () => {
    const playlist = parseMediaPlaylist(
      MEDIA_KEY_NO_IV.replace("MEDIA-SEQUENCE:0", "MEDIA-SEQUENCE:5000000005"),
    );
    expect(Array.from(ivFor(playlist) ?? [])).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x2a, 0x05, 0xf2, 5]);
  });

  it("has nothing for an unencrypted playlist", () => {
    expect(ivFor(parseMediaPlaylist(MEDIA_TS))).toBeNull();
  });
});

describe("resolveUri", () => {
  it("resolves a relative segment against the playlist", () => {
    expect(resolveUri("https://v1.pinimg.com/videos/hls/a/index.m3u8", "main.ts")).toBe(
      "https://v1.pinimg.com/videos/hls/a/main.ts",
    );
  });

  it("keeps an absolute URL", () => {
    expect(resolveUri("https://v1.pinimg.com/a.m3u8", "https://x/main.ts")).toBe("https://x/main.ts");
  });
});
