import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  it("replays the mixed live response shapes and stops at the end cursor", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/account-responses.json", import.meta.url), "utf8")) as {
      user: unknown;
      pages: ResourceEnvelope[];
    };
    let page = 0;
    const client: PinterestGateway = {
      async getData<T>(): Promise<T> {
        return (fixture.user as { resource_response: { data: unknown } }).resource_response.data as T;
      },
      async getResource(): Promise<ResourceEnvelope> {
        return fixture.pages[page++] ?? { resource_response: { data: [] } };
      },
    };

    await expect(listAccountBoards(client)).resolves.toEqual([
      expect.objectContaining({ id: "1", name: "Ideas", pinCount: 4, sectionCount: 1, thumbnailUrl: "https://www.pinterest.com/thumb.jpg" }),
      expect.objectContaining({ id: "2", name: "Private", slug: "private", pinCount: 0, sectionCount: 0, thumbnailUrl: "https://i.pinimg.com/236x/private.jpg" }),
    ]);
    expect(page).toBe(2);
  });

  it("accepts a nested user response used by newer Pinterest payloads", async () => {
    const client: PinterestGateway = {
      async getData<T>(): Promise<T> {
        return { user: { slug: "alice" } } as T;
      },
      async getResource(): Promise<ResourceEnvelope> {
        return { resource_response: { data: [] } };
      },
    };
    await expect(listAccountBoards(client)).resolves.toEqual([]);
  });

  it("labels both failed user lookups as an authenticated-session error", async () => {
    const error = new Error("401");
    const client: PinterestGateway = {
      async getData(): Promise<never> {
        throw error;
      },
      async getResource(): Promise<ResourceEnvelope> {
        throw new Error("should not list boards without a user");
      },
    };
    await expect(listAccountBoards(client)).rejects.toMatchObject({ kind: "unauthorized" });
  });
});
