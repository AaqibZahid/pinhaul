// Generates the extension icons into src/icons/ without any image dependency.
// Run with: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 4;
      // A rounded dark tile with a bold "P" that reads at 16px.
      const inset = Math.max(1, Math.round(size * 0.08));
      const r = size / 2;
      const dx = (x + 0.5) - r;
      const dy = (y + 0.5) - r;
      const radius = r - inset;
      const inside =
        x >= inset && x < size - inset && y >= inset && y < size - inset;
      if (!inside) {
        raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 0; raw[i + 3] = 0;
        continue;
      }
      // letter P: vertical stem plus a bowl in the upper half
      const stemX = x < r * 0.98 && x >= r * 0.44;
      const bowlY = y >= r * 0.24 && y <= r * 0.98;
      const stem = x >= r * 0.44 && x <= r * 0.72 && y >= r * 0.24 && y <= r * 1.62;
      const bowl =
        bowlY &&
        x >= r * 0.72 &&
        x <= r * 1.5 &&
        (Math.hypot(dx - r * 0.95, dy - r * 0.98) <= r * 0.62 ||
          (x <= r * 0.72 + r * 0.2 && y <= r * 0.86));
      const on = stem || bowl;
      raw[i] = on ? 243 : 23;
      raw[i + 1] = on ? 241 : 25;
      raw[i + 2] = on ? 235 : 31;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = path.join(process.cwd(), "src", "icons");
mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(path.join(dir, `${size}.png`), png(size));
  console.log(`wrote icons/${size}.png`);
}
