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
