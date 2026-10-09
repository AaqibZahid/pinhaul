import { describe, expect, it } from "vitest";
import { listAccountBoards } from "../src/background/account";
import type { PinterestGateway, ResourceEnvelope } from "../src/background/pinterest";

class FakePinterest implements PinterestGateway {
  pages = 0;

  async getData<T>(): Promise<T> {
    return { username: "alice" } as T;
  }

  async getResource(resource: string, options: Record<string, unknown>, _sourceUrl: string): Promise<ResourceEnvelope> {
    expect(resource).toBe("BoardsFeedResource");
    expect(options.username).toBe("alice");
    this.pages += 1;
    if (this.pages === 1) {
      return {
        resource_response: {
          data: [{ id: "1", name: "Ideas", slug: "ideas", pin_count: 4, section_count: 1, image_thumbnail_url: "/thumb.jpg" }],
          bookmark: "next",
        },
      };
    }
    return { resource_response: { data: [{ id: "2", name: "Private", slug: "private", pin_count: "0", section_count: "0" }] } };
  }
}

describe("listAccountBoards", () => {
  it("paginates and normalizes the signed-in account boards", async () => {
    const boards = await listAccountBoards(new FakePinterest());
    expect(boards).toEqual([
      {
        id: "1",
        name: "Ideas",
        slug: "ideas",
        username: "alice",
        url: "https://www.pinterest.com/alice/ideas/",
        pinCount: 4,
        sectionCount: 1,
        thumbnailUrl: "https://www.pinterest.com/thumb.jpg",
      },
      {
        id: "2",
        name: "Private",
        slug: "private",
        username: "alice",
        url: "https://www.pinterest.com/alice/private/",
        pinCount: 0,
        sectionCount: 0,
      },
    ]);
  });
});
