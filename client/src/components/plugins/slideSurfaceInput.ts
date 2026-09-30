// How a plugin's "slide" surface shares pointer input with the slide under
// it (see SlideSurface in SlideLayers.tsx). Each hook re-listens when
// `readyCount` changes: the plugin's document replaces the frame's.

import { useEffect, useRef, useState } from "react";
import type { SlidePage } from "@/lib/plugins/protocol";

type FrameRef = React.RefObject<HTMLIFrameElement | null>;

/** "pen" mode: touches this soon after the pen lifts are still the hand. */
const PALM_QUIET_MS = 250;
/** "pen" mode: what in a plugin's frame a finger works, rather than the slide. */
const PLUGIN_CONTROL = "button, a, input, select, textarea, [role='button'], [data-control]";

const inside = (regions: SlidePage[], fx: number, fy: number) =>
  regions.some((r) => fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h);

/** Whether nothing covers the frame at this point (a dialog, a menu): only
 *  then is a tap there meant for it. */
function onTop(frame: HTMLIFrameElement, x: number, y: number): boolean {
  const before = frame.style.pointerEvents;
  frame.style.pointerEvents = "auto";
  const hit = document.elementFromPoint(x, y);
  frame.style.pointerEvents = before;
  return hit === frame;
}

/**
 * Whether a mouse is over the page (presio.ui.onHover): over the frame when
 * it takes input, over what's under it when it doesn't. The presenter's only
 * (`enabled`) — it's for their own controls.
 */
export function useFrameHover(frameRef: FrameRef, enabled: boolean, readyCount: number): boolean {
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    const frame = frameRef.current;
    if (!enabled || !frame) return;
    let leaving: ReturnType<typeof setTimeout> | null = null;
    const settle = (over: boolean) => {
      if (leaving) clearTimeout(leaving);
      leaving = null;
      setHovered(over);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const box = frame.getBoundingClientRect();
      settle(e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom);
    };
    const onOut = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && !e.relatedTarget) settle(false);
    };
    // Leaving the frame looks the same whether the mouse went to the page
    // around it or out of the window; the page's own pointermove says which.
    const onInnerMove = (e: PointerEvent) => {
      if (e.pointerType === "mouse") settle(true);
    };
    const onInnerLeave = () => {
      if (leaving) clearTimeout(leaving);
      leaving = setTimeout(() => setHovered(false), 80);
    };
    const inner = frame.contentWindow;
    window.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerout", onOut);
    inner?.addEventListener("pointermove", onInnerMove);
    inner?.document.documentElement.addEventListener("pointerleave", onInnerLeave);
    return () => {
      if (leaving) clearTimeout(leaving);
      window.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerout", onOut);
      inner?.removeEventListener("pointermove", onInnerMove);
      inner?.document.documentElement.removeEventListener("pointerleave", onInnerLeave);
    };
  }, [frameRef, enabled, readyCount]);
  return hovered;
}

/**
 * Touches the frame took, passed on to the page once two are down: the
 * pinch-zoom (useSlidePinchZoom) listens above the frame, where input that
 * lands inside it never arrives. One finger stays the plugin's — except in
 * "pen" mode, where every finger is passed on from the start (to pan, pinch
 * and turn the page) and only a pen's input is the plugin's. There, a touch
 * while the pen is down, or just after, is a hand resting on the screen:
 * it's never passed on, and a pen landing ends what fingers had begun.
 */
export function usePinchHandoff(frameRef: FrameRef, enabled: boolean, penOnly: boolean, readyCount: number) {
  const penOnlyRef = useRef(penOnly);
  useEffect(() => {
    penOnlyRef.current = penOnly;
    const frame = frameRef.current;
    // For the page's own touch handling (useSlideTapNav, useSlidePinchZoom):
    // a finger double-tap here may be the plugin's, so taps wait for it.
    if (penOnly) frame?.setAttribute("data-pen-input", "");
    else frame?.removeAttribute("data-pen-input");
  }, [frameRef, penOnly]);
  useEffect(() => {
    const frame = frameRef.current;
    const inner = frame?.contentWindow;
    if (!enabled || !frame || !inner) return;
    const down = new Map<number, PointerEvent>();
    let forwarding = false;
    let pens = 0;
    let penAt = -Infinity;
    const forward = (type: string, e: PointerEvent) => {
      const box = frame.getBoundingClientRect();
      const scale = frame.clientWidth ? box.width / frame.clientWidth : 1;
      const x = box.left + e.clientX * scale;
      const y = box.top + e.clientY * scale;
      // To what the touch would have landed on without the frame (the slide,
      // which turns the page on a tap), else to the frame's box; both bubble
      // up to the pinch-zoom.
      const layer = frame.parentElement;
      const stack = document.elementsFromPoint(x, y);
      const at = stack.indexOf(frame);
      const under = at < 0 ? null : stack.slice(at + 1).find((el) => !layer?.contains(el));
      (under ?? layer)?.dispatchEvent(
        new PointerEvent(type, {
          pointerId: e.pointerId,
          pointerType: "touch",
          isPrimary: e.isPrimary,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        })
      );
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        pens++;
        penAt = performance.now();
        if (penOnlyRef.current && forwarding) for (const d of down.values()) forward("pointercancel", d);
        if (penOnlyRef.current) {
          down.clear();
          forwarding = false;
        }
        return;
      }
      if (e.pointerType !== "touch") return;
      if (penOnlyRef.current && (pens > 0 || performance.now() - penAt < PALM_QUIET_MS)) return;
      // The plugin's own controls (its buttons, a handle to drag) take a
      // finger even in "pen" mode.
      if (penOnlyRef.current && down.size === 0 && e.target instanceof Element && e.target.closest(PLUGIN_CONTROL)) return;
      down.set(e.pointerId, e);
      if (forwarding) forward("pointerdown", e);
      else if (down.size >= 2 || penOnlyRef.current) {
        forwarding = true;
        for (const d of down.values()) forward("pointerdown", d);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!down.has(e.pointerId)) return;
      down.set(e.pointerId, e);
      if (forwarding) forward("pointermove", e);
    };
    const onEnd = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        pens = Math.max(0, pens - 1);
        penAt = performance.now();
        return;
      }
      if (!down.delete(e.pointerId)) return;
      if (forwarding) forward(e.type, e);
      if (!down.size) forwarding = false;
    };
    inner.addEventListener("pointerdown", onDown, true);
    inner.addEventListener("pointermove", onMove, true);
    inner.addEventListener("pointerup", onEnd, true);
    inner.addEventListener("pointercancel", onEnd, true);
    return () => {
      inner.removeEventListener("pointerdown", onDown, true);
      inner.removeEventListener("pointermove", onMove, true);
      inner.removeEventListener("pointerup", onEnd, true);
      inner.removeEventListener("pointercancel", onEnd, true);
    };
  }, [frameRef, enabled, readyCount]);
}

