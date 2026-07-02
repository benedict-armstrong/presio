import { useState, useEffect, useRef, useCallback } from "react";
import { contentRectFor, clamp01, type ContentRect, type LaserPoint, type Tool } from "@/lib/annotations";

// How often the controller streams pointer positions outward, and how long a
// viewer keeps showing a dot that stopped moving (covers dropped "hide" events).
const EMIT_INTERVAL_MS = 33;
const REMOTE_HIDE_MS = 3000;

interface Props {
  /** The div the slide canvas is rendered into (letterboxed via object-fit). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Active tool — only the controller passes anything but "none". */
  tool?: Tool;
  /** Controller: stream the laser position (null = pointer left the slide). */
  onLaserMove?: (pt: LaserPoint | null) => void;
  /** Laser position received from the other side (viewer windows). */
  remoteLaser?: LaserPoint | null;
}

// Transparent layer stretched over the slide's content rect. It renders laser
// dots (local while pointing, remote as received) and, when a tool is active,
// captures pointer events so mouse/touch/pencil input maps to normalized slide
// coordinates. With no active tool it is click-through.
export function AnnotationOverlay({ containerRef, tool = "none", onLaserMove, remoteLaser }: Props) {
  const [rect, setRect] = useState<ContentRect | null>(null);
  const [localLaser, setLocalLaser] = useState<LaserPoint | null>(null);
  const [remoteVisible, setRemoteVisible] = useState(false);
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

  const emitLaser = useCallback(
    (pt: LaserPoint | null) => {
      if (!onLaserMove) return;
      const now = Date.now();
      // Always send hides immediately; throttle the movement stream.
      if (pt !== null && now - lastEmit.current < EMIT_INTERVAL_MS) return;
      lastEmit.current = now;
      onLaserMove(pt);
    },
    [onLaserMove]
  );

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (tool !== "laser") return;
    const pt = toNormalized(e);
    setLocalLaser(pt);
    emitLaser(pt);
  };

  const onPointerLeave = () => {
    if (tool !== "laser") return;
    setLocalLaser(null);
    onLaserMove?.(null);
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
      onPointerMove={onPointerMove}
      onPointerDown={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {tool === "laser" && localLaser && dot(localLaser, "local")}
      {remoteVisible && remoteLaser && dot(remoteLaser, "remote")}
    </div>
  );
}
