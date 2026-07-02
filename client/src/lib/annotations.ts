// Shared types and geometry helpers for the slide annotation layer (laser
// pointer, drawing tools). Coordinates are normalized to the *slide content
// rect* — the letterboxed area the PDF page actually occupies inside its
// container — so a point means the same spot on every screen size.

export type Tool = "none" | "laser" | "pen";

export interface LaserPoint {
  x: number;
  y: number;
}

// A single drawn stroke. `points` is a flat [x0, y0, x1, y1, …] list of
// normalized coordinates; `size` is the stroke width as a fraction of the
// slide width so it scales with the rendered size.
export interface Stroke {
  tool: "pen" | "highlighter";
  color: string;
  size: number;
  opacity: number;
  points: number[];
}

export type AnnotationsBySlide = Record<number, Stroke[]>;

export interface PenStyle {
  color: string;
  size: number;
}

// Pen widths are picked in "pixels at a 960px-wide slide" for intuition, then
// stored as a fraction of the slide width.
export const PEN_REFERENCE_WIDTH = 960;
export const DEFAULT_PEN_STYLE: PenStyle = { color: "#e11d48", size: 3 / PEN_REFERENCE_WIDTH };

export const PEN_COLORS = ["#111111", "#e11d48", "#2563eb", "#16a34a", "#f59e0b", "#9333ea"];

export interface ContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Contain-fit a page of the given aspect ratio (w/h) into a container box,
// centered — mirroring what `object-fit: contain` does to the slide canvas.
export function contentRectFor(
  containerWidth: number,
  containerHeight: number,
  aspect: number
): ContentRect {
  if (containerWidth <= 0 || containerHeight <= 0 || !Number.isFinite(aspect) || aspect <= 0) {
    return { left: 0, top: 0, width: containerWidth, height: containerHeight };
  }
  const width = Math.min(containerWidth, containerHeight * aspect);
  const height = width / aspect;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  };
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// Paint strokes onto a 2D context whose CSS size is width×height (the caller
// handles devicePixelRatio scaling).
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: readonly Stroke[],
  width: number,
  height: number
) {
  for (const stroke of strokes) {
    const pts = stroke.points;
    if (pts.length < 2) continue;
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.globalAlpha = stroke.opacity;
    ctx.lineWidth = Math.max(1, stroke.size * width);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.moveTo(pts[0] * width, pts[1] * height);
    if (pts.length === 2) {
      // A tap: draw a dot by stroking a zero-length segment (round caps).
      ctx.lineTo(pts[0] * width, pts[1] * height);
    }
    for (let i = 2; i < pts.length; i += 2) {
      ctx.lineTo(pts[i] * width, pts[i + 1] * height);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Serialized "drawing file" format for saving/loading annotations separately
// from the PDF.
export interface DrawingFile {
  format: "presio-drawing";
  version: 1;
  annotations: AnnotationsBySlide;
}

export function serializeDrawing(annotations: AnnotationsBySlide): string {
  const file: DrawingFile = { format: "presio-drawing", version: 1, annotations };
  return JSON.stringify(file, null, 2);
}

// Parse and structurally validate a drawing file. Throws with a friendly
// message on anything malformed.
export function parseDrawing(text: string): AnnotationsBySlide {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not a valid drawing file (invalid JSON)");
  }
  const file = raw as Partial<DrawingFile>;
  if (file?.format !== "presio-drawing" || typeof file.annotations !== "object" || !file.annotations) {
    throw new Error("Not a Presio drawing file");
  }
  const result: AnnotationsBySlide = {};
  for (const [key, strokes] of Object.entries(file.annotations)) {
    const slide = parseInt(key, 10);
    if (!Number.isInteger(slide) || slide < 1 || !Array.isArray(strokes)) continue;
    const clean = strokes.filter(
      (s: Stroke) =>
        s &&
        (s.tool === "pen" || s.tool === "highlighter") &&
        typeof s.color === "string" &&
        typeof s.size === "number" &&
        typeof s.opacity === "number" &&
        Array.isArray(s.points) &&
        s.points.length >= 2 &&
        s.points.length % 2 === 0 &&
        s.points.every((n) => typeof n === "number" && Number.isFinite(n))
    );
    if (clean.length) result[slide] = clean;
  }
  return result;
}

export function hasAnyStrokes(annotations: AnnotationsBySlide): boolean {
  return Object.values(annotations).some((s) => s.length > 0);
}
