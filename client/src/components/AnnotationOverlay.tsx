import { useState, useEffect, useRef, useCallback } from "react";
import { Trash2 } from "lucide-react";
import {
  contentRectFor,
  clamp01,
  drawStrokes,
  DEFAULT_PEN_STYLE,
  DEFAULT_LASER_STYLE,
  type LaserStyle,
  HIGHLIGHTER_OPACITY,
  newStrokeId,
  strokeHit,
  strokesBounds,
  transformStroke,
  lassoContains,
  type ContentRect,
  type LaserPoint,
  type PenStyle,
  type Stroke,
  type Tool,
} from "@/lib/annotations";
import { snapShape } from "@/lib/shapeSnap";
import { imageToStroke } from "@/lib/imageStroke";
import { LaserTrail } from "@/components/LaserTrail";

// How often the controller streams pointer/stroke updates outward, and how long
// a viewer keeps showing a laser dot that stopped moving (covers dropped hides).
const EMIT_INTERVAL_MS = 33;
const REMOTE_HIDE_MS = 3000;
// Ignore pointer moves closer than this (normalized) to the last stored point,
// so strokes stay compact.
const MIN_POINT_DISTANCE = 0.002;
// Eraser reach around the pointer, in screen pixels.
const ERASER_RADIUS_PX = 10;
// Holding the pointer still this long at the end of a stroke snaps it to a
// straight line or a box. Moving less than the slop counts as still.
const SNAP_HOLD_MS = 500;
const SNAP_HOLD_SLOP_PX = 4;
// Lasso: resized selections never shrink below this factor in one drag.
const MIN_SCALE = 0.1;
// A tap (select an image / drop the selection): quick and barely moving.
const TAP_MS = 300;
const TAP_SLOP_PX = 10;

