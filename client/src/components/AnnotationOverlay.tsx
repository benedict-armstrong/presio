import { useState, useEffect, useRef, useCallback } from "react";
import {
  contentRectFor,
  clamp01,
  drawStrokes,
  DEFAULT_PEN_STYLE,
  type ContentRect,
  type LaserPoint,
  type PenStyle,
  type Stroke,
  type Tool,
} from "@/lib/annotations";

// How often the controller streams pointer/stroke updates outward, and how long
// a viewer keeps showing a laser dot that stopped moving (covers dropped hides).
const EMIT_INTERVAL_MS = 33;
const REMOTE_HIDE_MS = 3000;
// Ignore pointer moves closer than this (normalized) to the last stored point,
// so strokes stay compact.
const MIN_POINT_DISTANCE = 0.002;

interface Props {
  /** The div the slide canvas is rendered into (letterboxed via object-fit). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Active tool — only the controller passes anything but "none". */
  tool?: Tool;
  /** Color/width used for new strokes (controller). */
  penStyle?: PenStyle;
  /** Committed strokes of the displayed slide. */
  strokes?: readonly Stroke[];
  /** In-progress stroke received from the controller (viewer windows). */
  remoteDraft?: Stroke | null;
  /** Controller: stream the laser position (null = pointer left the slide). */
  onLaserMove?: (pt: LaserPoint | null) => void;
  /** Controller: stream the in-progress stroke (null = drawing finished). */
  onStrokeProgress?: (stroke: Stroke | null) => void;
  /** Controller: a stroke was finished and should be committed + synced. */
  onStrokeCommit?: (stroke: Stroke) => void;
  /** Laser position received from the other side (viewer windows). */
  remoteLaser?: LaserPoint | null;
}

// Transparent layer stretched over the slide's content rect. It renders the
// slide's strokes plus laser dots (local while pointing, remote as received)
// and, when a tool is active, captures pointer events so mouse/touch/pencil
// input maps to normalized slide coordinates. With no active tool it is
// click-through.
export function AnnotationOverlay({
  containerRef,
  tool = "none",
  penStyle = DEFAULT_PEN_STYLE,
  strokes = [],
  remoteDraft = null,
  onLaserMove,
  onStrokeProgress,
  onStrokeCommit,
  remoteLaser,
}: Props) {
  const [rect, setRect] = useState<ContentRect | null>(null);
  const [localLaser, setLocalLaser] = useState<LaserPoint | null>(null);
  const [remoteVisible, setRemoteVisible] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draftRef = useRef<Stroke | null>(null);
  const lastEmit = useRef(0);

  // Track the slide's content rect: the canvas is swapped on each slide render
  // (MutationObserver) and the box follows the window (ResizeObserver).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const canvas = container.querySelector("canvas");
      const aspect = canvas && canvas.height > 0 ? canvas.width / canvas.height : 0;
      setRect(contentRectFor(container.clientWidth, container.clientHeight, aspect));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    const mo = new MutationObserver(update);
    mo.observe(container, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [containerRef]);

  // Auto-hide the remote dot when updates stop arriving.
  useEffect(() => {
    if (!remoteLaser) {
      setRemoteVisible(false);
      return;
    }
    setRemoteVisible(true);
    const t = setTimeout(() => setRemoteVisible(false), REMOTE_HIDE_MS);
    return () => clearTimeout(t);
  }, [remoteLaser]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !rect) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    drawStrokes(ctx, strokes, rect.width, rect.height);
    const draft = draftRef.current ?? remoteDraft;
    if (draft) drawStrokes(ctx, [draft], rect.width, rect.height);
  }, [rect, strokes, remoteDraft]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const toNormalized = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): LaserPoint => {
      const box = e.currentTarget.getBoundingClientRect();
      return {
        x: clamp01((e.clientX - box.left) / box.width),
        y: clamp01((e.clientY - box.top) / box.height),
      };
    },
    []
  );

  const emitThrottled = useCallback((send: () => void) => {
    const now = Date.now();
    if (now - lastEmit.current < EMIT_INTERVAL_MS) return;
    lastEmit.current = now;
    send();
  }, []);

  const finishStroke = useCallback(() => {
    const draft = draftRef.current;
    if (!draft) return;
    draftRef.current = null;
    onStrokeProgress?.(null);
    onStrokeCommit?.(draft);
  }, [onStrokeCommit, onStrokeProgress]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    if (tool === "laser") {
      const pt = toNormalized(e);
      setLocalLaser(pt);
      emitThrottled(() => onLaserMove?.(pt));
    } else if (tool === "pen") {
      e.currentTarget.setPointerCapture(e.pointerId);
      const pt = toNormalized(e);
      draftRef.current = {
        tool: "pen",
        color: penStyle.color,
        size: penStyle.size,
        opacity: 1,
        points: [pt.x, pt.y],
      };
      redraw();
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    if (tool === "laser") {
      const pt = toNormalized(e);
      setLocalLaser(pt);
      emitThrottled(() => onLaserMove?.(pt));
      return;
    }
    const draft = draftRef.current;
    if (tool === "pen" && draft) {
      const pt = toNormalized(e);
      const n = draft.points.length;
      const dx = pt.x - draft.points[n - 2];
      const dy = pt.y - draft.points[n - 1];
      if (Math.hypot(dx, dy) < MIN_POINT_DISTANCE) return;
      draft.points.push(pt.x, pt.y);
      redraw();
      emitThrottled(() => onStrokeProgress?.({ ...draft, points: [...draft.points] }));
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    finishStroke();
  };

  const onPointerLeave = () => {
    if (tool === "laser") {
      setLocalLaser(null);
      onLaserMove?.(null);
    }
    // Pen strokes keep going while the pointer is captured; pointerup/cancel
    // end them, so nothing to do here.
  };

  if (!rect) return null;

  const interactive = tool !== "none";
  const dot = (pt: LaserPoint, key: string) => (
    <span
      key={key}
      className="absolute size-4 -ml-2 -mt-2 rounded-full bg-red-500 shadow-[0_0_10px_3px_rgba(239,68,68,0.65)] ring-2 ring-white/60 pointer-events-none"
      style={{ left: pt.x * rect.width, top: pt.y * rect.height }}
    />
  );

  return (
    <div
      data-testid="annotation-overlay"
      className={interactive ? "absolute z-[5] touch-none" : "absolute z-[5] pointer-events-none"}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, cursor: interactive ? "crosshair" : undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      {tool === "laser" && localLaser && dot(localLaser, "local")}
      {remoteVisible && remoteLaser && dot(remoteLaser, "remote")}
    </div>
  );
}
