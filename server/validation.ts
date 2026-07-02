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

// --- Drawing annotations ---

export interface StrokeData {
  tool: "pen" | "highlighter";
  color: string;
  size: number;
  opacity: number;
  points: number[];
}

export type AnnotationsBySlide = Record<number, StrokeData[]>;

// Caps keep a malicious/buggy controller from ballooning server memory: the
// worst case per session is ~total_slides × 300 strokes × 2000 points.
export const MAX_STROKES_PER_SLIDE = 300;
const MAX_STROKE_POINTS = 4000; // flat x/y list => 2000 points

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// Coerce a stroke payload to known-good values, or null when malformed.
export function sanitizeStroke(raw: unknown): StrokeData | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Partial<StrokeData>;
  if (s.tool !== "pen" && s.tool !== "highlighter") return null;
  if (typeof s.color !== "string" || !/^#[0-9a-f]{6}$/i.test(s.color)) return null;
  if (typeof s.size !== "number" || !Number.isFinite(s.size)) return null;
  if (typeof s.opacity !== "number" || !Number.isFinite(s.opacity)) return null;
  if (!Array.isArray(s.points) || s.points.length < 2 || s.points.length % 2 !== 0) return null;
  if (s.points.length > MAX_STROKE_POINTS) return null;
  if (!s.points.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    tool: s.tool,
    color: s.color,
    size: clamp(s.size, 0.0002, 0.05),
    opacity: clamp(s.opacity, 0.05, 1),
    points: s.points.map((n) => clamp(n, 0, 1)),
  };
}

// Validate a full annotations map (controller reseeding the server after a
// restart, or loading a saved drawing). Returns null when the payload isn't
// even the right shape; invalid slides/strokes within it are dropped.
export function sanitizeAnnotations(raw: unknown, totalSlides: unknown): AnnotationsBySlide | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const result: AnnotationsBySlide = {};
  for (const [key, value] of Object.entries(raw)) {
    const slide = parseInt(key, 10);
    if (!isValidSlideNumber(slide, totalSlides) || !Array.isArray(value)) continue;
    const strokes = value
      .slice(0, MAX_STROKES_PER_SLIDE)
      .map(sanitizeStroke)
      .filter((s): s is StrokeData => s !== null);
    if (strokes.length) result[slide] = strokes;
  }
  return result;
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
