import { MAX_TOTAL_SLIDES } from "../shared/limits.js";
import {
  jsonBytes,
  MAX_PLUGIN_MESSAGE_BYTES,
  PLUGIN_ID_RE,
  PLUGIN_TYPE_RE,
  SHA256_RE,
  type PublishedPlugin,
  type Retain,
} from "../shared/pluginProtocol.js";

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

// total_slides is client-supplied at session creation and bounds slide
// numbers, so it must be bounded (shared/limits.ts).
export function isValidTotalSlides(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_TOTAL_SLIDES;
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
// The limits, id rules and wire shapes live in shared/pluginProtocol.ts, which
// the client enforces too. These bound what a controller or viewer can make
// the server hold.

export interface PluginEvent {
  plugin: string;
  type: string;
  payload: unknown;
  retain: Retain;
  /** May be dropped for a backed-up viewer rather than queued. */
  volatile: boolean;
}

/** An untrusted payload's fields ({} when it isn't an object): socket
 *  handlers read what they need and check each value. */
export function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** A plugin message's fields, when it's an object naming a valid plugin id. */
function pluginMessage(raw: unknown): (Record<string, unknown> & { plugin: string }) | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  return typeof e.plugin === "string" && PLUGIN_ID_RE.test(e.plugin) ? (e as Record<string, unknown> & { plugin: string }) : null;
}

export function sanitizePluginEvent(raw: unknown): PluginEvent | null {
  const e = pluginMessage(raw);
  if (!e) return null;
  if (typeof e.type !== "string" || !PLUGIN_TYPE_RE.test(e.type)) return null;
  const payload = e.payload === undefined ? null : e.payload;
  if (jsonBytes(payload) > MAX_PLUGIN_MESSAGE_BYTES) return null;
  const retain = e.retain === true || e.retain === "deck" ? e.retain : false;
  return { plugin: e.plugin, type: e.type, payload, retain, volatile: e.volatile === true };
}

// A plugin's resolved settings, as the presenter publishes them for viewers.
export function sanitizePluginSettings(raw: unknown): { plugin: string; settings: Record<string, unknown> } | null {
  const e = pluginMessage(raw);
  if (!e) return null;
  const settings = e.settings;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;
  if (jsonBytes(settings) > MAX_PLUGIN_MESSAGE_BYTES) return null;
  return { plugin: e.plugin, settings: settings as Record<string, unknown> };
}

// A viewer couldn't load a plugin the presenter published: which (by id and
// the hash it was published with) and why, in a line for the presenter.
export function sanitizePluginLoadFailure(raw: unknown): { plugin: string; hash: string; reason: string } | null {
  const e = pluginMessage(raw);
  if (!e) return null;
  if (typeof e.hash !== "string" || !SHA256_RE.test(e.hash)) return null;
  const reason = typeof e.reason === "string" ? e.reason.slice(0, 200) : "";
  return { plugin: e.plugin, hash: e.hash, reason };
}

const shortString = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length <= max ? v : undefined;

// A published plugin: the manifest fields viewers need to label and mount it,
// where to load it from and the hash its page must match. Only the controller
// can publish, but it is still client input, so everything is re-checked here.
export function sanitizePublishedPlugin(raw: unknown): PublishedPlugin | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as { manifest?: Record<string, unknown>; url?: unknown; hash?: unknown };
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
  // A path on this deployment (built-ins, loaded by each viewer from its own
  // origin) or a web URL — nothing a browser would run as a script.
  const url = typeof b.url === "string" && b.url.length <= 2048 ? b.url : "";
  if (!/^(\/(?!\/)|https?:\/\/)/i.test(url)) return null;
  if (typeof b.hash !== "string" || !SHA256_RE.test(b.hash)) return null;
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
    url,
    hash: b.hash,
  };
}
