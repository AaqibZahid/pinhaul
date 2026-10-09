import { describe, expect, it } from "vitest";
import { BoardCrawler, loadSections, pinIdsOf, resolveBoard } from "../src/background/discovery";
import { PinterestClient, resourceUrl } from "../src/background/pinterest";

/** A Pinterest-shaped fake that answers the resources the crawler asks for. */
class FakePinterest {
  calls: string[] = [];
  private readonly pages = new Map<string, Array<() => unknown>>();

  on(key: string, ...bodies: unknown[]) {
    this.pages.set(key, bodies.map((body) => () => body));
  }

  fetch = async (input: string): Promise<Response> => {
    const url = String(input);
    this.calls.push(url);
    for (const [key, bodies] of this.pages) {
      if (!url.includes(key)) continue;
      const next = bodies.shift();
      if (next === undefined) {
        return json({ resource_response: { status: "success", data: [], bookmark: "-end-" } });
      }
      return json(next());
    }
    return json({ resource_response: { status: "success", data: [] } });
  };

  client() {
    return new PinterestClient({ fetch: this.fetch as unknown as typeof fetch, intervalMs: 0 });
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function pin(id: string) {
  return { node_id: btoa(`Pin:${id}`), id, type: "pin", images: { orig: { url: `https://i.pinimg.com/originals/${id}.jpg` } } };
}

function feedPage(ids: string[], bookmark: string | null) {
  const data = ids.map((id) => pin(id));
  // A board feed ends with a module that is not a pin.
  data.push({ id: "GtSJzuRT", story_type: "related_interests_module", type: "story" });
  return { resource_response: { status: "success", data, bookmark } };
}

describe("resourceUrl", () => {
  it("builds the URL the web app uses", () => {
    const url = resourceUrl("BoardResource", { slug: "b", username: "u" }, "/u/b/");
    expect(url).toContain("https://www.pinterest.com/resource/BoardResource/get/?data=");
    const data = decodeURIComponent(url.split("data=")[1].split("&")[0]);
    expect(JSON.parse(data)).toEqual({ options: { slug: "b", username: "u" } });
    expect(url).toContain("source_url=%2Fu%2Fb%2F");
  });
});

describe("resolveBoard", () => {
  it("reads the board Pinterest holds", async () => {
    const fake = new FakePinterest();
    fake.on(
      "BoardResource",
      {
        resource_response: {
          status: "success",
          data: {
            id: "424605139807823617",
            name: "Home decor",
            url: "/pinterest/home-decor/",
            pin_count: 4133,
            section_count: 81,
          },
        },
      },
    );
    const resolved = await resolveBoard(fake.client(), { username: "pinterest", slug: "home-decor" }, "/pinterest/home-decor/");
    expect(resolved.info).toEqual({
      id: "424605139807823617",
      name: "Home decor",
      url: "https://www.pinterest.com/pinterest/home-decor/",
      pinCount: 4133,
      sectionCount: 81,
    });
    expect(resolved.hasSections).toBe(true);
  });

  it("reports a board Pinterest refuses", async () => {
    const fake = new FakePinterest();
    fake.on("BoardResource", {
      resource_response: { status: "failure", error: { message: "Board not found.", http_status: 404 }, data: null },
    });
    await expect(resolveBoard(fake.client(), { username: "u", slug: "b" }, "/u/b/")).rejects.toThrow(/Board not found/);
  });
});

describe("loadSections", () => {
  it("reads every section by id", async () => {
    const fake = new FakePinterest();
    fake.on(
      "BoardSectionsResource",
      { resource_response: { status: "success", data: [{ id: "1", name: "Kitchen" }, { id: "2", slug: "beds" }], bookmark: null } },
    );
    expect(await loadSections(fake.client(), "4246")).toEqual([
      { id: "1", name: "Kitchen" },
      { id: "2", name: "beds" },
    ]);
  });
});

describe("BoardCrawler", () => {
  it("walks the feed and the sections and merges them by pin id", async () => {
    const fake = new FakePinterest();
    fake.on(
      "BoardFeedResource",
      feedPage(["1", "2"], "b1"),
      feedPage(["3"], null),
    );
    fake.on(
      "BoardSectionPinsResource",
      { resource_response: { status: "success", data: [pin("2"), pin("9")], bookmark: null } },
    );

    const crawler = new BoardCrawler(fake.client(), "board", BoardCrawler.start("board", [{ id: "s1", name: "S" }]));
    const seen: string[] = [];
    let page = await crawler.nextPage();
    while (page) {
      seen.push(...page.pinIds);
      page = await crawler.nextPage();
    }
    expect(seen).toEqual(["1", "2", "3", "2", "9"]);
    expect(crawler.remaining).toBe(0);
  });

  it("never counts a module as a pin", async () => {
    const fake = new FakePinterest();
    fake.on(
      "BoardFeedResource",
      { resource_response: { status: "success", data: [{ id: "GtSJzuRT", story_type: "related_interests_module", type: "story" }], bookmark: null } },
    );
    const crawler = new BoardCrawler(fake.client(), "board", BoardCrawler.start("board", []));
    const page = await crawler.nextPage();
    expect(page?.pinIds).toEqual([]);
    expect(await crawler.nextPage()).toBeNull();
  });

  it("retries an empty page instead of ending the board early", async () => {
    const fake = new FakePinterest();
    fake.on(
      "BoardFeedResource",
      // A transient empty page: no items, and a cursor to carry on from.
      { resource_response: { status: "success", data: [], bookmark: "b1" } },
      feedPage(["1", "2"], null),
    );
    const crawler = new BoardCrawler(fake.client(), "board", BoardCrawler.start("board", []));
    const page = await crawler.nextPage();
    expect(page?.pinIds).toEqual(["1", "2"]);
    expect(await crawler.nextPage()).toBeNull();
  });

  it("gives up after a page stays empty, so a board still finishes", async () => {
    const fake = new FakePinterest();
    fake.on(
      "BoardFeedResource",
      { resource_response: { status: "success", data: [], bookmark: "b1" } },
      { resource_response: { status: "success", data: [], bookmark: "b1" } },
      { resource_response: { status: "success", data: [], bookmark: "b1" } },
    );
    const crawler = new BoardCrawler(fake.client(), "board", BoardCrawler.start("board", []));
    const page = await crawler.nextPage();
    expect(page?.pinIds).toEqual([]);
    expect(page?.stream).toBe("feed");
    expect(await crawler.nextPage()).toBeNull();
  });

  it("marks a stream that Pinterest refuses as walked and reports why", async () => {
    const fake = new FakePinterest();
    fake.on("BoardFeedResource", feedPage([], null));
    fake.on(
      "BoardSectionPinsResource",
      { resource_response: { status: "failure", error: { message: "nope", http_status: 403 }, data: null } },
    );
    const crawler = new BoardCrawler(fake.client(), "board", BoardCrawler.start("board", [{ id: "s1", name: "S" }]));
    const feed = await crawler.nextPage();
    expect(feed?.stream).toBe("feed");
    const page = await crawler.nextPage();
    expect(page?.error).toMatch(/nope/);
    expect(page?.stream).toBe("section");
    expect(crawler.remaining).toBe(0);
  });
});

describe("pinIdsOf", () => {
  it("reads a node id, a plain id and skips what is not a pin", () => {
    expect(pinIdsOf([pin("7"), { id: "8", type: "pin" }, { id: "M1", story_type: "x" }, null])).toEqual(["7", "8"]);
  });
});
