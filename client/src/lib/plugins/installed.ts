// The presenter's installed plugins with their manifests loaded, for the
// Settings pages that list and describe them.

import { useEffect, useState } from "react";
import type { PluginManifest } from "./manifest";
import { loadPlugin, usePluginEntries, type PluginEntry } from "./registry";

export interface InstalledPlugin {
  entry: PluginEntry;
  /** Null until loaded, or when it failed to load. */
  manifest: PluginManifest | null;
  error: string;
}

/**
 * Installed plugins with their manifests. `errors` are load failures the
 * running presentation saw, which take precedence over this list's own.
 */
export function useInstalledPlugins(errors: Record<string, string>): InstalledPlugin[] {
  const entries = usePluginEntries();
  const [loaded, setLoaded] = useState<Record<string, PluginManifest | string>>({});

  const urls = entries.map((e) => e.url).join("\n");
  useEffect(() => {
    let cancelled = false;
    for (const url of urls.split("\n").filter(Boolean)) {
      loadPlugin(url).then(
        (p) => !cancelled && setLoaded((m) => ({ ...m, [url]: p.manifest })),
        (e: Error) => !cancelled && setLoaded((m) => ({ ...m, [url]: e.message }))
      );
    }
    return () => { cancelled = true; };
  }, [urls]);

  return entries.map((entry) => {
    const info = loaded[entry.url];
    return {
      entry,
      manifest: typeof info === "object" ? info : null,
      error: errors[entry.url] ?? (typeof info === "string" ? info : ""),
    };
  });
}

/** A readable name before the manifest has loaded (or when it can't). */
export function pluginLabel({ entry, manifest }: InstalledPlugin): string {
  if (manifest) return manifest.name;
  try {
    const url = new URL(entry.url, window.location.href);
    return url.host + url.pathname.replace(/\/$/, "");
  } catch {
    return entry.url;
  }
}
