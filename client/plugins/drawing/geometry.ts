// Hit tests for the eraser and the lasso, from Tristan Gabl's Apple Pencil
// work (#125). Points are page fractions; distances are pixels of the page as
// it's shown, `w` × `h`.

import { REFERENCE_WIDTH, type Stroke } from "./model";

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether an eraser `radius` pixels wide at (x, y) touches the stroke. */
export function strokeHit(stroke: Stroke, x: number, y: number, radius: number, w: number, h: number): boolean {
  const p = stroke.points;
  const reach = radius + (stroke.width / REFERENCE_WIDTH) * w * 0.5;
  const px = x * w;
  const py = y * h;
  if (p.length === 2) return Math.hypot(px - p[0] * w, py - p[1] * h) <= reach;
  for (let i = 2; i < p.length; i += 2) {
    if (segmentDistance(px, py, p[i - 2] * w, p[i - 1] * h, p[i] * w, p[i + 1] * h) <= reach) return true;
  }
  return false;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The strokes' box, padded by their line width (`aspect`: page width / height). */
export function strokesBounds(strokes: readonly Stroke[], aspect: number): Bounds | null {
  if (!strokes.length) return null;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of strokes) {
    const padX = s.width / REFERENCE_WIDTH / 2;
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

function pointInPolygon(x: number, y: number, poly: readonly number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [poly[i], poly[i + 1], poly[j], poly[j + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether a lasso loop (flat points) takes the stroke: most of its points inside. */
export function lassoContains(poly: readonly number[], s: Stroke): boolean {
  if (poly.length < 6) return false;
  const p = s.points;
  let inside = 0;
  for (let i = 0; i < p.length; i += 2) if (pointInPolygon(p[i], p[i + 1], poly)) inside++;
  return inside * 2 >= p.length / 2;
}
