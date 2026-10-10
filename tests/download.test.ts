import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { downloadBoard } from "../src/background/download";
import type { PinterestGateway, ResourceEnvelope } from "../src/background/pinterest";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/small-board.json", import.meta.url), "utf8")) as {
  board: Record<string, unknown>;
  sections: unknown[];
  feed: unknown[];
  sectionPins: unknown[];
  pins: Record<string, unknown>;
};
const tsBytes = new Uint8Array(readFileSync(new URL("./fixtures/hls-ts.bin", import.meta.url)));

describe("downloadBoard", () => {
  it("does not create a file when cancelled before work starts", async () => {
    const controller = new AbortController();
    controller.abort();
    let saved = false;
    await expect(
      downloadBoard(
        { username: "alice", slug: "ideas" },
        false,
        {
          client: {
            getData: async () => ({}) as never,
            getResource: async () => ({}) as never,
          },
          save: async () => {
            saved = true;
            return 1;
          },
          wait: async () => undefined,
        },
        () => undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(saved).toBe(false);
  });

  it("does not create a ZIP when stopped during a media request", async () => {
    const controller = new AbortController();
    const save = vi.fn(async () => 1);
    const client: PinterestGateway = {
      async getData<T>(resource: string, options: Record<string, unknown>): Promise<T> {
        return (resource === "BoardResource" ? fixture.board : fixture.pins[String(options.id)]) as T;
      },
      async getResource(resource: string): Promise<ResourceEnvelope> {
        return { resource_response: { data: resource === "BoardSectionsResource" ? fixture.sections : resource === "BoardFeedResource" ? fixture.feed : fixture.sectionPins } };
      },
    };
    vi.stubGlobal("fetch", async () => {
      controller.abort();
      throw new DOMException("Stopped", "AbortError");
    });
    try {
      await expect(downloadBoard(
        { username: "alice", slug: "trip-ideas" }, false,
        { client, save, wait: async () => undefined },
        () => undefined, controller.signal,
      )).rejects.toMatchObject({ name: "AbortError" });
      expect(save).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("builds one section-aware ZIP from a realistic mixed board", async () => {
    let saved: Blob | undefined;
    const fetched: string[] = [];
    const client: PinterestGateway = {
      async getData<T>(resource: string, options: Record<string, unknown>): Promise<T> {
        if (resource === "BoardResource") return fixture.board as T;
        if (resource === "PinResource") return fixture.pins[String(options.id)] as T;
        throw new Error(`unexpected data resource ${resource}`);
      },
      async getResource(resource: string): Promise<ResourceEnvelope> {
        if (resource === "BoardSectionsResource") return { resource_response: { data: fixture.sections } };
        if (resource === "BoardFeedResource") return { resource_response: { data: fixture.feed } };
        if (resource === "BoardSectionPinsResource") return { resource_response: { data: fixture.sectionPins } };
        throw new Error(`unexpected resource ${resource}`);
      },
    };

    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url.endsWith("/originals/skip.jpg")) return new Response(null, { status: 403 });
      if (url.endsWith("index.m3u8")) {
        return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.92,\nclip.ts\n#EXT-X-ENDLIST\n");
      }
      if (url.endsWith("clip.ts")) return new Response(tsBytes);
      return new Response(new TextEncoder().encode(url.endsWith("direct.mp4") ? "mp4" : "image"));
    });
    try {
      const result = await downloadBoard(
        { username: "alice", slug: "trip-ideas" },
        false,
        {
          client,
          save: async (blob) => {
            saved = blob;
            return 1;
          },
          wait: async () => undefined,
        },
        () => undefined,
        new AbortController().signal,
      );

      expect(result.phase).toBe("done");
      expect(result.discovered).toBe(5);
      expect(result.processed).toBe(5);
      expect(result.files).toBe(5);
      expect(result.images).toBe(3);
      expect(result.videos).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
      expect(fetched).toContain("https://i.pinimg.com/736x/skip.jpg");
      expect(saved).toBeDefined();
      const names = zipNames(await saved!.arrayBuffer());
      expect(names).toEqual([
        "Trip Ideas/image-root.jpg",
        "Trip Ideas/Bad Section/image-section.jpg",
        "Trip Ideas/direct-video.mp4",
        "Trip Ideas/Bad Section/hls-video.mp4",
        "Trip Ideas/skip-me.jpg",
      ]);
      expect(new Uint8Array(await saved!.arrayBuffer()).at(-22)).toBe(0x50);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});

function zipNames(buffer: ArrayBuffer): string[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const names: string[] = [];
  for (let offset = 0; offset + 46 <= bytes.length;) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    names.push(new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength)));
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return names;
}
