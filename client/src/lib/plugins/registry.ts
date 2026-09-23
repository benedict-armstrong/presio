// The presenter's installed plugins: which exist and which are switched on
// (the "plugins" setting).
//
// A plugin is addressed by the base URL its presio-plugin.json sits under.
// Built-ins ship with the app under /plugins/, and a presenter can add any
// other URL — typically their own dev server while building one. Nothing runs
// until a plugin is both enabled here and activated by the deck on screen.

import { useMemo } from "react";
import { getSetting, setSetting, useSetting, type CoreSettings } from "@/lib/settings";
import { sha256Hex } from "@/lib/analytics";
import { parseManifest, type LoadedPlugin } from "./manifest";

export interface PluginEntry {
  /** Base URL, ending in "/". */
  url: string;
  enabled: boolean;
  builtin: boolean;
}

/** Shipped with the app; off until the presenter turns one on. */
const BUILTIN_URLS = ["/plugins/join-code/"];

// The "plugins" setting maps URL -> { enabled }. Built-ins appear in it only
// once toggled; everything else is in it because it was added.
function entriesFrom(list: CoreSettings["plugins"]): PluginEntry[] {
  const builtins = BUILTIN_URLS.map((url) => ({ url, enabled: !!list[url]?.enabled, builtin: true }));
  const added = Object.entries(list)
    .filter(([url]) => !BUILTIN_URLS.includes(url))
    .map(([url, { enabled }]) => ({ url, enabled, builtin: false }));
  return [...builtins, ...added];
}

export function usePluginEntries(): PluginEntry[] {
  const [list] = useSetting("plugins");
  return useMemo(() => entriesFrom(list), [list]);
}

export function setPluginEnabled(url: string, enabled: boolean) {
  setSetting("plugins", { ...getSetting("plugins"), [url]: { enabled } });
}

export function removePlugin(url: string) {
  const list = { ...getSetting("plugins") };
  delete list[url];
  setSetting("plugins", list);
}

/**
 * Normalize a presenter-entered plugin location to a base URL, or throw.
 * https anywhere, or plain http on this machine for a dev server.
 */
export function normalizePluginUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a full URL, e.g. http://localhost:5174/");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Plugin URLs must be https (or http on localhost)");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/presio-plugin\.json$/, "");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

/** Add (and enable) a plugin after checking its manifest loads. Returns the
 *  plugin and the base URL it's now listed under. */
export async function addPlugin(input: string): Promise<{ url: string; plugin: LoadedPlugin }> {
  const url = normalizePluginUrl(input);
  const plugin = await loadPlugin(url);
  setPluginEnabled(url, true);
  return { url, plugin };
}

/**
 * Fetch a plugin's manifest and HTML. Always revalidated rather than cached
 * at install: a dev server's plugin should pick up edits on the next load.
 */
export async function loadPlugin(baseUrl: string): Promise<LoadedPlugin> {
  const base = new URL(baseUrl, window.location.href);
  const res = await fetch(new URL("presio-plugin.json", base), { cache: "no-cache" });
  if (!res.ok) throw new Error(`Couldn't load presio-plugin.json (HTTP ${res.status})`);
  const manifest = parseManifest(await res.json().catch(() => {
    throw new Error("presio-plugin.json isn't valid JSON");
  }));
  const htmlRes = await fetch(new URL(manifest.main, base), { cache: "no-cache" });
  if (!htmlRes.ok) throw new Error(`Couldn't load ${manifest.main} (HTTP ${htmlRes.status})`);
  const html = await htmlRes.text();
  const hash = await sha256Hex(new TextEncoder().encode(html).buffer as ArrayBuffer);
  return { manifest, html, hash };
}
