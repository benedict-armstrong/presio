// Plugin manifests (presio-plugin.json). A plugin is one self-contained HTML
// file plus this manifest; it runs sandboxed in plugin-frame.html and talks to
// Presio only through `window.presio` (see public/plugin-frame.html and
// lib/plugins/host.ts). Mirrors schema/plugin-manifest.schema.json.
//
// Like a VS Code extension, a plugin never touches Presio's own interface: it
// *declares* what it adds (buttons, settings) and Presio draws it.

import { RESERVED_SETTING_SECTIONS, sanitizeSettingValue, type SettingSpec } from "@/lib/settings";

/** Where a plugin runs. The same HTML runs in each; presio.surface says which. */
export type PluginSurface =
  /** Hidden, on the presenter's device, for as long as the deck is open. The
   *  place to keep state and handle contributed buttons. */
  | "background"
  /** A card of its own on the presenter's dashboard. */
  | "tile"
  /** A full-screen layer on every viewer screen, hidden until the plugin
   *  asks to be shown (presio.ui.setVisible). */
  | "viewer";

export type PluginPermission =
  /** Read the deck's embedded attachments (presio.deck.attachments()). */
  "deck";

/** Where a contributed button can go. */
export type ButtonLocation =
  /** The controller's bottom bar, beside Sync All / Show Code. */
  "controller.toolbar";

export interface ButtonContribution {
  id: string;
  label: string;
  /** One of PLUGIN_ICONS; buttons without one are text-only. */
  icon?: string;
  tooltip?: string;
  location: ButtonLocation;
}

/** A setting a plugin declares; stored as "<plugin id>.<name>". */
export type PluginSettingSpec = Exclude<SettingSpec, { type: "object" }>;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  /** The plugin's HTML file, relative to the manifest. */
  main: string;
  surfaces: PluginSurface[];
  /** When the plugin runs for a deck: "always", or "attachment:<glob>" to run
   *  only when the PDF carries a matching attachment (e.g. "attachment:poll-*.json"). */
  activation: string[];
  permissions: PluginPermission[];
  contributes: {
    buttons: ButtonContribution[];
    settings: Record<string, PluginSettingSpec>;
  };
}

/** Icons a contributed button may name (drawn from Presio's own icon set). */
export const PLUGIN_ICONS = [
  "qr-code", "bar-chart", "message", "users", "timer", "bell", "star", "sparkles", "hand", "check", "eye", "megaphone",
] as const;

/** A plugin ready to mount: its manifest and HTML. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  html: string;
  /** SHA-256 of `html`, as the server computes it for published bundles. */
  hash: string;
}

const SURFACES: PluginSurface[] = ["background", "tile", "viewer"];
const BUTTON_LOCATIONS: ButtonLocation[] = ["controller.toolbar"];
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PERMISSIONS: PluginPermission[] = ["deck"];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate a parsed presio-plugin.json, throwing a readable error. */
export function parseManifest(raw: unknown): PluginManifest {
  if (typeof raw !== "object" || raw === null) throw new Error("presio-plugin.json is not an object");
  const m = raw as Record<string, unknown>;
  const str = (key: string, max: number, required = true): string | undefined => {
    const v = m[key];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || !v || v.length > max) {
      throw new Error(`presio-plugin.json: "${key}" must be a string of at most ${max} characters`);
    }
    return v;
  };
  const id = str("id", 64)!;
  if (!ID_RE.test(id)) throw new Error('presio-plugin.json: "id" must be lowercase letters, digits and dashes');
  if (RESERVED_SETTING_SECTIONS.has(id)) throw new Error(`presio-plugin.json: "${id}" is reserved by Presio`);
  const list = <T extends string>(key: string, allowed?: readonly T[]): T[] => {
    const v = m[key] ?? [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      throw new Error(`presio-plugin.json: "${key}" must be a list of strings`);
    }
    if (allowed) {
      const unknown = v.find((x) => !allowed.includes(x as T));
      if (unknown) throw new Error(`presio-plugin.json: unknown ${key} entry "${unknown}"`);
    }
    return v as T[];
  };
  const main = str("main", 200, false) ?? "index.html";
  if (/^[a-z]+:|^\/|\.\./i.test(main)) throw new Error('presio-plugin.json: "main" must be a relative path');
  const surfaces = list("surfaces", SURFACES);
  const contributes = parseContributes(m.contributes);
  if (contributes.buttons.length && !surfaces.includes("background") && !surfaces.includes("tile")) {
    throw new Error('presio-plugin.json: buttons need a "background" or "tile" surface to handle them');
  }
  return {
    id,
    name: str("name", 80)!,
    version: str("version", 32)!,
    author: str("author", 80, false),
    description: str("description", 300, false),
    main,
    surfaces,
    activation: list("activation"),
    permissions: list("permissions", PERMISSIONS),
    contributes,
  };
}

