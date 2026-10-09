import { describe, expect, it } from "vitest";
import { ZipWriter } from "../src/background/zip";

describe("ZipWriter", () => {
  it("writes a readable stored ZIP with paths and CRCs", async () => {
    const zip = new ZipWriter();
    zip.add("Board/Section/pin.jpg", new TextEncoder().encode("hello"));
    const bytes = new Uint8Array(await zip.build().arrayBuffer());
    expect(signature(bytes, 0)).toBe(0x04034b50);
    expect(signature(bytes, bytes.length - 22)).toBe(0x06054b50);
    expect(new TextDecoder().decode(bytes)).toContain("Board/Section/pin.jpg");
    expect(read32(bytes, 14)).toBe(0x3610a686);
    expect(read32(bytes, 18)).toBe(5);
    expect(read32(bytes, 22)).toBe(5);
  });
});

function signature(bytes: Uint8Array, offset: number): number {
  return read32(bytes, offset);
}

function read32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24);
}
