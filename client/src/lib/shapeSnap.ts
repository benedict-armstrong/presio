// Shape snapping for hand-drawn strokes: a stroke held still at its end is
// recognized as a straight line or a box and replaced by a clean one. Works
// in pixel space (the slide's rendered width×height) so angles and tolerances
// are true on non-square slides; input and output are flat normalized
// [x0, y0, x1, y1, …] point lists like `Stroke.points`.

// Lines: the farthest point may stray this fraction of the line's length.
const LINE_TOLERANCE = 0.06;
// Too short to be worth snapping (pixels).
const MIN_SIZE_PX = 24;
// Boxes: the end must come back within this fraction of the box's diagonal.
const CLOSE_TOLERANCE = 0.2;
// Corner detection: simplification tolerance as a fraction of the diagonal.
const CORNER_TOLERANCE = 0.08;
// How far from 90° a box corner may be.
const MAX_CORNER_SKEW_DEG = 25;
// A box whose sides are this close to horizontal/vertical becomes axis-aligned.
const AXIS_SNAP_DEG = 12;

type Pt = { x: number; y: number };

function perpDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

// Ramer–Douglas–Peucker: keep only the points that carry the shape.
function simplify(pts: Pt[], epsilon: number): Pt[] {
  if (pts.length < 3) return pts;
  let maxD = 0;
  let index = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDistance(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      index = i;
    }
  }
  if (maxD <= epsilon) return [pts[0], pts[pts.length - 1]];
  const left = simplify(pts.slice(0, index + 1), epsilon);
  const right = simplify(pts.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

function angleDeg(a: Pt, b: Pt, c: Pt): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

function snapLine(pts: Pt[]): Pt[] | null {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < MIN_SIZE_PX) return null;
  if (pts.some((p) => perpDistance(p, a, b) > len * LINE_TOLERANCE)) return null;
  return [a, b];
}

function snapBox(pts: Pt[]): Pt[] | null {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (maxX - minX < MIN_SIZE_PX || maxY - minY < MIN_SIZE_PX) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.hypot(last.x - first.x, last.y - first.y) > diag * CLOSE_TOLERANCE) return null;

  // Close the loop, simplify, and expect four corners (plus the repeated start).
  let corners = simplify([...pts, first], diag * CORNER_TOLERANCE).slice(0, -1);
  // The start may sit mid-side: drop a "corner" that is really a straight run.
  corners = corners.filter((c, i) => {
    const prev = corners[(i + corners.length - 1) % corners.length];
    const next = corners[(i + 1) % corners.length];
    return angleDeg(prev, c, next) < 180 - MAX_CORNER_SKEW_DEG;
  });
  if (corners.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const angle = angleDeg(corners[(i + 3) % 4], corners[i], corners[(i + 1) % 4]);
    if (Math.abs(angle - 90) > MAX_CORNER_SKEW_DEG) return null;
  }

  // Mostly upright → the bounding box; otherwise a clean rotated rectangle
  // from the first side's direction and the corners' extents along it.
  const side = { x: corners[1].x - corners[0].x, y: corners[1].y - corners[0].y };
  const tilt = ((Math.atan2(side.y, side.x) * 180) / Math.PI + 360) % 90;
  if (tilt < AXIS_SNAP_DEG || tilt > 90 - AXIS_SNAP_DEG) {
    return [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
      { x: minX, y: minY },
    ];
  }
  const len = Math.hypot(side.x, side.y) || 1;
  const u = { x: side.x / len, y: side.y / len };
  const v = { x: -u.y, y: u.x };
  const along = corners.map((c) => c.x * u.x + c.y * u.y);
  const across = corners.map((c) => c.x * v.x + c.y * v.y);
  const [a0, a1] = [Math.min(...along), Math.max(...along)];
  const [b0, b1] = [Math.min(...across), Math.max(...across)];
  const at = (a: number, b: number): Pt => ({ x: a * u.x + b * v.x, y: a * u.y + b * v.y });
  return [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1), at(a0, b0)];
}

// Snap a stroke to a line or a box, or return null when it is neither.
export function snapShape(points: readonly number[], width: number, height: number): number[] | null {
  if (points.length < 6 || width <= 0 || height <= 0) return null;
  const pts: Pt[] = [];
  for (let i = 0; i < points.length; i += 2) pts.push({ x: points[i] * width, y: points[i + 1] * height });
  const shape = snapLine(pts) ?? snapBox(pts);
  if (!shape) return null;
  return shape.flatMap((p) => [
    Math.min(1, Math.max(0, p.x / width)),
    Math.min(1, Math.max(0, p.y / height)),
  ]);
}
