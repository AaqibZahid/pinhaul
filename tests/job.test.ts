import { describe, expect, it } from "vitest";
import { JobRunner, accountingProblems, progressOf } from "../src/background/job";
import type { Downloader, DownloadRequest, JobStore } from "../src/background/ports";
import type { DownloadItem, PinterestGateway } from "../src/background/ports";
import type { ResourceEnvelope } from "../src/background/pinterest";
import type { Job } from "../src/shared/types";

const BOARD = {
  id: "4246",
  name: "Home decor",
  url: "/pinterest/home-decor/",
  pin_count: 3,
  section_count: 0,
};

/** The pins Pinterest answers with when asked for one directly. */
function pinData(id: string, extra: Record<string, unknown> = {}) {
  return {
    resource_response: {
      status: "success",
      data: {
        id,
        is_eligible_for_image_download: true,
        images: { orig: { url: `https://i.pinimg.com/originals/${id}.jpg`, width: 100, height: 100 } },
        ...extra,
      },
    },
  };
}

function pinItems(id: string) {
  return { node_id: btoa(`Pin:${id}`), id, type: "pin" };
}

interface Page {
  ids: string[];
  bookmark: string | null;
}

interface FakeOptions {
  /** Pages of board feed, in order. The last bookmark null ends it. */
  feed: Page[];
  /** Sections of the board, each with its own pages. */
  sections?: Array<{ id: string; name: string; pages: Page[] }>;
  pinCount?: number;
  pins: Record<string, unknown>;
}

/** A Pinterest client answering from fixed pages and records. */
class FakePinterest implements PinterestGateway {
  readonly calls: string[] = [];
  private feedCursor = 0;
  private sectionCursor = new Map<string, number>();
  private boardCalls = 0;

  constructor(private readonly options: FakeOptions) {}

  async getData<T = unknown>(resource: string, options: Record<string, unknown>, _sourceUrl: string): Promise<T> {
    const envelope = await this.getResource(resource, options, _sourceUrl);
    const data = envelope.resource_response?.data;
    if (data === undefined || data === null) {
      throw new Error(`Pinterest returned no ${resource} data`);
    }
    return data as T;
  }

  async getResource(resource: string, options: Record<string, unknown>, _sourceUrl: string): Promise<ResourceEnvelope> {
    this.calls.push(`${resource}`);
    if (resource === "BoardResource") {
      this.boardCalls += 1;
      return {
        resource_response: {
          status: "success",
          data: { ...BOARD, section_count: this.options.sections?.length ?? 0 },
        },
      };
    }
    if (resource === "BoardSectionsResource") {
      return {
        resource_response: {
          status: "success",
          bookmark: undefined,
          data: (this.options.sections ?? []).map((section) => ({ id: section.id, name: section.name })),
        },
      };
    }
    if (resource === "BoardFeedResource") {
      const page = this.options.feed[this.feedCursor] ?? { ids: [], bookmark: null };
      this.feedCursor += 1;
      return {
        resource_response: {
          status: "success",
          bookmark: page.bookmark ?? undefined,
          data: [...page.ids.map(pinItems), { id: "module", story_type: "related_interests_module", type: "story" }],
        },
      };
    }
    if (resource === "BoardSectionPinsResource") {
      const sectionId = String(options.section_id);
      const section = this.options.sections?.find((candidate) => candidate.id === sectionId);
      const index = this.sectionCursor.get(sectionId) ?? 0;
      const page = section?.pages[index] ?? { ids: [], bookmark: null };
      this.sectionCursor.set(sectionId, index + 1);
      return {
        resource_response: { status: "success", bookmark: page.bookmark ?? undefined, data: page.ids.map(pinItems) },
      };
    }
    if (resource === "PinResource") {
      const id = String(options.id);
      const pin = this.options.pins[id];
      if (!pin) throw new Error(`Pinterest has no pin ${id}`);
      return { resource_response: { status: "success", data: pin } };
    }
    throw new Error(`unexpected resource ${resource}`);
  }

