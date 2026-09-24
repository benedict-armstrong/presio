// The download transform (presio.deck.onExport): bake each item's poster onto
// its page, and link embeds and web media to where they play, so the PDF shows
// its media in any viewer — not a blank box or a bare watch URL.

import {
  clip,
  endPath,
  PDFDocument,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import type { Placement, Placements } from "./placements";
import { poster } from "./posters";

export async function bakeMedia(bytes: Uint8Array, placements: Placements): Promise<Uint8Array> {
  if (!placements.size) return bytes;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  for (const list of placements.values()) {
    for (const p of list) {
      const page = pages[p.slide - 1];
      if (!page) continue;
      const crop = page.getCropBox();
      // Placements are top-left fractions; PDF space starts bottom-left.
      const rect = {
        x: crop.x + p.x * crop.width,
        y: crop.y + (1 - p.y - p.h) * crop.height,
        width: p.w * crop.width,
        height: p.h * crop.height,
      };
      const image = await posterImage(doc, p);
      if (image) drawCover(page, image, rect);
      // Web media without a poster gets a stand-in, so the link has
      // something to be clicked on.
      else if (p.url) drawPlaceholder(page, rect);
      if (p.url) addLink(doc, page, rect, p.url);
    }
  }
  return doc.save();
}

type Rect = { x: number; y: number; width: number; height: number };

/** Fill the box with the image, cropped to it (like object-fit: cover). */
function drawCover(page: PDFPage, image: PDFImage, r: Rect) {
  const scale = Math.max(r.width / image.width, r.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  page.pushOperators(pushGraphicsState(), rectangle(r.x, r.y, r.width, r.height), clip(), endPath());
  page.drawImage(image, { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height });
  page.pushOperators(popGraphicsState());
}

function drawPlaceholder(page: PDFPage, r: Rect) {
  page.drawRectangle({ ...r, color: rgb(0.1, 0.1, 0.1) });
  const size = Math.min(r.width, r.height) * 0.25;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  // A play triangle. SVG paths run top-down, from the point given as origin.
  page.drawSvgPath(`M 0 0 L ${size} ${size / 2} L 0 ${size} Z`, {
    x: cx - size / 3,
    y: cy + size / 2,
    color: rgb(1, 1, 1),
  });
}

function addLink(doc: PDFDocument, page: PDFPage, r: Rect, url: string) {
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
    Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
  });
  page.node.addAnnot(doc.context.register(annot));
}

async function posterImage(doc: PDFDocument, p: Placement): Promise<PDFImage | null> {
  const url = await poster(p);
  if (!url) return null;
  const bytes = await imageBytes(url);
  if (!bytes) return null;
  try {
    return bytes.type === "jpg" ? await doc.embedJpg(bytes.data) : await doc.embedPng(bytes.data);
  } catch {
    return null;
  }
}

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

/** An image as PNG or JPEG bytes, the two a PDF embeds directly. */
async function imageBytes(url: string): Promise<{ type: "png" | "jpg"; data: Uint8Array } | null> {
  try {
    const blob = await (await fetch(url)).blob();
    const data = new Uint8Array(await blob.arrayBuffer());
    if (isPng(data)) return { type: "png", data };
    if (isJpg(data)) return { type: "jpg", data };
    // Anything else (WebP, a GIF) goes through a canvas.
    const bitmap = await createImageBitmap(blob);
    return { type: "png", data: await canvasPng(bitmap, bitmap.width, bitmap.height) };
  } catch {
    // Not readable with fetch (no CORS): an <img> may still be allowed.
    return new Promise((done) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () =>
        canvasPng(img, img.naturalWidth, img.naturalHeight).then((data) => done({ type: "png", data }), () => done(null));
      img.onerror = () => done(null);
      img.src = url;
    });
  }
}

async function canvasPng(source: CanvasImageSource, width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(source, 0, 0);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
  if (!blob) throw new Error("Couldn't encode the image");
  return new Uint8Array(await blob.arrayBuffer());
}
