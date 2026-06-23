// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getMediaPoster } from "./mediaPoster";
import type { MediaPlacement } from "./pdf";

// Minimal MediaPlacement factory — only the fields getMediaPoster reads matter.
function placement(over: Partial<MediaPlacement>): MediaPlacement {
  return {
    slide: 1,
    id: Math.random().toString(36).slice(2),
    kind: "file",
    mime: "",
    xPct: 0,
    yPct: 0,
    wPct: 0,
    hPct: 0,
    autoplay: false,
    loop: false,
    blobUrl: "",
    ...over,
  };
}

describe("getMediaPoster", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("builds a YouTube hqdefault thumbnail URL", async () => {
    const p = placement({ kind: "youtube", videoId: "abc123" });
    await expect(getMediaPoster(p)).resolves.toBe(
      "https://img.youtube.com/vi/abc123/hqdefault.jpg"
    );
  });

  it("returns the blob URL directly for non-gif images", async () => {
    const p = placement({ mime: "image/png", blobUrl: "blob:img" });
    await expect(getMediaPoster(p)).resolves.toBe("blob:img");
  });

  it("returns null for video files (no cheap poster)", async () => {
    const p = placement({ mime: "video/mp4", blobUrl: "blob:vid" });
    await expect(getMediaPoster(p)).resolves.toBeNull();
  });

  it("fetches a Vimeo thumbnail via oEmbed", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ thumbnail_url: "https://i.vimeo/x.jpg" }), {
          status: 200,
        })
      );
    const p = placement({ kind: "vimeo", videoId: "999" });
    await expect(getMediaPoster(p)).resolves.toBe("https://i.vimeo/x.jpg");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("caches results and dedupes in-flight requests for the same key", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ thumbnail_url: "https://i.vimeo/y.jpg" }), {
          status: 200,
        })
      );
    const p = placement({ kind: "vimeo", videoId: "dedupe-key" });
    // Concurrent calls share one fetch; a later call hits the cache.
    const [a, b] = await Promise.all([getMediaPoster(p), getMediaPoster(p)]);
    const c = await getMediaPoster(placement({ kind: "vimeo", videoId: "dedupe-key" }));
    expect(a).toBe("https://i.vimeo/y.jpg");
    expect(b).toBe("https://i.vimeo/y.jpg");
    expect(c).toBe("https://i.vimeo/y.jpg");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