function parseContributes(raw: unknown): PluginManifest["contributes"] {
  const fail = (msg: string): never => {
    throw new Error(`presio-plugin.json: contributes.${msg}`);
  };
  if (raw === undefined) return { buttons: [], settings: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("must be an object");
  const c = raw as Record<string, unknown>;

  const buttons: ButtonContribution[] = [];
  if (c.buttons !== undefined) {
    if (!Array.isArray(c.buttons) || c.buttons.length > 4) fail("buttons must be a list of at most 4");
    for (const b of c.buttons as unknown[]) {
      const btn = (typeof b === "object" && b !== null ? b : {}) as Record<string, unknown>;
      if (typeof btn.id !== "string" || !NAME_RE.test(btn.id)) fail("buttons: each needs an \"id\" (letters and digits)");
      if (typeof btn.label !== "string" || !btn.label || btn.label.length > 24) fail(`buttons.${btn.id}: "label" must be 1–24 characters`);
      if (!BUTTON_LOCATIONS.includes(btn.location as ButtonLocation)) fail(`buttons.${btn.id}: "location" must be one of ${BUTTON_LOCATIONS.join(", ")}`);
      if (btn.icon !== undefined && !(PLUGIN_ICONS as readonly unknown[]).includes(btn.icon)) {
        fail(`buttons.${btn.id}: unknown icon "${String(btn.icon)}" (one of ${PLUGIN_ICONS.join(", ")})`);
      }
      if (btn.tooltip !== undefined && (typeof btn.tooltip !== "string" || btn.tooltip.length > 120)) fail(`buttons.${btn.id}: "tooltip" must be a string`);
      if (buttons.some((x) => x.id === btn.id)) fail(`buttons: duplicate id "${btn.id}"`);
      buttons.push({
        id: btn.id as string,
        label: btn.label as string,
        icon: btn.icon as string | undefined,
        tooltip: btn.tooltip as string | undefined,
        location: btn.location as ButtonLocation,
      });
    }
  }

  const settings: Record<string, PluginSettingSpec> = {};
  if (c.settings !== undefined) {
    if (typeof c.settings !== "object" || c.settings === null || Array.isArray(c.settings)) fail("settings must be an object");
    const entries = Object.entries(c.settings as Record<string, unknown>);
    if (entries.length > 32) fail("settings: at most 32");
    for (const [name, rawSpec] of entries) {
      if (!NAME_RE.test(name)) fail(`settings: "${name}" must be letters and digits`);
      settings[name] = parseSettingSpec(name, rawSpec, fail);
    }
  }
  return { buttons, settings };
}

function parseSettingSpec(name: string, raw: unknown, fail: (msg: string) => never): PluginSettingSpec {
  if (typeof raw !== "object" || raw === null) fail(`settings.${name} must be an object`);
  const r = raw as Record<string, unknown>;
  const description = typeof r.description === "string" ? r.description.slice(0, 300) : undefined;
  let spec: PluginSettingSpec;
  switch (r.type) {
    case "boolean":
      spec = { type: "boolean", default: r.default as boolean, description };
      break;
    case "number": {
      const bound = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      spec = { type: "number", default: r.default as number, minimum: bound(r.minimum), maximum: bound(r.maximum), description };
      break;
    }
    case "string":
      spec = { type: "string", default: r.default as string, maxLength: Math.min(bound1000(r.maxLength), 1000), description };
      break;
    case "enum": {
      const values = r.values;
      if (!Array.isArray(values) || !values.length || !values.every((v) => typeof v === "string")) {
        fail(`settings.${name}: an enum needs "values", a list of strings`);
      }
      const labels = Array.isArray(r.labels) && r.labels.every((v) => typeof v === "string") ? (r.labels as string[]) : undefined;
      spec = { type: "enum", default: r.default as string, values: values as string[], labels, description };
      break;
    }
    default:
      fail(`settings.${name}: "type" must be boolean, number, string or enum`);
  }
  // The default has to satisfy its own spec, or every read would be invalid.
  if (sanitizeSettingValue(spec!, spec!.default) === undefined) fail(`settings.${name}: "default" doesn't match its type`);
  return spec!;
}

function bound1000(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 1000;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Whether a plugin should run for a deck with these attachment filenames. */
export function isActivatedBy(manifest: PluginManifest, attachmentNames: readonly string[]): boolean {
  return manifest.activation.some((rule) => {
    if (rule === "always") return true;
    if (rule.startsWith("attachment:")) {
      const re = globToRegExp(rule.slice("attachment:".length));
      return attachmentNames.some((name) => re.test(name));
    }
    return false;
  });
}
