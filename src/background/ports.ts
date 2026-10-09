// The pieces of Chrome the job runner talks to.
//
// They are interfaces so the runner can be driven by tests without a browser:
// the service worker binds them to the real APIs, the tests supply fakes.

import type { Job, JobProgress, MediaKind } from "../shared/types";
import type { ResourceEnvelope } from "./pinterest";

export interface DownloadRequest {
  url: string;
  filename: string;
}

export interface DownloadItem {
  id: number;
  state: "in_progress" | "complete" | "interrupted";
  error?: string;
}

export interface Downloader {
  /** Starts a download and returns Chrome's id for it. */
  start(request: DownloadRequest): Promise<number>;
  /** Looks download ids up, so a restarted job can reconcile them. */
  find(ids: number[]): Promise<DownloadItem[]>;
  /** Opens the folder the downloads are stored in, where Chrome allows it. */
  reveal(): void;
}

export interface JobStore {
  load(): Promise<Job | null>;
  save(job: Job): Promise<void>;
  clear(): Promise<void>;
}

/** Everything a job needs from the outside world. */
export interface RunnerDeps {
  client: PinterestGateway;
  store: JobStore;
  downloader: Downloader;
  /** Fetches text (a playlist) with the Pinterest session attached. */
  fetchText: (url: string) => Promise<string>;
  /** Fetches bytes, honouring a byte range when the server supports it. */
  fetchBytes: (url: string, range?: { offset: number; length: number }) => Promise<Uint8Array>;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Reports a downloadable media file's details, for the HLS path. */
  onJobUpdated?: (progress: JobProgress) => void;
}

/** One media file a pin contributes, still to be written. */
/** Everything the job runner asks of Pinterest: the same two calls the crawler
 * and the pin lookup make. */
export interface PinterestGateway {
  getData<T = unknown>(resource: string, options: Record<string, unknown>, sourceUrl: string): Promise<T>;
  getResource(resource: string, options: Record<string, unknown>, sourceUrl: string): Promise<ResourceEnvelope>;
}

/** One media file a pin contributes, still to be written. */
export interface MediaFile {
  pinId: string;
  url: string;
  filename: string;
  kind: MediaKind;
  index: number;
}

/** Everything a job needs from the outside world. */
export interface RunnerDeps {
  client: PinterestGateway;
  store: JobStore;
  downloader: Downloader;
  /** Fetches text (a playlist) with the Pinterest session attached. */
  fetchText: (url: string) => Promise<string>;
  /** Fetches bytes, honouring a byte range when the server supports it. */
  fetchBytes: (url: string, range?: { offset: number; length: number }) => Promise<Uint8Array>;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called whenever the job is written, so a listening popup can refresh. */
  onJobUpdated?: (progress: JobProgress) => void;
}
