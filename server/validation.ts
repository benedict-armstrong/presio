import { createHash } from "crypto";

// Pure validation/sanitization helpers, factored out of the request/socket
// handlers so they can be unit-tested without a server or Supabase.

// Validate a user-supplied external PDF URL. This is a syntactic check only —
// scheme and shape — and deliberately says nothing about where the URL points.
//
// The value is mainly handed back to the client to fetch. It is also probed by
// the server for change detection (GET /api/sessions/:id/remote-version), and
// that path must NOT rely on this function for safety: dereferencing a
// visitor-supplied URL needs address-level checks, which live in
// lib/remotePdf.ts (isSafeRemoteUrl). Anything new that fetches a pdf_url
// server-side belongs behind that helper too.
export function isValidHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Light-touch email validation for the newsletter list: something@something.tld
// with sane length. Deliverability is not our problem here.
export function isValidEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
  );
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

// Upper bound on a deck's declared page count. total_slides is client-supplied
// at session creation and multiplies the annotation caps above, so it must be
// bounded; no real presentation comes close.
export const MAX_TOTAL_SLIDES = 3000;

export function isValidTotalSlides(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_TOTAL_SLIDES;
}

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

// --- Plugins ---
//
// The server never runs plugin code or looks inside plugin messages: it relays
// them between the presenter and the audience, keeps the presenter's "retained"
// messages for late joiners, and hands viewers the plugin bundles the presenter
// published. These caps bound what a controller or viewer can make it hold.

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLUGIN_TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MAX_PLUGIN_PAYLOAD_BYTES = 16 * 1024;
export const MAX_PLUGIN_HTML_BYTES = 512 * 1024;
export const MAX_PLUGINS_PER_SESSION = 8;
export const MAX_RETAINED_PER_PLUGIN = 32;

export interface PluginEvent {
  plugin: string;
  type: string;
  payload: unknown;
  retain: boolean;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  surfaces: string[];
  permissions: string[];
}

export interface PluginBundle {
  manifest: PluginManifest;
  html: string;
  hash: string;
}

// Size of a value once serialized, or Infinity when it can't be (cycles are
// impossible off the wire, but BigInt-like oddities aren't worth reasoning about).
function jsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Infinity;
  }
}

export function sanitizePluginEvent(raw: unknown): PluginEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.plugin !== "string" || !PLUGIN_ID_RE.test(e.plugin)) return null;
  if (typeof e.type !== "string" || !PLUGIN_TYPE_RE.test(e.type)) return null;
  const payload = e.payload === undefined ? null : e.payload;
  if (jsonSize(payload) > MAX_PLUGIN_PAYLOAD_BYTES) return null;
  return { plugin: e.plugin, type: e.type, payload, retain: e.retain === true };
}

// A plugin's resolved settings, as the presenter publishes them for viewers.
export function sanitizePluginSettings(raw: unknown): { plugin: string; settings: Record<string, unknown> } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.plugin !== "string" || !PLUGIN_ID_RE.test(e.plugin)) return null;
  const settings = e.settings;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;
  if (jsonSize(settings) > MAX_PLUGIN_PAYLOAD_BYTES) return null;
  return { plugin: e.plugin, settings: settings as Record<string, unknown> };
}

const shortString = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length <= max ? v : undefined;

// A published bundle: the manifest fields viewers need to label and mount the
// plugin, plus its single-file HTML. Only the controller can publish, but it is
// still client input, so everything is re-checked and re-built here.
export function sanitizePluginBundle(raw: unknown): PluginBundle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as { manifest?: Record<string, unknown>; html?: unknown };
  const m = b.manifest;
  if (typeof m !== "object" || m === null) return null;
  if (typeof m.id !== "string" || !PLUGIN_ID_RE.test(m.id)) return null;
  const name = shortString(m.name, 80);
  const version = shortString(m.version, 32);
  if (!name || !version) return null;
  const shortList = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length <= 32);
  if (!shortList(m.surfaces)) return null;
  const permissions = m.permissions === undefined ? [] : m.permissions;
  if (!shortList(permissions)) return null;
  if (typeof b.html !== "string" || Buffer.byteLength(b.html, "utf8") > MAX_PLUGIN_HTML_BYTES) return null;
  return {
    manifest: {
      id: m.id,
      name,
      version,
      author: shortString(m.author, 80),
      description: shortString(m.description, 300),
      surfaces: (m.surfaces as string[]).slice(0, 8),
      permissions: (permissions as string[]).slice(0, 8),
    },
    html: b.html,
    // Computed here rather than trusted from the client: viewers use it to
    // decide whether the copy they already mounted is still current.
    hash: createHash("sha256").update(b.html).digest("hex"),
  };
}
