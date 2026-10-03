// Finger taps on the slide that mean something to the drawing (from Tristan
// Gabl's Apple Pencil work, #125):
//
//  - a double-tap with one finger: the stand-in for the Apple Pencil's own
//    double-tap, which browsers don't expose (pencil mode only);
//  - a double-tap with two fingers together: undo.
//
// Watched in the capture phase, so touches Presio takes for pinching still
// count. Taps with the pen down, or just after it (a resting palm), never do,
// and taps on the palette are the palette's.

// A tap: released quickly, barely moved.
const MAX_TAP_MS = 250;
const MAX_TWO_FINGER_TAP_MS = 350;
const MAX_TAP_SLOP_PX = 12;
// The most time between one tap's release and the next one's touch.
const DOUBLE_TAP_MS = 350;
// Touches this soon after the pen are the palm.
const PEN_QUIET_MS = 250;

export function watchTaps(opts: {
  /** Whether a one-finger double-tap counts now. */
  oneFinger: () => boolean;
  onDoubleTap: (x: number, y: number) => void;
  /** Whether a two-finger double-tap counts now. */
  twoFinger: () => boolean;
  onTwoFingerDoubleTap: () => void;
  /** Taps here are someone else's (the palette). */
  ignore: (target: EventTarget | null) => boolean;
}) {
  const touches = new Map<number, { x: number; y: number; t: number }>();
  let multi = false;
  let penDown = 0;
  let lastPenAt = -Infinity;
  let lastTap: number | null = null;
  // The current touch group: from the first finger down until all are up.
  let group: { t: number; max: number; moved: boolean } | null = null;
  let lastTwoTap: number | null = null;

  window.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "pen") {
        // A group that the pen touches down during is a resting palm.
        if (group) group.moved = true;
        penDown++;
        lastPenAt = performance.now();
        lastTap = null;
        return;
      }
      if (e.pointerType !== "touch" || opts.ignore(e.target)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      if (!group) group = { t: performance.now(), max: 0, moved: penDown > 0 };
      group.max = Math.max(group.max, touches.size);
      if (touches.size > 1) {
        multi = true;
        lastTap = null;
      }
    },
    true
  );

  const up = (e: PointerEvent) => {
    if (e.pointerType === "pen") {
      penDown = Math.max(0, penDown - 1);
      lastPenAt = performance.now();
      return;
    }
    const start = touches.get(e.pointerId);
    if (!start) return;
    touches.delete(e.pointerId);
    if (e.type === "pointercancel") {
      if (!touches.size) {
        multi = false;
        group = null;
      }
      lastTap = lastTwoTap = null;
      return;
    }
    const wasMulti = multi;
    if (!touches.size) multi = false;
    const now = performance.now();
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > MAX_TAP_SLOP_PX;
    if (group && moved) group.moved = true;
    if (wasMulti) {
      if (touches.size || !group) return;
      // The last finger of a group lifted: was it a clean two-finger tap?
      const g = group;
      group = null;
      const twoTap = g.max === 2 && !g.moved && penDown === 0 && now - g.t <= MAX_TWO_FINGER_TAP_MS && opts.twoFinger();
      if (!twoTap) lastTwoTap = null;
      else if (lastTwoTap !== null && g.t - lastTwoTap <= DOUBLE_TAP_MS) {
        lastTwoTap = null;
        opts.onTwoFingerDoubleTap();
      } else lastTwoTap = now;
      return;
    }
    if (!touches.size) group = null;
    lastTwoTap = null;
    const isTap = penDown === 0 && start.t - lastPenAt > PEN_QUIET_MS && now - start.t <= MAX_TAP_MS && !moved;
    if (!isTap || !opts.oneFinger()) {
      lastTap = null;
      return;
    }
    if (lastTap !== null && start.t - lastTap <= DOUBLE_TAP_MS) {
      lastTap = null;
      opts.onDoubleTap(e.clientX, e.clientY);
      return;
    }
    lastTap = now;
  };
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
}
