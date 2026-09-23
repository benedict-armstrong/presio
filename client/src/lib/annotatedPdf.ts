import { PDFDocument, LineCapStyle, rgb } from "pdf-lib";
import type { AnnotationsBySlide, Stroke } from "./annotations";

function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}

function strokeToSvgPath(stroke: Stroke, width: number, height: number): string {
  const pts = stroke.points;
  const parts = [`M ${(pts[0] * width).toFixed(2)} ${(pts[1] * height).toFixed(2)}`];
  // A tap (single point) still needs a segment for the round caps to show.
  if (pts.length === 2) parts.push(`L ${(pts[0] * width).toFixed(2)} ${(pts[1] * height).toFixed(2)}`);
  for (let i = 2; i < pts.length; i += 2) {
    parts.push(`L ${(pts[i] * width).toFixed(2)} ${(pts[i + 1] * height).toFixed(2)}`);
  }
  return parts.join(" ");
}

function dataUrlBytes(src: string): Uint8Array | null {
  const comma = src.indexOf(",");
  if (!src.startsWith("data:image/") || comma < 0) return null;
  return Uint8Array.from(atob(src.slice(comma + 1)), (c) => c.charCodeAt(0));
}

// Burn the drawn strokes into the PDF pages and return the new document bytes.
export async function renderAnnotatedPdf(
  pdfBytes: Uint8Array,
  annotations: AnnotationsBySlide
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();
  for (const [key, strokes] of Object.entries(annotations)) {
    const page = pages[parseInt(key, 10) - 1];
    if (!page || !strokes.length) continue;
    const { width, height } = page.getSize();
    for (const stroke of strokes) {
      if (stroke.tool === "image") {
        const [l, t, r, b] = stroke.points;
        const bytes = dataUrlBytes(stroke.src ?? "");
        if (!bytes || stroke.points.length !== 4) continue;
        const image = stroke.src!.startsWith("data:image/png") ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        // PDF space is y-up from the bottom-left corner.
        page.drawImage(image, { x: l * width, y: height - b * height, width: (r - l) * width, height: (b - t) * height, opacity: stroke.opacity });
        continue;
      }
      if (stroke.points.length < 2) continue;
      // drawSvgPath interprets coordinates y-down from the given origin, which
      // matches our normalized top-left space when anchored at the page top.
      page.drawSvgPath(strokeToSvgPath(stroke, width, height), {
        x: 0,
        y: height,
        borderColor: hexToRgb(stroke.color),
        borderWidth: Math.max(0.5, stroke.size * width),
        borderOpacity: stroke.opacity,
        borderLineCap: LineCapStyle.Round,
      });
    }
  }
  return doc.save();
}
