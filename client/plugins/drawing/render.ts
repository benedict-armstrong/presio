// Painting strokes. Every stroke is a smoothed curve through its points —
// quadratic segments from midpoint to midpoint, each point the control — the
// same on screen, in previews and in the downloaded PDF.

import { opacityOf, REFERENCE_WIDTH, type Stroke } from "./model";

export function lineWidth(stroke: Pick<Stroke, "width">, pageWidth: number): number {
  return Math.max(1, (stroke.width / REFERENCE_WIDTH) * pageWidth);
}

/** Trace a stroke's whole path; the caller strokes it. */
export function tracePath(ctx: CanvasRenderingContext2D, p: ArrayLike<number>, w: number, h: number) {
  const n = p.length >> 1;
  if (!n) return;
  ctx.moveTo(p[0] * w, p[1] * h);
  // A tap is a dot: a zero-length segment with round caps.
  if (n === 1) {
    ctx.lineTo(p[0] * w, p[1] * h);
    return;
  }
  for (let i = 1; i < n - 1; i++) {
    const x = p[2 * i] * w;
    const y = p[2 * i + 1] * h;
    ctx.quadraticCurveTo(x, y, (x + p[2 * i + 2] * w) / 2, (y + p[2 * i + 3] * h) / 2);
  }
  ctx.lineTo(p[2 * n - 2] * w, p[2 * n - 1] * h);
}

function style(ctx: CanvasRenderingContext2D, stroke: Pick<Stroke, "color" | "width">, w: number) {
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = lineWidth(stroke, w);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

/** Paint whole strokes onto a canvas `w` × `h` pixels. */
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[], w: number, h: number) {
  for (const stroke of strokes) {
    ctx.beginPath();
    style(ctx, stroke, w);
    ctx.globalAlpha = opacityOf(stroke);
    tracePath(ctx, stroke.points, w, h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * A stroke as it's drawn, painted as it grows: the settled part of the curve
 * goes onto `stable` a segment at a time and stays, and only the last stretch
 * — from the last midpoint to the newest point, and on to where the pen is
 * predicted to be — is redrawn each frame, on `tip`. Both are opaque, in a
 * layer given the stroke's opacity as a whole, so a highlighter's overlapping
 * segments don't darken where they meet.
 */
export class LiveStroke {
  /** Segments already on `stable` (segment i ends at the midpoint after point i). */
  private settled = 0;
  private tipBox: [number, number, number, number] | null = null;

  readonly stroke: Stroke;
  private stable: CanvasRenderingContext2D;
  private tip: CanvasRenderingContext2D;

  constructor(stroke: Stroke, stable: CanvasRenderingContext2D, tip: CanvasRenderingContext2D) {
    this.stroke = stroke;
    this.stable = stable;
    this.tip = tip;
  }

  /** Paint what's new since the last call. `predicted`: flat points past the newest. */
  paint(w: number, h: number, predicted: number[] = []) {
    const p = this.stroke.points;
    const n = p.length >> 1;
    const ctx = this.stable;
    // Segments 1..n-2 are settled: each runs from the previous midpoint (the
    // first point, for the first) through point i to the next midpoint.
    if (n >= 3 && this.settled < n - 2) {
      ctx.beginPath();
      style(ctx, this.stroke, w);
      const start = this.settled + 1;
      if (start === 1) ctx.moveTo(p[0] * w, p[1] * h);
      else ctx.moveTo(((p[2 * start - 2] + p[2 * start]) / 2) * w, ((p[2 * start - 1] + p[2 * start + 1]) / 2) * h);
      for (let i = start; i <= n - 2; i++) {
        const x = p[2 * i] * w;
        const y = p[2 * i + 1] * h;
        ctx.quadraticCurveTo(x, y, (x + p[2 * i + 2] * w) / 2, (y + p[2 * i + 3] * h) / 2);
      }
      ctx.stroke();
      this.settled = n - 2;
    }
    // The tip: from where the settled curve ends to the newest point, and on.
    const t = this.tip;
    if (this.tipBox) t.clearRect(...this.tipBox);
    const pts: number[] = [];
    if (n === 1) pts.push(p[0], p[1]);
    else if (n === 2) pts.push(p[0], p[1], p[2], p[3]);
    else pts.push((p[2 * n - 4] + p[2 * n - 2]) / 2, (p[2 * n - 3] + p[2 * n - 1]) / 2, p[2 * n - 2], p[2 * n - 1]);
    pts.push(...predicted);
    t.beginPath();
    style(t, this.stroke, w);
    t.moveTo(pts[0] * w, pts[1] * h);
    if (pts.length === 2) t.lineTo(pts[0] * w, pts[1] * h);
    let [x0, y0, x1, y1] = [pts[0], pts[1], pts[0], pts[1]];
    for (let i = 2; i < pts.length; i += 2) {
      t.lineTo(pts[i] * w, pts[i + 1] * h);
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]);
      y1 = Math.max(y1, pts[i + 1]);
    }
    t.stroke();
    const pad = t.lineWidth + 2;
    this.tipBox = [x0 * w - pad, y0 * h - pad, (x1 - x0) * w + 2 * pad, (y1 - y0) * h + 2 * pad];
  }

  /** Start over (the canvases were resized or cleared). */
  reset() {
    this.settled = 0;
    this.tipBox = null;
  }
}