/**
 * Input areas (presio.ui.setInteractive with boxes): whether the frame should
 * take input now ("hot"). A mouse makes it hot while hovering an area; a
 * touch, which has no hover, is forwarded into the frame instead. The setter
 * lets the caller cool it when the areas change.
 */
export function useRegionInput(frameRef: FrameRef, regions: SlidePage[] | null, readyCount: number) {
  const [hot, setHot] = useState(false);
  useEffect(() => {
    const frame = frameRef.current;
    if (!regions || !frame) return;
    const fraction = (clientX: number, clientY: number) => {
      const box = frame.getBoundingClientRect();
      return [(clientX - box.left) / box.width, (clientY - box.top) / box.height] as const;
    };
    const elementAt = (fx: number, fy: number) =>
      frame.contentDocument?.elementFromPoint(fx * frame.clientWidth, fy * frame.clientHeight);
    // Outside the frame's own input: where the pointer is over the page.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      setHot(inside(regions, ...fraction(e.clientX, e.clientY)));
    };
    // A touch on one of the areas is the plugin's, so the slide under it
    // mustn't take it too (as a tap to turn the page). It has no hover to
    // make the frame take input first, so its pointer events are forwarded
    // into the frame instead — all to the element it began on, as a touch's
    // are — and a tap arrives as a click (below). A second finger ends it:
    // two are for pinching.
    let touch: { id: number; target: Element } | null = null;
    const forward = (type: string, e: PointerEvent, target: Element) => {
      const inner = frame.contentWindow as (Window & typeof globalThis) | null;
      if (!inner) return;
      const [fx, fy] = fraction(e.clientX, e.clientY);
      target.dispatchEvent(
        new inner.PointerEvent(type, {
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          isPrimary: e.isPrimary,
          button: e.button,
          buttons: e.buttons,
          clientX: fx * frame.clientWidth,
          clientY: fy * frame.clientHeight,
          bubbles: true,
          cancelable: true,
          view: inner,
        })
      );
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      if (touch) {
        if (e.pointerId !== touch.id) {
          forward("pointercancel", e, touch.target);
          touch = null;
        }
        return;
      }
      const [fx, fy] = fraction(e.clientX, e.clientY);
      if (!inside(regions, fx, fy) || !onTop(frame, e.clientX, e.clientY)) return;
      e.stopPropagation();
      const target = elementAt(fx, fy);
      if (!target || !e.isPrimary) return;
      touch = { id: e.pointerId, target };
      forward("pointerdown", e, target);
    };
    const onTouchMove = (e: PointerEvent) => {
      if (!touch || e.pointerId !== touch.id) return;
      e.stopPropagation();
      forward("pointermove", e, touch.target);
    };
    const onTouchEnd = (e: PointerEvent) => {
      if (!touch || e.pointerId !== touch.id) return;
      e.stopPropagation();
      forward(e.type, e, touch.target);
      touch = null;
    };
    const onClick = (e: MouseEvent) => {
      const [fx, fy] = fraction(e.clientX, e.clientY);
      if (!inside(regions, fx, fy) || !onTop(frame, e.clientX, e.clientY)) return;
      const target = elementAt(fx, fy);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      // Dispatched rather than .click(): the point may be on an icon's SVG,
      // which has no click() of its own; the event bubbles to its button.
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: frame.contentWindow }));
    };
    // Inside it, while it's taking input (same origin, so its window is ours
    // to listen to): leaving the areas hands input back to the slide.
    const inner = frame.contentWindow;
    const onInnerMove = (e: PointerEvent) => {
      setHot(inside(regions, e.clientX / frame.clientWidth, e.clientY / frame.clientHeight));
    };
    const onInnerLeave = () => setHot(false);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onTouchMove, true);
    window.addEventListener("pointerup", onTouchEnd, true);
    window.addEventListener("pointercancel", onTouchEnd, true);
    window.addEventListener("click", onClick, true);
    inner?.addEventListener("pointermove", onInnerMove);
    inner?.document.documentElement.addEventListener("pointerleave", onInnerLeave);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onTouchMove, true);
      window.removeEventListener("pointerup", onTouchEnd, true);
      window.removeEventListener("pointercancel", onTouchEnd, true);
      window.removeEventListener("click", onClick, true);
      inner?.removeEventListener("pointermove", onInnerMove);
      inner?.document.documentElement.removeEventListener("pointerleave", onInnerLeave);
    };
  }, [frameRef, regions, readyCount]);
  return [hot, setHot] as const;
}
