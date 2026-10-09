import { describe, expect, it } from "vitest";
import feedPage from "./fixtures/feed-page.json" with { type: "json" };
import videoPin from "./fixtures/video-pin.json" with { type: "json" };
import pinDetail from "./fixtures/pin-detail.json" with { type: "json" };
import { eligibilityOf, isPinItem, mediaItemsOf, nextBookmark, pinIdOf } from "../src/shared/pins";

function urls(items: ReturnType<typeof mediaItemsOf>): string[] {
  return items.map((item) => item.url);
}

describe("pinIdOf", () => {
  it("decodes a node_id", () => {
    expect(pinIdOf({ node_id: "UGluOjExMzYwMzMwNzQ3OTA4NTU3NDk=" })).toBe("1136033074790855749");
  });

  it("falls back to a plain id", () => {
    expect(pinIdOf({ id: "42" })).toBe("42");
    expect(pinIdOf({ id: 42 })).toBe("42");
  });

  it("has no id to offer for a module or an empty record", () => {
    expect(pinIdOf({ id: "" })).toBeNull();
    expect(pinIdOf({ node_id: "not base64!!" })).toBeNull();
    expect(pinIdOf({ node_id: "dGVzdA==" })).toBeNull();
    expect(pinIdOf(null)).toBeNull();
  });
});

describe("isPinItem", () => {
  it("recognises a pin from the live feed fixture", () => {
    expect(isPinItem(feedPage.resource_response.data[0])).toBe(true);
  });

  it("does not count a module the feed ends with", () => {
    const module = feedPage.resource_response.data[3];
    expect(isPinItem(module)).toBe(false);
  });

  it("counts a pin that names itself without a node_id", () => {
    expect(isPinItem({ id: "1", type: "pin" })).toBe(true);
    expect(isPinItem({ id: "1", images: {} })).toBe(true);
    expect(isPinItem({ id: "1" })).toBe(false);
  });
});

describe("eligibilityOf", () => {
  it("has three states", () => {
    expect(eligibilityOf({ is_eligible_for_image_download: true })).toBe("eligible");
    expect(eligibilityOf({ is_eligible_for_image_download: false })).toBe("ineligible");
    expect(eligibilityOf({})).toBe("unknown");
    expect(eligibilityOf({ is_eligible_for_image_download: "true" })).toBe("unknown");
  });

  it("reads the camelCase a pin page reports", () => {
    expect(eligibilityOf({ isEligibleForImageDownload: true })).toBe("eligible");
    expect(eligibilityOf({ isEligibleForImageDownload: false })).toBe("ineligible");
    expect(eligibilityOf({ isEligibleForImageDownload: null })).toBe("unknown");
  });

  it("reads the live fixture", () => {
    expect(eligibilityOf(pinDetail)).toBe("eligible");
  });
});

