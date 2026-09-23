// User settings: one JSON document, in the spirit of VS Code's settings.json.
//
// Keys are dotted ("timer.mode"), and the document holds only what differs
// from the defaults, so an exported file reads as "what this presenter
// changed". Presio's own settings are declared in CORE_SETTINGS below; plugins
// contribute theirs through their manifest, namespaced by plugin id
// ("join-code.showUrl"). Values are validated on the way out, never trusted on
// the way in: an imported or hand-edited document can hold anything, and a bad
// value reads back as the default rather than breaking the app.
//
// Settings are preferences. Things the app merely remembers — the dashboard
// layout, dismissed prompts, anything per deck or per session — are state and
// stay in their own keys (lib/storage.ts), as VS Code keeps them out of
// settings.json too.

import { useCallback, useSyncExternalStore } from "react";
import { lsGet, lsSet, STORAGE_KEYS } from "./storage";
import { DEFAULT_KEYMAP, KEYMAP_ACTIONS, type KeyBinding, type Keymap } from "./keymap";
import { DEFAULT_HIGHLIGHTER_STYLE, DEFAULT_PEN_STYLE, type PenStyle } from "./annotations";

// --- Schema ---

/** How a setting is declared — by Presio here, and by plugins in their
 *  manifest's `contributes.settings` (which may not use "object"). */
export type SettingSpec =
  | { type: "boolean"; default: boolean; description?: string }
  | { type: "number"; default: number | null; minimum?: number; maximum?: number; description?: string }
  | { type: "string"; default: string; maxLength?: number; description?: string }
  | { type: "enum"; default: string; values: string[]; labels?: string[]; description?: string }
  | { type: "object"; default: unknown; description?: string };

/** Coerce a stored value to a spec, or undefined when it doesn't fit. */
export function sanitizeSettingValue(spec: SettingSpec, raw: unknown): unknown {
  switch (spec.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "number":
      if (raw === null && spec.default === null) return null;
      if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
      if (spec.minimum !== undefined && raw < spec.minimum) return undefined;
      if (spec.maximum !== undefined && raw > spec.maximum) return undefined;
      return raw;
    case "string":
      if (typeof raw !== "string") return undefined;
      return raw.length <= (spec.maxLength ?? 1000) ? raw : undefined;
    case "enum":
      return typeof raw === "string" && spec.values.includes(raw) ? raw : undefined;
    case "object":
      return raw;
  }
}

type CoreSpec<T> = SettingSpec & {
  default: T;
  /** Deeper validation for object values; the result is what reads return. */
  sanitize?: (raw: unknown) => T | undefined;
};

export type ThemeSetting = "system" | "light" | "dark";

export interface CoreSettings {
  theme: ThemeSetting;
  keybindings: Keymap;
  "timer.mode": "up" | "down";
  "timer.duration": number | null;
  "timer.warningThreshold": number | null;
  "timer.showClock": boolean;
  "notes.fontScale": number;
  "drawing.toolbar": boolean;
  "drawing.pen": PenStyle;
  "drawing.highlighter": PenStyle;
  "share.lanAddress": string;
  "home.minimal": boolean;
  "layout.forceDesktop": boolean;
  plugins: Record<string, { enabled: boolean }>;
}

export type CoreSettingKey = keyof CoreSettings;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function sanitizeKeymap(raw: unknown): Keymap | undefined {
  if (!isRecord(raw)) return undefined;
  const isBinding = (b: unknown): b is KeyBinding =>
    isRecord(b) && typeof b.key === "string" && b.key.length > 0 && (b.meta === undefined || typeof b.meta === "boolean");
  // Merged over the defaults, so a map saved before an action existed still
  // binds it.
  const km: Keymap = { ...DEFAULT_KEYMAP };
  for (const action of KEYMAP_ACTIONS) {
    const list = raw[action];
    if (Array.isArray(list) && list.every(isBinding)) {
      km[action] = list.map((b) => (b.meta ? { key: b.key, meta: true } : { key: b.key }));
    }
  }
  return km;
}

function sanitizePenStyle(raw: unknown): PenStyle | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.color !== "string" || !/^#[0-9a-f]{6}$/i.test(raw.color)) return undefined;
  if (typeof raw.size !== "number" || !Number.isFinite(raw.size) || raw.size <= 0 || raw.size > 0.05) return undefined;
  return { color: raw.color, size: raw.size };
}

function sanitizePluginList(raw: unknown): CoreSettings["plugins"] | undefined {
  if (!isRecord(raw)) return undefined;
  const out: CoreSettings["plugins"] = {};
  for (const [url, entry] of Object.entries(raw)) {
    if (isRecord(entry) && typeof entry.enabled === "boolean") out[url] = { enabled: entry.enabled };
  }
  return out;
}

