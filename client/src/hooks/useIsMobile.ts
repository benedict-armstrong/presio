import { useState, useEffect } from "react";
import { lsGetString, lsSetString, STORAGE_KEYS } from "@/lib/storage";

// Hidden escape hatch: loading any page with ?desktop=1 forces the desktop
// layout on a phone/tablet; ?desktop=0 goes back to the responsive default.
// The choice sticks per device (localStorage), so it survives navigation.
// Evaluated once per page load — the param arrives via a full load anyway.
function readForceDesktop(): boolean {
  const param = new URLSearchParams(window.location.search).get("desktop");
  if (param !== null) {
    const on = param !== "0" && param !== "false";
    lsSetString(STORAGE_KEYS.forceDesktop, on ? "true" : "false");
    return on;
  }
  return lsGetString(STORAGE_KEYS.forceDesktop) === "true";
}
const forceDesktop = readForceDesktop();

export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(`(max-width: ${breakpoint}px)`).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpoint]);

  return isMobile && !forceDesktop;
}

// A phone held sideways has room across but almost none down, so the
// controller's card layout can't be the same as in portrait. Orientation
// rather than a width breakpoint, because that is the thing that changes.
export function useIsLandscape(): boolean {
  const [landscape, setLandscape] = useState(
    () => window.matchMedia("(orientation: landscape)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(orientation: landscape)");
    const onChange = (e: MediaQueryListEvent) => setLandscape(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return landscape;
}

// Touch-device detection for the first-visit prompts. Width alone misses
// tablets: an iPad in landscape is 1024px wide (1366px on a Pro), well past
// the 768px mobile breakpoint. The primary pointer being coarse (finger/stylus)
// is the reliable signal that the screen is touch-first, holds in any
// orientation, and stays false on desktop touch-laptops whose primary input is
// a mouse/trackpad. Respects the same ?desktop=1 override as useIsMobile.
export function isTouchDevice(): boolean {
  if (forceDesktop) return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

export function useIsTouchDevice(): boolean {
  const [isTouch, setIsTouch] = useState(isTouchDevice);

  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const onChange = () => setIsTouch(isTouchDevice());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isTouch;
}