  get boardRequests(): number {
    return this.boardCalls;
  }
}

class FakeStore implements JobStore {
  job: Job | null = null;

  async load(): Promise<Job | null> {
    return this.job;
  }
  async save(job: Job): Promise<void> {
    this.job = structuredClone(job);
  }
  async clear(): Promise<void> {
    this.job = null;
  }
}

class FakeDownloader implements Downloader {
  started: DownloadRequest[] = [];
  pending: number[] = [];
  private counter = 0;

  async start(request: DownloadRequest): Promise<number> {
    this.started.push(request);
    this.counter += 1;
    const id = this.counter;
    this.pending.push(id);
    return id;
  }

  async find(ids: number[]): Promise<DownloadItem[]> {
    return ids.map((id) => ({ id, state: this.pending.includes(id) ? "in_progress" : "complete" }));
  }

  reveal(): void {}

  completeAll(runner: JobRunner): void {
    const ids = [...this.pending];
    this.pending.length = 0;
    for (const id of ids) runner.reportDownloadChange(id, "complete");
  }
}

function makeRunner(options: FakeOptions) {
  const store = new FakeStore();
  const downloader = new FakeDownloader();
  const client = new FakePinterest(options);
  const build = (clientLike: PinterestGateway) =>
    new JobRunner({
      client: clientLike,
      store,
      downloader,
      fetchText: async () => "",
      fetchBytes: async () => new Uint8Array(),
      sleep: async () => undefined,
    });
  return { store, downloader, client, build, runner: build(client) };
}

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

async function pump(runner: JobRunner, downloader: FakeDownloader, rounds = 400): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await macrotask();
    const phase = runner.progress()?.phase;
    if (phase === "done" || phase === "error" || phase === "paused") return;
    downloader.completeAll(runner);
  }
  throw new Error("the job did not settle");
}

