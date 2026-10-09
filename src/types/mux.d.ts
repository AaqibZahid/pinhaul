// The parts of mux.js this extension uses: remuxing MPEG-TS into fragmented
// MP4. The library ships no types of its own.
declare module "mux.js" {
  export interface TransmuxedSegment {
    initSegment?: ArrayBuffer;
    data?: ArrayBuffer;
    captions?: unknown;
    metadata?: unknown;
  }

  export class Transmuxer {
    on(event: "data", listener: (segment: TransmuxedSegment) => void): this;
    on(event: "done", listener: () => void): this;
    push(bytes: Uint8Array): void;
    flush(): void;
  }

  const mux: { mp4: { Transmuxer: typeof Transmuxer } };
  export default mux;
}
