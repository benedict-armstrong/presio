import { useEffect, useRef } from "react";
import { DEFAULT_LASER_STYLE, type ContentRect, type LaserPoint } from "@/lib/annotations";

// The line stays solid until the pointer has been still (or gone) this long,
// then fades out quickly as a whole.
const HOLD_MS = 2000;
const FADE_MS = 300;
const MAX_POINTS = 1500;

interface TrailPoint {
  x: number;
  y: number;
  t: number;
  size: number;
  /** Starts a new line (the pointer left and came back). */
  gap: boolean;
}

// The laser in "line" mode: the pointer draws a solid red line with a light
// glow, which disappears shortly after drawing stops. Fed the same stream of
// points as the dot (null = pointer gone, the rest fades on its own).
export function LaserTrail({ point, rect }: { point: LaserPoint | null; rect: ContentRect }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const points = useRef<TrailPoint[]>([]);
  const frame = useRef<number | null>(null);
  const rectRef = useRef(rect);
  const breakNext = useRef(false);

  useEffect(() => {
    rectRef.current = rect;
  }, [rect]);

  useEffect(() => {
    const paint = () => {
      frame.current = null;
      const canvas = canvasRef.current;
      const { width, height } = rectRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(width * dpr);
      const h = Math.round(height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const pts = points.current;
      if (!pts.length) return;
      const idle = performance.now() - pts[pts.length - 1].t;
      const alpha = idle <= HOLD_MS ? 1 : 1 - (idle - HOLD_MS) / FADE_MS;
      if (alpha <= 0) {
        points.current = [];
        return;
      }
      // One path, broken where the pointer left and came back.
      const trace = () => {
        ctx.beginPath();
        pts.forEach((p, i) => {
          if (i === 0 || p.gap) ctx.moveTo(p.x * width, p.y * height);
          else ctx.lineTo(p.x * width, p.y * height);
        });
        // A lone point still shows as a dot.
        if (pts.length === 1) ctx.lineTo(pts[0].x * width, pts[0].y * height);
      };
      const core = Math.max(2, pts[pts.length - 1].size * width * 0.4);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = alpha;
      // Light halo, then the solid line on top.
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
      frame.current = requestAnimationFrame(paint);
    };

    if (point) {
      points.current.push({
        x: point.x,
        y: point.y,
        t: performance.now(),
        size: point.size ?? DEFAULT_LASER_STYLE.size,
        gap: breakNext.current,
      });
      breakNext.current = false;
      // Endless hovering would otherwise grow the line without bound.
      if (points.current.length > MAX_POINTS) points.current.splice(0, points.current.length - MAX_POINTS);
    } else {
      // Pointer gone: the next appearance starts a new line.
      breakNext.current = true;
    }
    if (frame.current === null) frame.current = requestAnimationFrame(paint);
  }, [point]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      // Forget the handle too, or a remount (StrictMode) never paints again.
      frame.current = null;
    },
    []
  );

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
}
