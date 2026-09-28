// The laser's fading line (from Tristan Gabl's Apple Pencil work, #125): the
// points it passed through stay as a solid red line with a light glow, which
// fades out shortly after the laser stops. Fed the same points as the dot;
// null breaks the line (the laser was lifted).

// The line stays until the laser has been still (or lifted) this long, then
// fades out as a whole.
const HOLD_MS = 1500;
const FADE_MS = 300;
const MAX_POINTS = 1500;

interface TrailPoint {
  x: number;
  y: number;
  t: number;
  /** Pixels on a 960px-wide slide. */
  size: number;
  /** Starts a new line. */
  gap: boolean;
}

export class LaserTrail {
  private points: TrailPoint[] = [];
  private frame: number | null = null;
  private breakNext = false;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** The canvas's size in CSS pixels, and its pixels per CSS pixel. */
  private size: () => { w: number; h: number; resolution: number };

  constructor(canvas: HTMLCanvasElement, size: () => { w: number; h: number; resolution: number }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.size = size;
  }

  push(point: { x: number; y: number; size: number } | null) {
    if (point) {
      this.points.push({ ...point, t: performance.now(), gap: this.breakNext });
      this.breakNext = false;
      if (this.points.length > MAX_POINTS) this.points.splice(0, this.points.length - MAX_POINTS);
    } else this.breakNext = true;
    if (this.frame === null) this.frame = requestAnimationFrame(this.paint);
  }

  clear() {
    this.points = [];
    this.breakNext = false;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private paint = () => {
    this.frame = null;
    const { w, h, resolution } = this.size();
    const { canvas, ctx } = this;
    const cw = Math.max(1, Math.round(w * resolution));
    const ch = Math.max(1, Math.round(h * resolution));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    ctx.setTransform(resolution, 0, 0, resolution, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pts = this.points;
    if (!pts.length) return;
    const idle = performance.now() - pts[pts.length - 1].t;
    const alpha = idle <= HOLD_MS ? 1 : 1 - (idle - HOLD_MS) / FADE_MS;
    if (alpha <= 0) {
      this.points = [];
      return;
    }
    const trace = () => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        if (i === 0 || p.gap) ctx.moveTo(p.x * w, p.y * h);
        else ctx.lineTo(p.x * w, p.y * h);
      });
    };
    const core = Math.max(2, (pts[pts.length - 1].size / 960) * w * 0.4);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = alpha;
    // A light halo, then the solid line on top.
    ctx.shadowColor = "rgba(239, 68, 68, 0.6)";
    ctx.shadowBlur = core * 2;
    ctx.strokeStyle = "rgba(239, 68, 68, 0.25)";
    ctx.lineWidth = core * 3;
    trace();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgb(239, 68, 68)";
    ctx.lineWidth = core;
    trace();
    ctx.stroke();
    ctx.globalAlpha = 1;
    this.frame = requestAnimationFrame(this.paint);
  };
}
