const textEncoder = new TextEncoder();

interface Entry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/** A small stored ZIP writer; Pinterest media is already compressed. */
export class ZipWriter {
  private readonly entries: Entry[] = [];
  private offset = 0;

  add(name: string, data: Uint8Array): void {
    const entry: Entry = { name: textEncoder.encode(name), data, crc: crc32(data), offset: this.offset };
    this.entries.push(entry);
    this.offset += 30 + entry.name.length + data.length;
  }

  build(): Blob {
    const parts: BlobPart[] = [];
    for (const entry of this.entries) {
      parts.push(blobBytes(localHeader(entry)), blobBytes(entry.name), blobBytes(entry.data));
    }
    const centralOffset = this.offset;
    for (const entry of this.entries) parts.push(blobBytes(centralHeader(entry)), blobBytes(entry.name));
    const centralSize = this.offsetFromCentral() - centralOffset;
    parts.push(blobBytes(endRecord(this.entries.length, centralSize, centralOffset)));
    return new Blob(parts, { type: "application/zip" });
  }

  private offsetFromCentral(): number {
    return this.offset + this.entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  }
}

function blobBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function localHeader(entry: Entry): Uint8Array {
  const header = new Uint8Array(30);
  write(header, 0, 0x04034b50);
  write(header, 4, 20, 2);
  write(header, 14, entry.crc);
  write(header, 18, entry.data.length);
  write(header, 22, entry.data.length);
  write(header, 26, entry.name.length, 2);
  return header;
}

function centralHeader(entry: Entry): Uint8Array {
  const header = new Uint8Array(46);
  write(header, 0, 0x02014b50);
  write(header, 4, 20, 2);
  write(header, 6, 20, 2);
  write(header, 16, entry.crc);
  write(header, 20, entry.data.length);
  write(header, 24, entry.data.length);
  write(header, 28, entry.name.length, 2);
  write(header, 42, entry.offset);
  return header;
}

function endRecord(count: number, size: number, offset: number): Uint8Array {
  const record = new Uint8Array(22);
  write(record, 0, 0x06054b50);
  write(record, 8, count, 2);
  write(record, 10, count, 2);
  write(record, 12, size);
  write(record, 16, offset);
  return record;
}

function write(target: Uint8Array, offset: number, value: number, bytes = 4): void {
  for (let i = 0; i < bytes; i++) target[offset + i] = value >>> (i * 8);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
