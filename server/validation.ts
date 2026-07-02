// Pure validation/sanitization helpers, factored out of the request/socket
// handlers so they can be unit-tested without a server or Supabase.

// Validate a user-supplied external PDF URL. We only ever hand this back to the
// client to fetch (the server never requests it), so the bar is simply that it
// be a well-formed https URL — rejecting http:/data:/javascript: and garbage.
export function isValidHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export interface RawSettings {
  timerMode?: string | null;
  timerDuration?: number | null;
  timerThreshold?: number | null;
  notePrefix?: string;
}

export interface SanitizedSettings {
  timerMode: "up" | "down" | null;
  timerDuration: number | null;
  timerThreshold: number | null;
  notePrefix: string;
}

// Coerce a settings payload to known-good values so a malformed message can't
// corrupt the session row.
export function sanitizeSettings(settings: RawSettings): SanitizedSettings {
  const timerMode =
    settings.timerMode === "up" || settings.timerMode === "down" ? settings.timerMode : null;
  const sanitizeDuration = (n: number | null | undefined) =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  return {
    timerMode,
    timerDuration: sanitizeDuration(settings.timerDuration),
    timerThreshold: sanitizeDuration(settings.timerThreshold),
    notePrefix: typeof settings.notePrefix === "string" ? settings.notePrefix.slice(0, 100) : "note:",
  };
}

// A laser payload is either null (hide) or a normalized point. Returns the
// clamped point, or undefined when the payload is malformed and should be dropped.
export function sanitizeLaserPoint(payload: unknown): { x: number; y: number } | null | undefined {
  if (payload === null) return null;
  if (typeof payload !== "object") return undefined;
  const { x, y } = payload as { x?: unknown; y?: unknown };
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return { x: clamp(x), y: clamp(y) };
}

// A slide number is valid when it's a positive integer within the deck. When
// `total` is unknown (non-number) only the lower bound is enforced.
export function isValidSlideNumber(slideNumber: unknown, total: unknown): boolean {
  if (!Number.isInteger(slideNumber) || (slideNumber as number) < 1) return false;
  if (typeof total === "number" && (slideNumber as number) > total) return false;
  return true;
}