export const CORE_SETTINGS: { [K in CoreSettingKey]: CoreSpec<CoreSettings[K]> } = {
  theme: {
    type: "enum",
    values: ["system", "light", "dark"],
    default: "system",
    description: "Color theme. \"system\" follows the operating system.",
  },
  keybindings: {
    type: "object",
    default: DEFAULT_KEYMAP,
    sanitize: sanitizeKeymap,
    description: "Controller keyboard shortcuts, per action: a list of { key, meta? }.",
  },
  "timer.mode": {
    type: "enum",
    values: ["up", "down"],
    default: "up",
    description: "Count the talk up from zero, or down from timer.duration.",
  },
  "timer.duration": {
    type: "number",
    default: null,
    minimum: 1,
    description: "Countdown length in seconds (timer.mode \"down\").",
  },
  "timer.warningThreshold": {
    type: "number",
    default: null,
    minimum: 1,
    description: "Seconds at which the timer turns to a warning: remaining time counting down, elapsed time counting up.",
  },
  "timer.showClock": {
    type: "boolean",
    default: false,
    description: "Also show the wall-clock time on the timer card.",
  },
  "notes.fontScale": {
    type: "number",
    default: 1,
    minimum: 0.75,
    maximum: 2.5,
    description: "Speaker notes text size multiplier.",
  },
  "drawing.toolbar": {
    type: "boolean",
    default: true,
    description: "Show the drawing and laser toolbar on the current slide.",
  },
  "drawing.pen": {
    type: "object",
    default: DEFAULT_PEN_STYLE,
    sanitize: sanitizePenStyle,
    description: "Pen color (#rrggbb) and width (fraction of the slide width).",
  },
  "drawing.highlighter": {
    type: "object",
    default: DEFAULT_HIGHLIGHTER_STYLE,
    sanitize: sanitizePenStyle,
    description: "Highlighter color (#rrggbb) and width (fraction of the slide width).",
  },
  "share.lanAddress": {
    type: "string",
    default: "",
    maxLength: 253,
    description: "This machine's address on the local network, used in share links when Presio is opened over localhost.",
  },
  "home.minimal": {
    type: "boolean",
    default: false,
    description: "Strip the landing page down to the drop zone.",
  },
  "layout.forceDesktop": {
    type: "boolean",
    default: false,
    description: "Use the desktop layout on phones and tablets too (also set by ?desktop=1).",
  },
  plugins: {
    type: "object",
    default: {},
    sanitize: sanitizePluginList,
    description: "Added plugins by URL, and which plugins are enabled.",
  },
};

/** Top-level sections Presio uses; plugin ids may not take these names. */
export const RESERVED_SETTING_SECTIONS = new Set([
  "presio",
  ...Object.keys(CORE_SETTINGS).map((key) => key.split(".")[0]),
]);

// --- Store ---

type Doc = Record<string, unknown>;

const listeners = new Set<() => void>();
// Loaded on first use rather than at import, so migration runs only once
// something actually reads a setting.
let loaded: Doc | null = null;
const current = (): Doc => (loaded ??= loadDoc());
// Resolved values by key, cleared whenever the document changes, so reads
// hand back a stable identity for useSyncExternalStore.
const resolved = new Map<string, unknown>();

function loadDoc(): Doc {
  const stored = lsGet<unknown>(STORAGE_KEYS.settings, undefined);
  if (isRecord(stored)) return stored;
  const migrated = migrateLegacySettings();
  lsSet(STORAGE_KEYS.settings, migrated);
  return migrated;
}

function commit(next: Doc) {
  loaded = next;
  resolved.clear();
  lsSet(STORAGE_KEYS.settings, next);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Another window changed the document (the viewer popup, a second tab).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEYS.settings) return;
    const stored = lsGet<unknown>(STORAGE_KEYS.settings, {});
    loaded = isRecord(stored) ? stored : {};
    resolved.clear();
    listeners.forEach((l) => l());
  });
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function getSetting<K extends CoreSettingKey>(key: K): CoreSettings[K] {
  if (resolved.has(key)) return resolved.get(key) as CoreSettings[K];
  const spec = CORE_SETTINGS[key] as CoreSpec<CoreSettings[K]>;
  const raw = current()[key];
  let value: CoreSettings[K] | undefined;
  if (raw !== undefined) {
    value = spec.sanitize
      ? spec.sanitize(raw)
      : (sanitizeSettingValue(spec, raw) as CoreSettings[K] | undefined);
  }
  const out = value ?? spec.default;
  resolved.set(key, out);
  return out;
}

