import { newStrokeId, type Stroke } from "@/lib/annotations";

// Pasted images travel over the socket and live in localStorage with the rest
// of the drawings, so they are downscaled and re-encoded to stay small. The
// server enforces the same cap.
export const MAX_IMAGE_SRC_CHARS = 600_000;
const MAX_DIM = 1600;
// A new image fills at most this fraction of the slide in either direction.
const PLACE_FRACTION = 0.5;

async function encode(bitmap: ImageBitmap, scale: number, type: "image/png" | "image/jpeg"): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  if (type === "image/jpeg") {
    // JPEG has no alpha: put transparent areas on white, not black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(type, 0.85);
}

// Turn an image file/blob into an image stroke centered on the slide.
// `aspect` is the slide's width / height.
export async function imageToStroke(blob: Blob, aspect: number): Promise<Stroke> {
  const bitmap = await createImageBitmap(blob);
  try {
    let scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    let src = await encode(bitmap, scale, "image/png");
    while (src.length > MAX_IMAGE_SRC_CHARS && scale > 0.05) {
      src = await encode(bitmap, scale, "image/jpeg");
      if (src.length > MAX_IMAGE_SRC_CHARS) scale *= 0.7;
    }
    if (src.length > MAX_IMAGE_SRC_CHARS) throw new Error("Image is too large");

    // Box in normalized slide units: width is a fraction of the slide width,
    // height a fraction of its height, so the pixel ratio needs the aspect.
    const imgRatio = bitmap.height / bitmap.width;
    let w = PLACE_FRACTION;
    let h = w * imgRatio * aspect;
    if (h > PLACE_FRACTION) {
      w *= PLACE_FRACTION / h;
      h = PLACE_FRACTION;
    }
    const left = (1 - w) / 2;
    const top = (1 - h) / 2;
    return {
      id: newStrokeId(),
      tool: "image",
      src,
      color: "#000000",
      size: 0.001,
      opacity: 1,
      points: [left, top, left + w, top + h],
    };
  } finally {
    bitmap.close();
  }
}

// The first image on the clipboard, if the browser lets us read it.
export async function readClipboardImage(): Promise<Blob | null> {
  if (!navigator.clipboard?.read) return null;
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) return await item.getType(type);
    }
  } catch {
    // Permission denied or nothing readable.
  }
  return null;
}
