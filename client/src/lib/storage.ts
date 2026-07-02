// Typed, failure-tolerant wrappers around localStorage.
//
// Every read/write is guarded: private/incognito windows throw on access, and a
// corrupt value should never crash the UI. JSON helpers fall back to a default;
// string helpers fall back to a provided default. This replaces the
// hand-rolled `try { JSON.parse(localStorage.getItem(...)) } catch {}` dance
// that was duplicated across the app.

/** Static localStorage keys. Per-session keys (timer, session auth) are built
 *  from an id, so they're kept as factory functions rather than constants. */
export const STORAGE_KEYS = {
  keymap: "presio_keymap",
  // Mosaic binary-tree layout for the controller dashboard. A card is "visible"
  // iff it appears as a leaf in the tree, so visibility no longer needs its own
  // key (replaces the legacy controllerLayout/controllerCards array format).
  controllerMosaic: "presio_controller_mosaic",
  preferredMosaic: "presio_preferred_mosaic",
  controllerOnboarded: "presio_controller_onboarded",
  // Whether the mobile "best on desktop" notice has been dismissed.
  mobileNoticeSeen: "presio_mobile_notice_seen",
  // Last-used drawing color/width for the annotation tools.
  penStyle: "presio_pen_style",
  highlighterStyle: "presio_highlighter_style",
  // Whether the timer card also shows the current wall-clock time.
  timerShowClock: "presio_timer_show_clock",
} as const;

export const timerKey = (id: string) => `presio_timer_${id}`;
export const annotationsKey = (id: string) => `presio_annotations_${id}`;
export const sessionKey = (id: string) => `session_${id}`;
export const viewerOpenedKey = (id: string) => `presio_viewer_opened_${id}`;

/** Read and JSON-parse a value, returning `fallback` if absent or malformed. */
export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** JSON-stringify and store a value. Swallows storage errors. */
export function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode) — ignore */
  }
}

/** Read a raw string value, returning `fallback` if absent or unavailable. */
export function lsGetString(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Store a raw string value. Swallows storage errors. */
export function lsSetString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Remove a key. Swallows storage errors. */
export function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