export function setSetting<K extends CoreSettingKey>(key: K, value: CoreSettings[K]) {
  setRawSetting(key, sameValue(value, CORE_SETTINGS[key].default) ? undefined : value);
}

/** Write any key as-is (undefined removes it). For plugin settings, whose
 *  specs the store doesn't know; callers validate. */
export function setRawSetting(key: string, value: unknown) {
  const next = { ...current() };
  if (value === undefined) delete next[key];
  else next[key] = value;
  commit(next);
}

export function useSetting<K extends CoreSettingKey>(key: K): [CoreSettings[K], (value: CoreSettings[K]) => void] {
  const value = useSyncExternalStore(subscribe, () => getSetting(key));
  const set = useCallback((next: CoreSettings[K]) => setSetting(key, next), [key]);
  return [value, set];
}

/** The raw document: what's stored, defaults omitted. */
export function useSettingsDocument(): Doc {
  return useSyncExternalStore(subscribe, current);
}

/**
 * A plugin's settings, resolved against the specs it contributes: every
 * declared name, with the stored value where it's valid and the default
 * otherwise. Keys in the document are `<pluginId>.<name>`.
 */
export function resolvePluginSettings(
  pluginId: string,
  specs: Record<string, SettingSpec>,
  source: Doc = current()
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const raw = source[`${pluginId}.${name}`];
    const value = raw === undefined ? undefined : sanitizeSettingValue(spec, raw);
    out[name] = value === undefined ? spec.default : value;
  }
  return out;
}

export function setPluginSetting(pluginId: string, name: string, spec: SettingSpec, value: unknown) {
  const key = `${pluginId}.${name}`;
  if (sameValue(value, spec.default)) setRawSetting(key, undefined);
  else if (sanitizeSettingValue(spec, value) !== undefined) setRawSetting(key, value);
}

/** The document as a settings.json file. */
export function exportSettings(): string {
  return `${JSON.stringify(current(), null, 2)}\n`;
}

/**
 * Replace the document with an imported settings.json. Only the shape is
 * checked here (an object of keys): values are validated when read, and keys
 * this build doesn't know — a plugin not installed here yet — are kept.
 */
export function importSettings(text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!isRecord(parsed)) throw new Error("A settings file is a JSON object of settings.");
  commit(parsed);
}

// --- Migration ---

/**
 * Build the first document from the keys each setting used to live under,
 * then drop them. Runs once per browser: after this the document exists.
 * Values go through the same validation as any read, so a corrupt legacy value
 * is simply left behind.
 */
function migrateLegacySettings(): Doc {
  const out: Doc = {};
  const read = (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const json = (key: string): unknown => {
    const raw = read(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const put = <K extends CoreSettingKey>(key: K, raw: unknown) => {
    if (raw === undefined || (raw === null && CORE_SETTINGS[key].default !== null)) return;
    const spec = CORE_SETTINGS[key] as CoreSpec<CoreSettings[K]>;
    const value = spec.sanitize ? spec.sanitize(raw) : sanitizeSettingValue(spec, raw);
    if (value !== undefined && !sameValue(value, spec.default)) out[key] = value;
  };

  put("theme", read("theme") ?? undefined);
  put("keybindings", json("presio_keymap"));
  const timer = json("presio_timer_settings");
  if (isRecord(timer)) {
    put("timer.mode", timer.mode);
    put("timer.duration", timer.duration);
    put("timer.warningThreshold", timer.threshold);
  }
  if (read("presio_timer_show_clock") !== null) put("timer.showClock", read("presio_timer_show_clock") === "true");
  put("notes.fontScale", json("presio_notes_font_scale"));
  if (read("presio_annotation_toolbar") !== null) put("drawing.toolbar", read("presio_annotation_toolbar") !== "false");
  put("drawing.pen", json("presio_pen_style"));
  put("drawing.highlighter", json("presio_highlighter_style"));
  put("share.lanAddress", read("presio_lan_address") ?? undefined);
  put("home.minimal", json("presio_home_minimal"));
  if (read("presio_force_desktop") !== null) put("layout.forceDesktop", read("presio_force_desktop") === "true");

  for (const key of LEGACY_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch { /* storage unavailable */ }
  }
  return out;
}

const LEGACY_KEYS = [
  "theme",
  "presio_keymap",
  "presio_timer_settings",
  "presio_timer_show_clock",
  "presio_notes_font_scale",
  "presio_annotation_toolbar",
  "presio_pen_style",
  "presio_highlighter_style",
  "presio_lan_address",
  "presio_home_minimal",
  "presio_force_desktop",
  // Plugin list from before it moved into settings (never released).
  "presio_plugins",
];
