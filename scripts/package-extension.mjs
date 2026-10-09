import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const input = path.join(root, "dist");
const outputDir = path.join(root, "artifacts");
const manifestPath = path.join(input, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const required = ["manifest.json", "background/service-worker.js", "popup/popup.html"];

for (const file of required) {
  try {
    await stat(path.join(input, file));
  } catch {
    throw new Error(`dist is missing ${file}; run npm run build first`);
  }
}

const files = await filesUnder(input);
const entries = files.map((file) => ({
  name: file.slice(input.length + 1).replaceAll(path.sep, "/"),
  data: fileData(file),
}));
for (const entry of entries) entry.data = await entry.data;

const chunks = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name);
  const crc = crc32(entry.data);
  chunks.push(localHeader(name, entry.data.length, crc), name, entry.data);
  entry.crc = crc;
  entry.offset = offset;
  offset += 30 + name.length + entry.data.length;
}

const centralOffset = offset;
for (const entry of entries) {
  const name = Buffer.from(entry.name);
  chunks.push(centralHeader(name, entry.data.length, entry.crc, entry.offset), name);
  offset += 46 + name.length;
}
chunks.push(endRecord(entries.length, offset - centralOffset, centralOffset));

await mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, `pinpull-v${manifest.version}.zip`);
await writeFile(output, Buffer.concat(chunks));
console.log(`packaged ${path.relative(root, output)}`);

async function filesUnder(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...(await filesUnder(full)));
    else result.push(full);
  }
  return result.sort();
}

async function fileData(file) {
  return readFile(file);
}

function localHeader(name, size, crc) {
  const header = Buffer.alloc(30);
  write(header, 0, 0x04034b50);
  write(header, 4, 20, 2);
  write(header, 14, crc);
  write(header, 18, size);
  write(header, 22, size);
  write(header, 26, name.length, 2);
  return header;
}

function centralHeader(name, size, crc, offset) {
  const header = Buffer.alloc(46);
  write(header, 0, 0x02014b50);
  write(header, 4, 20, 2);
  write(header, 6, 20, 2);
  write(header, 16, crc);
  write(header, 20, size);
  write(header, 24, size);
  write(header, 28, name.length, 2);
  write(header, 42, offset);
  return header;
}

function endRecord(count, size, offset) {
  const record = Buffer.alloc(22);
  write(record, 0, 0x06054b50);
  write(record, 8, count, 2);
  write(record, 10, count, 2);
  write(record, 12, size);
  write(record, 16, offset);
  return record;
}

function write(target, offset, value, bytes = 4) {
  for (let index = 0; index < bytes; index++) target[offset + index] = value >>> (index * 8);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
