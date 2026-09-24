// The download transform (presio.deck.onExport): every slide's strokes drawn
// into its page as vector paths, the same curves as on screen.

import { LineCapStyle, PDFDocument, rgb } from "pdf-lib";
import { opacityOf, REFERENCE_WIDTH, type Drawing } from "./model";

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}

/** A stroke as an SVG path in page units (y down from the top), like tracePath. */
function svgPath(p: number[], w: number, h: number): string {
  const n = p.length >> 1;
  const f = (v: number) => v.toFixed(2);
  const parts = [`M ${f(p[0] * w)} ${f(p[1] * h)}`];
  if (n === 1) parts.push(`L ${f(p[0] * w)} ${f(p[1] * h)}`);
  for (let i = 1; i < n - 1; i++) {
    const x = p[2 * i] * w;
    const y = p[2 * i + 1] * h;
    parts.push(`Q ${f(x)} ${f(y)} ${f((x + p[2 * i + 2] * w) / 2)} ${f((y + p[2 * i + 3] * h) / 2)}`);
  }
  if (n > 1) parts.push(`L ${f(p[2 * n - 2] * w)} ${f(p[2 * n - 1] * h)}`);
  return parts.join(" ");
}

export async function bakeDrawing(bytes: Uint8Array, drawing: Drawing): Promise<Uint8Array> {
  const slides = drawing.drawnSlides();
  if (!slides.length) return bytes;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  for (const slide of slides) {
    const page = pages[slide - 1];
    if (!page) continue;
    // Points are fractions of what's shown of the page: its crop box.
    const crop = page.getCropBox();
    for (const stroke of drawing.strokes(slide)) {
      // drawSvgPath reads y downward from the origin given: the box's top-left.
      page.drawSvgPath(svgPath(stroke.points, crop.width, crop.height), {
        x: crop.x,
        y: crop.y + crop.height,
        borderColor: hexToRgb(stroke.color),
        borderWidth: Math.max(0.5, (stroke.width / REFERENCE_WIDTH) * crop.width),
        borderOpacity: opacityOf(stroke),
        borderLineCap: LineCapStyle.Round,
      });
    }
  }
  return doc.save();
}
