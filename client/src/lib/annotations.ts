// Shared types and geometry helpers for the slide annotation layer (laser
// pointer, drawing tools). Coordinates are normalized to the *slide content
// rect* — the letterboxed area the PDF page actually occupies inside its
// container — so a point means the same spot on every screen size.

export type Tool = "none" | "laser" | "pen" | "highlighter" | "eraser" | "lasso";

export interface LaserPoint {
  x: number;
  y: number;
  /** Dot diameter as a fraction of the slide width (default DEFAULT_LASER_STYLE). */
  size?: number;
  /** Leave a fading line behind instead of showing just a dot. */
  trail?: boolean;
}

export interface LaserStyle {
  size: number;
  trail: boolean;
}

// Laser sizes are picked in "pixels at a 960px-wide slide", like pen widths.
export const LASER_SIZES = [8, 16, 24, 32];
export const DEFAULT_LASER_STYLE: LaserStyle = { size: 16 / 960, trail: false };

// A single drawn stroke. `points` is a flat [x0, y0, x1, y1, …] list of
// normalized coordinates; `size` is the stroke width as a fraction of the
// slide width so it scales with the rendered size.
//
// A pasted image is a stroke too (`tool: "image"`), so syncing, saving,
// undo, the eraser and the lasso treat it like any other mark: `src` holds
// the (downscaled) image as a data URL and `points` its box as
// [left, top, right, bottom].
export interface Stroke {
  /** Stable id so a single stroke can be erased on every screen. Optional
   *  only for strokes saved before ids existed — see `withStrokeIds`. */
  id?: string;
  tool: "pen" | "highlighter" | "image";
  /** Image strokes only: a data:image/… URL. */
  src?: string;
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

// Highlighter strokes are wide and semi-transparent, in marker-like colors.
export const HIGHLIGHTER_OPACITY = 0.35;
export const DEFAULT_HIGHLIGHTER_STYLE: PenStyle = { color: "#facc15", size: 14 / PEN_REFERENCE_WIDTH };
export const HIGHLIGHTER_COLORS = ["#facc15", "#a3e635", "#22d3ee", "#f472b6", "#fb923c", "#c084fc"];

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
// `onImageLoad` fires once an image that was still decoding is ready, so the
// caller can paint again.
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: readonly Stroke[],
  width: number,
  height: number,
  onImageLoad?: () => void
) {
  for (const stroke of strokes) {
    const pts = stroke.points;
    if (stroke.tool === "image") {
      const img = stroke.src && pts.length >= 4 ? loadImage(stroke.src, onImageLoad) : null;
      if (img) {
        ctx.globalAlpha = stroke.opacity;
        ctx.drawImage(img, pts[0] * width, pts[1] * height, (pts[2] - pts[0]) * width, (pts[3] - pts[1]) * height);
      }
      continue;
    }
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

// Decoded images by source, shared by every canvas that paints them.
const imageCache = new Map<string, HTMLImageElement>();

function loadImage(src: string, onLoad?: () => void): HTMLImageElement | null {
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    imageCache.set(src, img);
  }
  if (img.complete && img.naturalWidth > 0) return img;
  if (onLoad) img.addEventListener("load", onLoad, { once: true });
  return null;
}

export function isImageSrc(src: unknown): src is string {
  return typeof src === "string" && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(src);
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
        (s.tool === "pen" || s.tool === "highlighter" || (s.tool === "image" && isImageSrc(s.src) && s.points?.length === 4)) &&
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
  return withStrokeIds(result);
}

export function hasAnyStrokes(annotations: AnnotationsBySlide): boolean {
  return Object.values(annotations).some((s) => s.length > 0);
}

export function newStrokeId(): string {
  return Math.random().toString(36).slice(2, 12);
}

// Give every stroke an id, for drawings stored before strokes carried one.
// Returns the same object when nothing was missing.
export function withStrokeIds(annotations: AnnotationsBySlide): AnnotationsBySlide {
  let changed = false;
  const result: AnnotationsBySlide = {};
  for (const [slide, strokes] of Object.entries(annotations)) {
    result[Number(slide)] = strokes.map((s) => {
      if (typeof s.id === "string" && s.id) return s;
      changed = true;
      return { ...s, id: newStrokeId() };
    });
  }
  return changed ? result : annotations;
}

// Distance from point p to segment ab, all in the same (pixel) space.
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Whether an eraser of `radius` pixels at normalized point (x, y) touches the
// stroke, on a slide rendered `width`×`height` pixels.
export function strokeHit(
  stroke: Stroke,
  x: number,
  y: number,
  radius: number,
  width: number,
  height: number
): boolean {
  const pts = stroke.points;
  if (stroke.tool === "image") {
    const r = radius / width;
    const ry = radius / height;
    return x >= pts[0] - r && x <= pts[2] + r && y >= pts[1] - ry && y <= pts[3] + ry;
  }
  const reach = radius + (stroke.size * width) / 2;
  const px = x * width;
  const py = y * height;
  if (pts.length === 2) return Math.hypot(px - pts[0] * width, py - pts[1] * height) <= reach;
  for (let i = 2; i < pts.length; i += 2) {
    const d = segmentDistance(px, py, pts[i - 2] * width, pts[i - 1] * height, pts[i] * width, pts[i + 1] * height);
    if (d <= reach) return true;
  }
  return false;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Normalized bounding box of a set of strokes, padded by their line width.
export function strokesBounds(strokes: readonly Stroke[], aspect: number): Bounds | null {
  if (!strokes.length) return null;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of strokes) {
    const padX = s.tool === "image" ? 0 : s.size / 2;
    const padY = padX * aspect;
    for (let i = 0; i < s.points.length; i += 2) {
      b.minX = Math.min(b.minX, s.points[i] - padX);
      b.maxX = Math.max(b.maxX, s.points[i] + padX);
      b.minY = Math.min(b.minY, s.points[i + 1] - padY);
      b.maxY = Math.max(b.maxY, s.points[i + 1] + padY);
    }
  }
  return b;
}

// Move by (dx, dy) and scale by `k` around (ox, oy), all normalized. Line
// widths scale along so a resized drawing keeps its look.
export function transformStroke(s: Stroke, dx: number, dy: number, k = 1, ox = 0, oy = 0): Stroke {
  return {
    ...s,
    size: s.tool === "image" ? s.size : s.size * k,
    points: s.points.map((n, i) => (i % 2 === 0 ? ox + (n - ox) * k + dx : oy + (n - oy) * k + dy)),
  };
}

function pointInPolygon(x: number, y: number, poly: readonly number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [poly[i], poly[i + 1], poly[j], poly[j + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Whether a lasso loop (flat normalized points) takes the stroke: most of its
// points inside, or for an image, its center.
export function lassoContains(poly: readonly number[], s: Stroke): boolean {
  if (poly.length < 6) return false;
  const pts = s.points;
  if (s.tool === "image") return pointInPolygon((pts[0] + pts[2]) / 2, (pts[1] + pts[3]) / 2, poly);
  let inside = 0;
  for (let i = 0; i < pts.length; i += 2) if (pointInPolygon(pts[i], pts[i + 1], poly)) inside++;
  return inside * 2 >= pts.length / 2;
}
