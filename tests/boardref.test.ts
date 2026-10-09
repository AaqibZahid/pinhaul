import { describe, expect, it } from "vitest";
import { boardKey, boardUrl, parseBoardRef } from "../src/shared/boardref";

function ref(input: string) {
  const result = parseBoardRef(input);
  if (!result.ok) throw new Error(`expected a board, got: ${result.error}`);
  return result.ref;
}

function error(input: string) {
  const result = parseBoardRef(input);
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

describe("parseBoardRef", () => {
  it("reads username/boardname", () => {
    expect(ref("chamberlaincoffeepins/the-wilderkind-collection")).toEqual({
      username: "chamberlaincoffeepins",
      slug: "the-wilderkind-collection",
    });
  });

  it("tolerates padding and a trailing slash", () => {
    expect(ref("  user/board-name/  ")).toEqual({ username: "user", slug: "board-name" });
  });

  it("reads a full URL with a query string", () => {
    expect(ref("https://www.pinterest.com/user/board-name/?utm_source=x")).toEqual({
      username: "user",
      slug: "board-name",
    });
  });

  it("reads a section URL as its board", () => {
    expect(ref("https://pinterest.com/user/board-name/mardi-gras/").username).toBe("user");
  });

  it("reads a regional domain", () => {
    expect(ref("https://www.pinterest.co.uk/user/board/").username).toBe("user");
  });

  it("strips an @ prefix", () => {
    expect(ref("@someone/some-board").username).toBe("someone");
  });

  it("builds the canonical URL and key", () => {
    const { username, slug } = ref("user/board-name");
    expect(boardUrl(username, slug)).toBe("https://www.pinterest.com/user/board-name/");
    expect(boardKey({ username, slug })).toBe("user/board-name");
  });

  it("refuses a profile URL", () => {
    expect(error("https://www.pinterest.com/someone/")).toMatch(/not a board/i);
  });

  it("refuses a single segment", () => {
    expect(error("someone")).toMatch(/not a board/i);
  });

  it("refuses empty input", () => {
    expect(error("   ")).toMatch(/enter a board/i);
  });

  it("refuses a non-Pinterest host", () => {
    expect(error("https://example.com/user/board/")).toMatch(/not on pinterest/i);
  });

  it("refuses a short link", () => {
    expect(error("https://pin.it/abc")).toMatch(/not on pinterest/i);
  });

  it("refuses a reserved path", () => {
    expect(error("https://www.pinterest.com/pin/12345/")).toMatch(/not a username/i);
  });

  it("refuses a separator inside a segment", () => {
    expect(error("user/..\\..\\elsewhere")).toMatch(/path separator/i);
    expect(error("user/board\\..\\..\\x")).toMatch(/path separator/i);
  });

  it("refuses whitespace and illegal characters", () => {
    expect(error("user/board name")).toMatch(/whitespace/i);
    expect(error("user/board?x")).toMatch(/illegal/i);
  });

  it("refuses a board that is only dots", () => {
    expect(error("user/..")).toMatch(/valid board name/i);
  });
});