interface Props {
  /** The div the slide canvas is rendered into (letterboxed via object-fit). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Active tool — only the controller passes anything but "none". */
  tool?: Tool;
  /** Color/width used for new strokes (controller). */
  penStyle?: PenStyle;
  /** Laser size and dot/line mode (controller). */
  laserStyle?: LaserStyle;
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
  /** Controller: the eraser touched these strokes (by id) on this slide. */
  onStrokesErase?: (ids: string[], continuing?: boolean) => void;
  /** Controller: the lasso moved/resized these strokes (matched by id). */
  onStrokesUpdate?: (strokes: Stroke[]) => void;
  /** Controller: lets the overlay switch to the lasso after inserting an image. */
  onToolChange?: (tool: Tool) => void;
  /**
   * Controller: filled with a function that places an image on the slide
   * (selected, ready to move). Also enables pasting images with ⌘V / Ctrl+V.
   */
  insertImageRef?: React.RefObject<((image: Blob) => Promise<void>) | null>;
  /** Laser position received from the other side (viewer windows). */
  remoteLaser?: LaserPoint | null;
  /**
   * True while a pinch/pan gesture owns the slide surface. The gesture steals
   * pointer capture, so any stroke in progress is dropped and new input is
   * ignored until the fingers lift.
   */
  gestureActive?: boolean;
  /**
   * Pencil mode: only stylus input draws or points. Finger touches are left to
   * the pan/zoom gestures, and a resting palm never leaves a mark.
   */
  pencilOnly?: boolean;
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
  laserStyle = DEFAULT_LASER_STYLE,
  strokes = [],
  remoteDraft = null,
  onLaserMove,
  onStrokeProgress,
  onStrokeCommit,
  onStrokesErase,
  onStrokesUpdate,
  onToolChange,
  insertImageRef,
  remoteLaser,
  gestureActive = false,
  pencilOnly = false,
}: Props) {
  const [rect, setRect] = useState<ContentRect | null>(null);
  const [localLaser, setLocalLaser] = useState<LaserPoint | null>(null);
  // The remote dot is visible until no update has arrived for REMOTE_HIDE_MS:
  // `expired` remembers which laser point the hide timer already fired for.
  const [expiredLaser, setExpiredLaser] = useState<LaserPoint | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draftRef = useRef<Stroke | null>(null);
  // The pointer that owns the current stroke / laser. Tracked by id rather
  // than `isPrimary`: a palm that lands before the pencil becomes the primary
  // pointer, so the pencil itself would not be.
  const activePointer = useRef<number | null>(null);
  // Eraser position while pressed (normalized), drawn as a ring.
  const [eraserAt, setEraserAt] = useState<(LaserPoint & { r: number }) | null>(null);
  // Ids already sent during this eraser drag, so each is erased once.
  const erasedRef = useRef(new Set<string>());
  // Hold-to-snap: where the pointer last settled, the pending timer, and
  // whether the current stroke has already been snapped (it then stays put).
  const holdRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const snappedRef = useRef(false);
  // Lasso: the loop being drawn, the selected stroke ids, the move/resize in
  // progress, and the strokes as they look mid-drag (committed on release).
  const lassoPathRef = useRef<number[] | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const dragRef = useRef<{
    mode: "move" | "scale";
    start: LaserPoint;
    originals: Stroke[];
    ox: number;
    oy: number;
  } | null>(null);
  const [preview, setPreview] = useState<Stroke[] | null>(null);
  // Finger taps being watched while fingers don't draw (pencil mode).
  const fingerTaps = useRef(new Map<number, { x: number; y: number; t: number; multi: boolean }>());
  // Bumped when an image finishes decoding, to repaint with it.
  const [imagesLoaded, setImagesLoaded] = useState(0);
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

  // Auto-hide the remote dot when updates stop arriving. Each update is a new
  // point object, so a fresh point un-expires the dot without extra state.
  useEffect(() => {
    if (!remoteLaser) return;
    const t = setTimeout(() => setExpiredLaser(remoteLaser), REMOTE_HIDE_MS);
    return () => clearTimeout(t);
  }, [remoteLaser]);
  const remoteVisible = !!remoteLaser && remoteLaser !== expiredLaser;

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
    const moved = preview && new Map(preview.map((p) => [p.id, p]));
    const shown = moved ? strokes.map((st) => (st.id && moved.get(st.id)) || st) : strokes;
    // Images may still be decoding; paint again once they are ready.
    const again = () => setImagesLoaded((n) => n + 1);
    drawStrokes(ctx, shown, rect.width, rect.height, again);
    const draft = draftRef.current ?? remoteDraft;
    if (draft) drawStrokes(ctx, [draft], rect.width, rect.height, again);
    const loop = lassoPathRef.current;
    if (loop && loop.length >= 4) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#2563eb";
      ctx.beginPath();
      ctx.moveTo(loop[0] * rect.width, loop[1] * rect.height);
      for (let i = 2; i < loop.length; i += 2) ctx.lineTo(loop[i] * rect.width, loop[i + 1] * rect.height);
      ctx.stroke();
      ctx.restore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- repaint trigger only
  }, [rect, strokes, remoteDraft, preview, imagesLoaded]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  // Place an image centered on the slide, selected with the lasso so it can be
  // moved and resized straight away.
  const insertImage = useCallback(
    async (image: Blob) => {
      if (!rect || !onStrokeCommit) return;
      const stroke = await imageToStroke(image, rect.width / rect.height);
      onStrokeCommit(stroke);
      setSelection([stroke.id!]);
      onToolChange?.("lasso");
    },
    [rect, onStrokeCommit, onToolChange]
  );

  useEffect(() => {
    if (!insertImageRef) return;
    insertImageRef.current = insertImage;
    // Paste anywhere on the page, except into text fields (notes).
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      insertImage(file).catch((err) => console.warn("Could not paste image:", err));
    };
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("paste", onPaste);
      insertImageRef.current = null;
    };
  }, [insertImageRef, insertImage]);

  // Map a pointer position to normalized slide coordinates. The overlay is laid
  // out over the content rect, so its own client box already carries whatever
  // transform sits above it (the pinch zoom lives on an ancestor wrapper) —
  // normalizing against that box keeps drawing under the finger at any zoom.
  const toNormalized = useCallback((box: DOMRect, p: { clientX: number; clientY: number }): LaserPoint => {
    if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
    return {
      x: clamp01((p.clientX - box.left) / box.width),
      y: clamp01((p.clientY - box.top) / box.height),
    };
  }, []);

  const emitThrottled = useCallback((send: () => void) => {
    const now = Date.now();
    if (now - lastEmit.current < EMIT_INTERVAL_MS) return;
    lastEmit.current = now;
    send();
  }, []);

  const cancelHold = useCallback(() => {
    if (holdRef.current) clearTimeout(holdRef.current.timer);
    holdRef.current = null;
  }, []);

  const finishStroke = useCallback(() => {
    cancelHold();
    const draft = draftRef.current;
    activePointer.current = null;
    setEraserAt(null);
    if (!draft) return;
    draftRef.current = null;
    onStrokeProgress?.(null);
    onStrokeCommit?.(draft);
  }, [onStrokeCommit, onStrokeProgress, cancelHold]);

  // A pinch takes pointer capture away from this overlay, so the stroke that
  // started with the first finger never sees its pointerup. Drop it rather than
  // committing a stray mark (or leaving a draft hanging around).
  useEffect(() => {
    // In pencil mode fingers never draw, so a pinch cannot own a pen stroke.
    if (!gestureActive || pencilOnly) return;
    // Syncing with the gesture, not deriving state: the dot has to disappear on
    // the other side too, so this clears both ends of the laser.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalLaser(null);
    setEraserAt(null);
    onLaserMove?.(null);
    activePointer.current = null;
    cancelHold();
    if (!draftRef.current) return;
    draftRef.current = null;
    onStrokeProgress?.(null);
    redraw();
  }, [gestureActive, pencilOnly, onLaserMove, onStrokeProgress, redraw, cancelHold]);

  useEffect(() => cancelHold, [cancelHold]);

  // Erase every stroke the eraser circle touches at `pt`. The radius is in
  // screen pixels (the overlay's on-screen box), so it feels the same zoomed.
  const eraseAt = (box: DOMRect, pt: LaserPoint) => {
    const hits = strokes
      .filter((s) => s.id && !erasedRef.current.has(s.id))
      .filter((s) => strokeHit(s, pt.x, pt.y, ERASER_RADIUS_PX, box.width, box.height))
      .map((s) => s.id!);
    if (!hits.length) return;
    // Later hits in the same drag extend the first erase (one undo step).
    const continuing = erasedRef.current.size > 0;
    for (const hitId of hits) erasedRef.current.add(hitId);
    onStrokesErase?.(hits, continuing);
  };

  // (Re)start the snap timer unless the pointer is still resting where it
  // settled — jitter below the slop doesn't postpone the snap.
  const armSnap = (e: { clientX: number; clientY: number }) => {
    const hold = holdRef.current;
    if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) <= SNAP_HOLD_SLOP_PX) return;
    cancelHold();
    holdRef.current = {
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        holdRef.current = null;
        const draft = draftRef.current;
        if (!draft || !rect) return;
        const snapped = snapShape(draft.points, rect.width, rect.height);
        if (!snapped) return;
        draft.points = snapped;
        snappedRef.current = true;
        redraw();
        onStrokeProgress?.({ ...draft, points: [...draft.points] });
      }, SNAP_HOLD_MS),
    };
  };

  // The ring lives inside the zoom transform, so its layout radius is the
  // screen radius scaled back by the current zoom.
  const ringAt = (box: DOMRect, pt: LaserPoint) => ({
    ...pt,
    r: rect && box.width > 0 ? (ERASER_RADIUS_PX * rect.width) / box.width : ERASER_RADIUS_PX,
  });

  // A laser position carries its style, so viewers draw it the same way.
  const laserAt = (box: DOMRect, e: { clientX: number; clientY: number }): LaserPoint => ({
    ...toNormalized(box, e),
    size: laserStyle.size,
    ...(laserStyle.trail ? { trail: true } : {}),
  });

  // Whether this pointer may drive the active tool at all.
  const accepts = (e: React.PointerEvent<HTMLDivElement>) =>
    pencilOnly ? e.pointerType === "pen" : e.isPrimary && !gestureActive;

  // Selected strokes as currently shown, and their box (normalized).
  const selected = tool === "lasso" ? (preview ?? strokes.filter((st) => st.id && selection.includes(st.id))) : [];
  const selBounds = rect ? strokesBounds(selected, rect.width / rect.height) : null;

  // Topmost image under a normalized point.
  const imageAt = (pt: LaserPoint) =>
    [...strokes]
      .reverse()
      .find(
        (st) =>
          st.tool === "image" &&
          st.id &&
          pt.x >= st.points[0] && pt.x <= st.points[2] && pt.y >= st.points[1] && pt.y <= st.points[3]
      );

  // A tap on an image selects it (switching to the lasso); a tap elsewhere
  // with the lasso drops the selection.
  const tapAt = (pt: LaserPoint) => {
    const image = imageAt(pt);
    if (image) {
      setSelection([image.id!]);
      if (tool !== "lasso") onToolChange?.("lasso");
    } else if (tool === "lasso") {
      setSelection([]);
    }
  };

  // Fingers that don't draw (pencil mode) can still tap. The pinch/pan
  // gesture may capture the finger, so its release is watched on the window.
  const watchFingerTap = (e: React.PointerEvent<HTMLDivElement>, box: DOMRect) => {
    const taps = fingerTaps.current;
    const id = e.pointerId;
    for (const other of taps.values()) other.multi = true;
    taps.set(id, { x: e.clientX, y: e.clientY, t: performance.now(), multi: taps.size > 0 });
    const done = (up: PointerEvent) => {
      if (up.pointerId !== id) return;
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      const start = taps.get(id);
      taps.delete(id);
      if (!start || up.type !== "pointerup" || start.multi) return;
      if (performance.now() - start.t > TAP_MS) return;
      if (Math.hypot(up.clientX - start.x, up.clientY - start.y) > TAP_SLOP_PX) return;
      tapAt(toNormalized(box, { clientX: start.x, clientY: start.y }));
    };
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // A finger may always grab the lasso selection — dragging a pasted image
    // around by hand — even in pencil mode, where fingers otherwise don't draw.
    const grabsSelection =
      tool === "lasso" && e.target instanceof Element && !!e.target.closest("[data-lasso-box]");
    const box = e.currentTarget.getBoundingClientRect();
    if (e.pointerType === "touch" && !accepts(e) && !grabsSelection && tool !== "none") {
      watchFingerTap(e, box);
      return;
    }
    if (!(accepts(e) || grabsSelection) || activePointer.current !== null) return;
    if (tool === "lasso") {
      e.currentTarget.setPointerCapture(e.pointerId);
      activePointer.current = e.pointerId;
      const pt = toNormalized(box, e);
      const onHandle = e.target instanceof Element && !!e.target.closest("[data-lasso-handle]");
      const inside =
        selBounds && pt.x >= selBounds.minX && pt.x <= selBounds.maxX && pt.y >= selBounds.minY && pt.y <= selBounds.maxY;
      if (selBounds && (onHandle || inside)) {
        dragRef.current = {
          mode: onHandle ? "scale" : "move",
          start: pt,
          originals: selected,
          ox: selBounds.minX,
          oy: selBounds.minY,
        };
      } else {
        setSelection([]);
        lassoPathRef.current = [pt.x, pt.y];
      }
      return;
    }
    if (selection.length) setSelection([]);
    if (tool === "laser") {
      activePointer.current = e.pointerId;
      const pt = laserAt(box, e);
      setLocalLaser(pt);
      emitThrottled(() => onLaserMove?.(pt));
    } else if (tool === "eraser") {
      e.currentTarget.setPointerCapture(e.pointerId);
      activePointer.current = e.pointerId;
      erasedRef.current = new Set();
      const pt = toNormalized(box, e);
      setEraserAt(ringAt(box, pt));
      eraseAt(box, pt);
    } else if (tool === "pen" || tool === "highlighter") {
      e.currentTarget.setPointerCapture(e.pointerId);
      activePointer.current = e.pointerId;
      const pt = toNormalized(box, e);
      draftRef.current = {
        id: newStrokeId(),
        tool,
        color: penStyle.color,
        size: penStyle.size,
        opacity: tool === "highlighter" ? HIGHLIGHTER_OPACITY : 1,
        points: [pt.x, pt.y],
      };
      snappedRef.current = false;
      armSnap(e);
      redraw();
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!accepts(e) && activePointer.current !== e.pointerId) return;
    // Mouse and pen hover move the laser without a press; otherwise only the
    // pointer that started the stroke counts.
    if (activePointer.current !== null && activePointer.current !== e.pointerId) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (tool === "laser") {
      const pt = laserAt(box, e);
      setLocalLaser(pt);
      emitThrottled(() => onLaserMove?.(pt));
      return;
    }
    if (tool === "lasso") {
      if (activePointer.current !== e.pointerId) return;
      const pt = toNormalized(box, e);
      const drag = dragRef.current;
      if (drag?.mode === "move") {
        const dx = pt.x - drag.start.x;
        const dy = pt.y - drag.start.y;
        setPreview(drag.originals.map((st) => transformStroke(st, dx, dy)));
      } else if (drag) {
        const d0 = Math.hypot(drag.start.x - drag.ox, drag.start.y - drag.oy);
        const k = d0 > 0 ? Math.max(MIN_SCALE, Math.hypot(pt.x - drag.ox, pt.y - drag.oy) / d0) : 1;
        setPreview(drag.originals.map((st) => transformStroke(st, 0, 0, k, drag.ox, drag.oy)));
      } else if (lassoPathRef.current) {
        lassoPathRef.current.push(pt.x, pt.y);
        redraw();
      }
      return;
    }
    if (tool === "eraser") {
      if (activePointer.current !== e.pointerId) return;
      const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length > 0 ? samples : [e]) eraseAt(box, toNormalized(box, sample));
      setEraserAt(ringAt(box, toNormalized(box, e)));
      return;
    }
    const draft = draftRef.current;
    if ((tool === "pen" || tool === "highlighter") && draft) {
      if (snappedRef.current) return;
      armSnap(e);
      // A pencil reports far more samples than frames; the coalesced events
      // carry the ones the browser folded into this move.
      const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
      let added = false;
      for (const sample of samples.length > 0 ? samples : [e]) {
        const pt = toNormalized(box, sample);
        const n = draft.points.length;
        const dx = pt.x - draft.points[n - 2];
        const dy = pt.y - draft.points[n - 1];
        if (Math.hypot(dx, dy) < MIN_POINT_DISTANCE) continue;
        draft.points.push(pt.x, pt.y);
        added = true;
      }
      if (!added) return;
      redraw();
      emitThrottled(() => onStrokeProgress?.({ ...draft, points: [...draft.points] }));
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== e.pointerId) return;
    if (tool === "lasso") {
      activePointer.current = null;
      const loop = lassoPathRef.current;
      lassoPathRef.current = null;
      if (loop) {
        const box = e.currentTarget.getBoundingClientRect();
        const xs = loop.filter((_, i) => i % 2 === 0);
        const ys = loop.filter((_, i) => i % 2 === 1);
        const spanPx = Math.max(
          (Math.max(...xs) - Math.min(...xs)) * box.width,
          (Math.max(...ys) - Math.min(...ys)) * box.height
        );
        if (spanPx <= TAP_SLOP_PX) tapAt({ x: loop[0], y: loop[1] });
        else setSelection(strokes.filter((st) => st.id && lassoContains(loop, st)).map((st) => st.id!));
        redraw();
      }
      if (dragRef.current && preview) onStrokesUpdate?.(preview);
      dragRef.current = null;
      setPreview(null);
      return;
    }
    finishStroke();
  };

  const onPointerLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pencilOnly && e.pointerType !== "pen") return;
    if (tool === "laser") {
      activePointer.current = null;
      setLocalLaser(null);
      onLaserMove?.(null);
    }
    // Pen strokes keep going while the pointer is captured; pointerup/cancel
    // end them, so nothing to do here.
  };

  if (!rect) return null;

  const interactive = tool !== "none";
  const dot = (pt: LaserPoint, key: string) => {
    const d = Math.max(4, (pt.size ?? DEFAULT_LASER_STYLE.size) * rect.width);
    return (
      <span
        key={key}
        data-testid="laser-dot"
        data-laser={key}
        className="absolute rounded-full bg-red-500 shadow-[0_0_10px_3px_rgba(239,68,68,0.65)] ring-2 ring-white/60 pointer-events-none"
        style={{ left: pt.x * rect.width, top: pt.y * rect.height, width: d, height: d, marginLeft: -d / 2, marginTop: -d / 2 }}
      />
    );
  };

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
      <canvas ref={canvasRef} data-testid="annotation-strokes" className="absolute inset-0 w-full h-full pointer-events-none" />
      {/* Always mounted while in use, so a line fades out after the pointer leaves. */}
      {tool === "laser" && <LaserTrail point={localLaser?.trail ? localLaser : null} rect={rect} />}
      {remoteLaser !== undefined && (
        <LaserTrail point={remoteVisible && remoteLaser?.trail ? remoteLaser : null} rect={rect} />
      )}
      {tool === "laser" && localLaser && !localLaser.trail && dot(localLaser, "local")}
      {remoteVisible && remoteLaser && !remoteLaser.trail && dot(remoteLaser, "remote")}
      {selBounds && (
        <div
          data-testid="lasso-selection"
          data-lasso-box
          className="absolute border border-dashed border-blue-600 cursor-move"
          style={{
            left: selBounds.minX * rect.width,
            top: selBounds.minY * rect.height,
            width: (selBounds.maxX - selBounds.minX) * rect.width,
            height: (selBounds.maxY - selBounds.minY) * rect.height,
          }}
        >
          <span
            data-lasso-handle
            title="Drag to resize"
            className="absolute -right-2 -bottom-2 size-4 rounded-sm bg-blue-600 ring-2 ring-white pointer-events-auto cursor-nwse-resize before:absolute before:-inset-3 before:content-['']"
          />
          {!preview && (
            <button
              type="button"
              title="Delete selection"
              data-testid="lasso-delete"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                onStrokesErase?.(selection);
                setSelection([]);
              }}
              className="absolute -right-3.5 -top-3.5 inline-flex items-center justify-center size-7 rounded-full bg-white/90 border border-black/10 shadow-sm text-red-500 hover:text-red-600 pointer-events-auto"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      )}
      {tool === "eraser" && eraserAt && (
        <span
          data-testid="eraser-ring"
          className="absolute rounded-full border-2 border-foreground/70 bg-white/30 pointer-events-none"
          style={{
            left: eraserAt.x * rect.width,
            top: eraserAt.y * rect.height,
            width: eraserAt.r * 2,
            height: eraserAt.r * 2,
            marginLeft: -eraserAt.r,
            marginTop: -eraserAt.r,
          }}
        />
      )}
    </div>
  );
}