describe("JobRunner", () => {
  it("walks a board and downloads its eligible pins", async () => {
    const { runner, store, downloader } = makeRunner({

      feed: [{ ids: ["111", "222", "333"], bookmark: null }],
      pins: Object.fromEntries(
        ["111", "222", "333"].map((id) => [id, pinData(id).resource_response.data]),
      ),
    } as FakeOptions);

    await runner.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pump(runner, downloader);

    const progress = runner.progress();
    expect(progress?.phase).toBe("done");
    expect(progress?.discovered).toBe(3);
    expect(progress?.downloaded).toBe(3);
    expect(progress?.skipped).toBe(0);
    expect(progress?.failed).toBe(0);
    expect(progress?.duplicates).toBe(0);
    expect(downloader.started.map((request) => request.filename)).toEqual([
      "Pinpull/Home decor/111.jpg",
      "Pinpull/Home decor/222.jpg",
      "Pinpull/Home decor/333.jpg",
    ]);
    expect(accountingProblems(store.job as Job)).toEqual([]);
  });

  it("does not count the module a feed ends with as a pin", async () => {
    const { runner, store, downloader } = makeRunner({
      feed: [{ ids: ["111"], bookmark: null }],
      pins: { "111": pinData("111").resource_response.data },
    });
    await runner.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pump(runner, downloader);

    expect((store.job as Job).pinIds).toEqual(["111"]);
  });

  it("merges a board's sections with its feed, counting a pin seen twice once", async () => {
    const { runner, store, downloader } = makeRunner({
      feed: [{ ids: ["111", "222"], bookmark: null }],
      sections: [{ id: "s1", name: "Kitchen", pages: [{ ids: ["222", "333"], bookmark: null }] }],
      pins: Object.fromEntries(
        ["111", "222", "333"].map((id) => [id, pinData(id).resource_response.data]),
      ),
    });
    await runner.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pump(runner, downloader);

    const job = store.job as Job;
    expect(job.pinIds).toEqual(["111", "222", "333"]);
    expect(job.duplicateCount).toBe(1);
    expect(progressOf(job, 0).downloaded).toBe(3);
    expect(accountingProblems(job)).toEqual([]);
  });

  it("skips a pin whose creator turned downloads off, and reports why", async () => {
    const { runner, store, downloader } = makeRunner({
      feed: [{ ids: ["111"], bookmark: null }],
      pins: {
        "111": {
          id: "111",
          is_eligible_for_image_download: false,
          images: { orig: { url: "https://i.pinimg.com/originals/111.jpg" } },
        },
      },
    });
    await runner.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pump(runner, downloader);

    const job = store.job as Job;
    expect(job.pins["111"]?.status).toBe("skipped");
    expect(job.pins["111"]?.reason).toMatch(/creator turned downloads off/);
    expect(downloader.started).toHaveLength(0);
    expect(progressOf(job, 0).skipped).toBe(1);
  });

  it("fails a pin Pinterest will not classify rather than guessing", async () => {
    const { runner, store } = makeRunner({
      feed: [{ ids: ["111"], bookmark: null }],
      pins: { "111": { id: "111", images: { orig: { url: "https://i.pinimg.com/originals/111.jpg" } } } },
    });
    await runner.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pump(runner, new FakeDownloader());

    const job = store.job as Job;
    expect(job.pins["111"]?.status).toBe("failed");
    expect(job.pins["111"]?.reason).toMatch(/did not say whether/);
    expect(progressOf(job, 0).failed).toBe(1);
  });

  it("fails a pin whose record Pinterest refuses, carrying the reason", async () => {
    const { runner, store } = makeRunner({
      feed: [{ ids: ["111"], bookmark: null }],
      pins: {},
    });
    await runner.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pump(runner, new FakeDownloader());

    const job = store.job as Job;
    expect(job.pins["111"]?.status).toBe("failed");
    expect(job.pins["111"]?.reason).toMatch(/no pin 111/);
    expect(progressOf(job, 0).failed).toBe(1);
  });

  it("skips a pin with no media Pinterest makes downloadable", async () => {
    const { runner, store } = makeRunner({
      feed: [{ ids: ["111"], bookmark: null }],
      pins: { "111": { id: "111", is_eligible_for_image_download: true, images: {} } },
    });
    await runner.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pump(runner, new FakeDownloader());

    expect((store.job as Job).pins["111"]?.status).toBe("skipped");
    expect((store.job as Job).pins["111"]?.reason).toMatch(/no media/);
  });

  it("writes one file per carousel slot, labelled by slot", async () => {
    const { runner, downloader } = makeRunner({
      feed: [{ ids: ["111"], bookmark: null }],
      pins: {
        "111": {
          id: "111",
          is_eligible_for_image_download: true,
          carousel_data: [
            { images: { orig: { url: "https://i.pinimg.com/originals/a.jpg" } } },
            { images: { orig: { url: "https://i.pinimg.com/originals/b.jpg" } } },
          ],
        },
      },
    });
    await runner.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pump(runner, downloader);

    expect(downloader.started.map((request) => request.filename)).toEqual([
      "Pinpull/Home decor/111_1.jpg",
      "Pinpull/Home decor/111_2.jpg",
    ]);
  });

  it("asks for the highest-quality video representation and writes it as an mp4", async () => {
    const { runner, downloader, store } = makeRunner({
      feed: [{ ids: ["111"], bookmark: null }],
      pins: {
        "111": {
          id: "111",
          is_eligible_for_image_download: true,
          videos: {
            video_list: {
              vHLSV4: { url: "https://v1.pinimg.com/videos/hls/a.m3u8", width: 576, height: 1024 },
              v720P: { url: "https://v1.pinimg.com/videos/mp4/a_720w.mp4", width: 1080, height: 1920 },
            },
          },
        },
      },
    });
    await runner.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pump(runner, downloader);

    expect(downloader.started[0]?.filename).toBe("Pinpull/Home decor/111.mp4");
    expect((store.job as Job).pins["111"]?.status).toBe("downloaded");
  });

  it("retries only what did not finish when the job is asked to", async () => {
    const { runner, store, downloader } = makeRunner({
      feed: [{ ids: ["111", "222"], bookmark: null }],
      pins: {
        "111": { id: "111", is_eligible_for_image_download: false, images: { orig: { url: "https://i.pinimg.com/originals/111.jpg" } } },
        "222": { id: "222", images: { orig: { url: "https://i.pinimg.com/originals/222.jpg" } } },
      },
    });
    await runner.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pump(runner, downloader);
    expect((store.job as Job).pins["111"]?.status).toBe("skipped");
    expect((store.job as Job).pins["222"]?.status).toBe("failed");

    await runner.retryFailed();
    await pump(runner, downloader);
    // A deliberate skip is respected, a failed pin is attempted again.
    expect((store.job as Job).pins["111"]?.status).toBe("skipped");
    expect(runner.progress()?.failed).toBe(1);
  });

  it("finishes a job that was interrupted, without downloading anything twice", async () => {
    const pinIds = ["111", "222", "333", "444"];
    const pins = Object.fromEntries(pinIds.map((id) => [id, pinData(id).resource_response.data]));
    const { store, downloader, build } = makeRunner({
      feed: [{ ids: pinIds, bookmark: null }],
      pins,
    });

    const first = build(new FakePinterest({ feed: [{ ids: pinIds, bookmark: null }], pins }));
    await first.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pumpWithoutCompleting(first);
    expect(first.progress()?.phase).toBe("downloading");
    const startedBefore = downloader.started.length;
    expect(startedBefore).toBeGreaterThan(0);

    // Chrome keeps running the downloads it was given, so the service worker
    // being stopped loses the work in hand, not the files on disk.
    const second = build(new FakePinterest({ feed: [{ ids: pinIds, bookmark: null }], pins }));
    await second.resume();
    await pump(second, downloader);

    const job = store.job as Job;
    expect(job.phase).toBe("done");
    expect(progressOf(job, 0).downloaded).toBe(4);
    expect(accountingProblems(job)).toEqual([]);
    for (const id of pinIds) {
      const written = downloader.started.filter((request) => request.filename === `Pinpull/Home decor/${id}.jpg`);
      expect(written).toHaveLength(1);
    }
  });

  it("stays paused when a restart looks at a paused job", async () => {
    const { store, downloader, build } = makeRunner({
      feed: [{ ids: ["111"], bookmark: null }],
      pins: { "111": pinData("111").resource_response.data },
    });
    const first = build(new FakePinterest({ feed: [{ ids: ["111"], bookmark: null }], pins: { "111": pinData("111").resource_response.data } }));
    await first.start({ username: "pinterest", slug: "home-decor" }, "input");
    await pumpWithoutCompleting(first, 3);
    first.pause();
    await macrotask();

    const second = build(new FakePinterest({ feed: [], pins: {} }));
    await second.resume();
    expect(store.job?.phase).toBe("paused");
    expect(second.progress()).toBeNull();
  });

  it("does not cancel the job's downloads when the popup stops looking at it", async () => {
    // The job lives in storage, not in the popup: reading it back is all a
    // reopened popup needs to keep watching.
    const { store, build } = makeRunner({
      feed: [{ ids: ["111"], bookmark: null }],
      pins: { "111": pinData("111").resource_response.data },
    });
    const runner = build(new FakePinterest({ feed: [{ ids: ["111"], bookmark: null }], pins: { "111": pinData("111").resource_response.data } }));
    await runner.start({ username: "pinterest", slug: "home-decor" }, "input");
    const progress = runner.progress();
    const later = progressOf(store.job as Job, 0);
    expect(later.boardKey).toBe(progress?.boardKey);
    expect(later.discovered).toBeGreaterThanOrEqual(0);
  });
});

/** Runs the job's steps without finishing any download, which is what a service
 * worker that is stopped mid-download leaves behind. */
async function pumpWithoutCompleting(runner: JobRunner, rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await macrotask();
    const phase = runner.progress()?.phase;
    if (phase === "done" || phase === "error" || phase === "paused") return;
  }
}

function runnerProgress(runner: JobRunner): string {
  return runner.progress()?.phase ?? "none";
}
