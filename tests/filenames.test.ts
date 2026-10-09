import { describe, expect, it } from "vitest";
import { boardFolderName, extensionOf, fileStems } from "../src/shared/filenames";

describe("boardFolderName", () => {
  it("uses the board name", () => {
    expect(boardFolderName("The Wilderkind Collection", "the-wilderkind-collection")).toBe(
      "The Wilderkind Collection",
    );
  });

  it("falls back to the slug when the name is empty", () => {
    expect(boardFolderName("", "my-board")).toBe("my-board");
  });

  it("replaces characters a filesystem refuses", () => {
    expect(boardFolderName('Wild: *best* "pins"?', "x")).toBe("Wild best pins");
  });

  it("never becomes a path", () => {
    for (const name of ["..", ".", "/", "..\\..", "con"]) {
      const folder = boardFolderName(name, "board");
      expect(folder).not.toMatch(/[\\/]/);
      expect(folder).not.toBe(".");
      expect(folder).not.toBe("..");
      expect(folder.length).toBeGreaterThan(0);
    }
  });

  it("keeps a Windows device name from being interpreted", () => {
    expect(boardFolderName("nul", "board")).toBe("_nul");
  });

  it("clips a very long name", () => {
    const folder = boardFolderName("a".repeat(200), "board");
    expect(folder.length).toBeLessThanOrEqual(60);
  });
});

describe("fileStems", () => {
  it("keeps a single file bare", () => {
    expect(fileStems("123", ["image"])).toEqual(["123"]);
  });

  it("qualifies several files", () => {
    expect(fileStems("123", ["1", "2"])).toEqual(["123_1", "123_2"]);
  });

  it("produces nothing without items", () => {
    expect(fileStems("123", [])).toEqual([]);
  });
});

describe("extensionOf", () => {
  it("reads the path extension", () => {
    expect(extensionOf("https://i.pinimg.com/originals/4c/90/fb/x.jpg", ".bin")).toBe(".jpg");
    expect(extensionOf("https://v1.pinimg.com/videos/x.mp4?token=1", ".bin")).toBe(".mp4");
  });

  it("upper-cases nothing and ignores unknown extensions", () => {
    expect(extensionOf("https://i.pinimg.com/originals/x.JPEG", ".bin")).toBe(".jpeg");
    expect(extensionOf("https://i.pinimg.com/originals/x.exe", ".bin")).toBe(".bin");
  });

  it("falls back when there is no extension", () => {
    expect(extensionOf("https://i.pinimg.com/originals/x", ".bin")).toBe(".bin");
    expect(extensionOf("not a url", ".mp4")).toBe(".mp4");
  });
});