describe("mediaItemsOf", () => {
  it("prefers the original image on the live fixture", () => {
    expect(urls(mediaItemsOf(pinDetail))).toEqual([
      "https://i.pinimg.com/originals/4c/90/fb/4c90fb11eaf57db4804c91cc4d8982fc.jpg",
    ]);
  });

  it("takes the largest variant when there is no original", () => {
    const items = mediaItemsOf({
      images: {
        "60x60": { url: "https://x/t.jpg", width: 60, height: 60 },
        "736x": { url: "https://x/m.jpg", width: 736, height: 1110 },
      },
    });
    expect(urls(items)).toEqual(["https://x/m.jpg"]);
  });

  it("falls back to the variant key when the record carries no size", () => {
    const items = mediaItemsOf({
      images: { "170x": { url: "https://x/170.jpg" }, "550x": { url: "https://x/550.jpg" } },
    });
    expect(urls(items)).toEqual(["https://x/550.jpg"]);
  });

  it("keeps the original even when a variant is bigger", () => {
    const items = mediaItemsOf({
      images: { orig: { url: "https://x/o.png", width: 10 }, "736x": { url: "https://x/b.png", width: 4000 } },
    });
    expect(urls(items)).toEqual(["https://x/o.png"]);
  });

  it("takes one image per carousel slot, in order", () => {
    const items = mediaItemsOf({
      carousel_data: [
        { images: { orig: { url: "https://x/1.png" } } },
        { images: { orig: { url: "https://x/2.png" } } },
        { images: { orig: { url: "https://x/3.png" } } },
      ],
    });
    expect(urls(items)).toEqual(["https://x/1.png", "https://x/2.png", "https://x/3.png"]);
    expect(items.map((item) => item.label)).toEqual(["1", "2", "3"]);
  });

  it("drops a slot without usable media and keeps the slot numbering", () => {
    const items = mediaItemsOf({
      carousel_data: [
        { images: { orig: { url: "https://x/1.png" } } },
        { images: null },
        { images: { orig: { url: "https://x/4.png" } } },
      ],
    });
    expect(urls(items)).toEqual(["https://x/1.png", "https://x/4.png"]);
    expect(items.map((item) => item.label)).toEqual(["1", "3"]);
  });

  it("unwraps relay-shaped carousel slots", () => {
    const items = mediaItemsOf({
      carouselData: {
        carouselSlots: [
          { images: { orig: { url: "https://x/1.png" } } },
          { images: { orig: { url: "https://x/2.png" } } },
        ],
      },
    });
    expect(urls(items)).toEqual(["https://x/1.png", "https://x/2.png"]);
  });

  it("picks a direct mp4 over an equal hls rendition", () => {
    const items = mediaItemsOf(videoPin);
    expect(urls(items)).toEqual(["https://v1.pinimg.com/videos/iht/6b/3e/expMp4/a_720w.mp4"]);
    expect(items[0]?.kind).toBe("video");
  });

  it("picks hls when it is the higher rendition", () => {
    const items = mediaItemsOf({
      videos: {
        video_list: {
          vHLSV4: { url: "https://v1.pinimg.com/videos/ht/hls/a.m3u8", width: 1080, height: 1920 },
          v720P: { url: "https://v1.pinimg.com/videos/ht/mp4/a_720w.mp4", width: 576, height: 1024 },
        },
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("hls");
  });

  it("finds a video inside a story page block", () => {
    const items = mediaItemsOf({
      story_pin_data: {
        pages: [
          {
            blocks: [
              {
                videoDataV2: {
                  videoList: { vHLSV3MOBILE: { url: "https://v1.pinimg.com/videos/iht/hls/6b/a.m3u8", width: 576, height: 1024 } },
                  videoList720P: { v720P: { url: "https://v1.pinimg.com/videos/iht/expMp4/6b/a_720w.mp4", width: 576, height: 1024 } },
                },
              },
            ],
          },
        ],
      },
    });
    expect(urls(items)).toEqual(["https://v1.pinimg.com/videos/iht/expMp4/6b/a_720w.mp4"]);
  });

  it("takes one image per story page and skips a page that plays a video", () => {
    const items = mediaItemsOf({
      story_pin_data: {
        pages: [
          {
            blocks: [{ videoDataV2: { videoList: { v720P: { url: "https://x/a.mp4" } } } }],
            images_orig: { url: "https://x/poster.png" },
          },
          { images_originals: { url: "https://x/page2.png" } },
        ],
      },
    });
    expect(urls(items)).toEqual(["https://x/a.mp4"]);
  });

  it("reads a story page image that sits on the block itself", () => {
    const items = mediaItemsOf({
      storyPinData: {
        pages: [
          {
            blocks: [
              {
                __typename: "StoryPinImageBlock",
                images_750x: { url: "https://i.pinimg.com/736x/a/b.jpg", width: 480, height: 600 },
              },
            ],
          },
        ],
      },
    });
    expect(urls(items)).toEqual(["https://i.pinimg.com/736x/a/b.jpg"]);
  });

  it("keeps the largest of a page split over several blocks", () => {
    const items = mediaItemsOf({
      story_pin_data: {
        pages: [
          {
            blocks: [
              { images_750x: { url: "https://x/small.jpg", width: 480, height: 600 } },
              { images_orig: { url: "https://x/big.jpg", width: 1500, height: 2000 } },
            ],
          },
        ],
      },
    });
    expect(urls(items)).toEqual(["https://x/big.jpg"]);
  });

  it("ignores a thumbnail-only block", () => {
    expect(mediaItemsOf({ story_pin_data: { pages: [{ blocks: [{ images_60x60: { url: "https://x/t.jpg" } }] }] } })).toEqual([]);
  });

  it("does not treat a partial video variant as a rendition", () => {
    const items = mediaItemsOf({
      videos: { video_list: { vHLSV3MOBILE: { duration: 15000 }, vHLSV4: { __typename: "VideoDetail" } } },
      images: { orig: { url: "https://x/cover.png" } },
    });
    expect(urls(items)).toEqual(["https://x/cover.png"]);
  });

  it("yields nothing for a pin with no media", () => {
    expect(mediaItemsOf({ id: "1" })).toEqual([]);
    expect(mediaItemsOf({ id: "1", images: null })).toEqual([]);
  });

  it("makes a relative image URL absolute", () => {
    const items = mediaItemsOf({ story_pin_data: { pages: [{ images_orig: { url: "/originals/a.png" } }] } });
    expect(urls(items)).toEqual(["https://www.pinterest.com/originals/a.png"]);
  });
});

describe("nextBookmark", () => {
  it("stops on empty, on -end-, and on the encoded none", () => {
    expect(nextBookmark({ resource_response: { bookmark: "" } }, null)).toBeNull();
    expect(nextBookmark({ resource_response: { bookmark: "-end-" } }, null)).toBeNull();
    expect(nextBookmark({ resource_response: { bookmark: "Y2JOb25lOrest" } }, null)).toBeNull();
  });

  it("stops when the cursor repeats", () => {
    const doc = { resource_response: { bookmark: "abc" } };
    expect(nextBookmark(doc, null)).toBe("abc");
    expect(nextBookmark(doc, "abc")).toBeNull();
  });

  it("returns null when there is no cursor at all", () => {
    expect(nextBookmark({ resource_response: {} }, null)).toBeNull();
    expect(nextBookmark({}, null)).toBeNull();
    expect(nextBookmark(null, null)).toBeNull();
  });
});
