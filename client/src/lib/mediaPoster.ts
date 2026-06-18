import type { MediaPlacement } from "./pdf";

// Resolves a static preview image ("poster") for a media placement, used to
// fill in the otherwise-blank media boxes in slide thumbnails / previews.
// URL-sourced embeds (YouTube/Vimeo) have no frame baked into the PDF, so we
// fetch their poster; local gif/image media can preview from its own blob.
// Video files and arbitrary URL videos return null (no cheap poster).

const posterCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(p: MediaPlacement): string {
  return `${p.kind}:${p.videoId ?? p.blobUrl}`;
}

async function fetchVimeoThumb(id: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}`
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { thumbnail_url?: unknown };
    return typeof data.thumbnail_url === "string" ? data.thumbnail_url : null;
  } catch {
    return null;
  }
}

// Draw the first frame of an image (e.g. a gif) onto a canvas and return a
// static data URL, so animated gifs don't loop distractingly in thumbnails.
// Falls back to the original URL if the source taints the canvas (cross-origin).
function freezeFirstFrame(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || 1;
        canvas.height = img.naturalHeight || 1;
        canvas.getContext("2d")!.drawImage(img, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(url);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function resolve(p: MediaPlacement): Promise<string | null> {
  if (p.kind === "youtube" && p.videoId) {
    // hqdefault always exists; maxresdefault isn't guaranteed.
    return Promise.resolve(`https://img.youtube.com/vi/${p.videoId}/hqdefault.jpg`);
  }
  if (p.kind === "vimeo" && p.videoId) {
    return fetchVimeoThumb(p.videoId);
  }
  // Gifs: freeze to the first frame so the thumbnail strip stays still.
  if (p.mime === "image/gif") {
    return freezeFirstFrame(p.blobUrl);
  }
  // Other (non-animated) images can preview directly.
  if (p.mime.startsWith("image/")) {
    return Promise.resolve(p.blobUrl);
  }
  return Promise.resolve(null);
}

export function getMediaPoster(p: MediaPlacement): Promise<string | null> {
  const key = cacheKey(p);
  if (posterCache.has(key)) return Promise.resolve(posterCache.get(key)!);
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = resolve(p)
    .then((url) => {
      posterCache.set(key, url);
      inflight.delete(key);
      return url;
    })
    .catch(() => {
      posterCache.set(key, null);
      inflight.delete(key);
      return null;
    });
  inflight.set(key, promise);
  return promise;
}
