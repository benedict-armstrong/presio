import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// A tap: one finger, released quickly, barely moved.
const MAX_TAP_MS = 250;
const MAX_TAP_SLOP_PX = 12;
// The most time between the first tap's release and the second tap's touch.
const DOUBLE_TAP_MS = 350;
// Touches this close to pencil activity are the palm, never a tap.
const PEN_QUIET_MS = 250;
// Taps on controls over the slide (the tool palette) belong to them.
const INTERACTIVE_SELECTOR = "button, a, input, textarea, select, [role='button'], [data-testid='toolbar-drag']";

// Two fingers landing together may be a little staggered and slower to lift.
const MAX_TWO_FINGER_TAP_MS = 350;

interface FingerDoubleTapOptions {
  enabled: boolean;
  /** Called with where the second tap landed (client coordinates). */
  onDoubleTap: (x: number, y: number) => void;
  /** Two-finger double-tap (both fingers tap together, twice). */
  twoFingerEnabled?: boolean;
  onTwoFingerDoubleTap?: () => void;
}

// Detect a single-finger double-tap anywhere on the slide — the web stand-in
// for the Apple Pencil's own double-tap, which Safari doesn't expose. Listens
// in the capture phase on the surface so it still sees touches that the
// pinch/pan gesture has captured. Taps with a second finger down, or around
// pencil strokes (a resting palm), never count. A double-tap with two fingers
// together is reported separately.
export function useFingerDoubleTap(
  ref: RefObject<HTMLElement | null>,
  options: FingerDoubleTapOptions
) {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const touches = new Map<number, { x: number; y: number; t: number }>();
    let multi = false;
    let penDown = 0;
    let lastPenAt = -Infinity;
    let lastTap: { t: number } | null = null;
    // The current touch group: from the first finger down until all are up.
    let group: { t: number; max: number; moved: boolean } | null = null;
    let lastTwoTap: number | null = null;

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        // A group that the pencil touches down during is a resting palm.
        if (group) group.moved = true;
        penDown++;
        lastPenAt = performance.now();
        lastTap = null;
        return;
      }
      if (e.pointerType !== "touch") return;
      if (e.target instanceof Element && e.target.closest(INTERACTIVE_SELECTOR)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      if (!group) group = { t: performance.now(), max: 0, moved: penDown > 0 };
      group.max = Math.max(group.max, touches.size);
      if (touches.size > 1) {
        multi = true;
        lastTap = null;
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        penDown = Math.max(0, penDown - 1);
        lastPenAt = performance.now();
        return;
      }
      const start = touches.get(e.pointerId);
      if (!start) return;
      touches.delete(e.pointerId);
      const wasMulti = multi;
      if (touches.size === 0) multi = false;
      const now = performance.now();
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > MAX_TAP_SLOP_PX;
      if (group && moved) group.moved = true;
      if (wasMulti) {
        if (touches.size > 0 || !group) return;
        // Last finger of a group lifted: was it a clean two-finger tap?
        const g = group;
        group = null;
        const twoTap =
          g.max === 2 &&
          !g.moved &&
          // No quiet period after the pencil here: undo right after a
          // stroke is the point. Overlapping the pencil is ruled out above.
          penDown === 0 &&
          now - g.t <= MAX_TWO_FINGER_TAP_MS &&
          !!optionsRef.current.twoFingerEnabled;
        if (!twoTap) {
          lastTwoTap = null;
          return;
        }
        if (lastTwoTap !== null && g.t - lastTwoTap <= DOUBLE_TAP_MS) {
          lastTwoTap = null;
          optionsRef.current.onTwoFingerDoubleTap?.();
          return;
        }
        lastTwoTap = now;
        return;
      }
      if (touches.size === 0) group = null;
      lastTwoTap = null;
      const isTap =
        !wasMulti &&
        penDown === 0 &&
        start.t - lastPenAt > PEN_QUIET_MS &&
        now - start.t <= MAX_TAP_MS &&
        !moved;
      if (!isTap || !optionsRef.current.enabled) {
        lastTap = null;
        return;
      }
      if (lastTap && start.t - lastTap.t <= DOUBLE_TAP_MS) {
        lastTap = null;
        optionsRef.current.onDoubleTap(e.clientX, e.clientY);
        return;
      }
      lastTap = { t: now };
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerType === "pen") penDown = Math.max(0, penDown - 1);
      touches.delete(e.pointerId);
      if (touches.size === 0) {
        multi = false;
        group = null;
      }
      lastTap = null;
      lastTwoTap = null;
    };

    el.addEventListener("pointerdown", onPointerDown, true);
    el.addEventListener("pointerup", onPointerUp, true);
    el.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown, true);
      el.removeEventListener("pointerup", onPointerUp, true);
      el.removeEventListener("pointercancel", onPointerCancel, true);
    };
  }, [ref]);
}
