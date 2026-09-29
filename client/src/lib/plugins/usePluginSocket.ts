// A shared deck's plugins over the session's socket: publishing what runs on
// viewers, relaying plugin messages and settings, the history link, and
// viewers' reports of plugins they couldn't load.

import { useCallback, useEffect, useRef, useState } from "react";
import { socket } from "@/lib/socket";
import { resolvePluginSettings } from "@/lib/settings";
import { retainKey, type PublishedPlugin } from "@shared/pluginProtocol";
import type { PluginHost } from "./host";
import type { HistoryEntry } from "./history";
import type { LoadedPlugin, PluginManifest } from "./manifest";
import type { WireEvent } from "./protocol";
import { loadPlugin } from "./registry";
import { sharedHistoryLink } from "./sharedHistoryLink";

interface PluginsState {
  plugins: PublishedPlugin[];
  /** The presenter's settings for each plugin, by id. */
  settings: Record<string, Record<string, unknown>>;
  retained: WireEvent[];
}

interface SettingsUpdate {
  plugin: string;
  settings: Record<string, unknown>;
}

/** A viewer couldn't load a published plugin (relayed to the presenter). */
export interface LoadFailure {
  plugin: string;
  hash: string;
  reason: string;
  sender: string;
}

/** Why a viewer couldn't load a plugin, in a line the presenter can act on. */
function loadFailureReason(e: unknown, url: string): string {
  if (e instanceof TypeError) {
    // fetch() rejects with a TypeError when it can't reach the host at all.
    let host = url;
    try {
      host = new URL(url, window.location.href).host;
    } catch {
      /* keep the URL */
    }
    return `couldn't reach ${host}`;
  }
  const message = e instanceof Error ? e.message : String(e);
  return /changed since/.test(message) ? "it got a different version — pin the plugin's URL to a version" : message;
}

/** Plugins that run on audience devices, which the presenter publishes. */
function runsOnViewers(manifest: Pick<PluginManifest, "surfaces">): boolean {
  return manifest.surfaces.includes("viewer") || manifest.surfaces.includes("slide");
}

export function usePluginSocket({
  host,
  id,
  active,
  isPresenter,
  plugins,
  pluginsRef,
  onSessionPlugins,
  sentSettingsRef,
  onLoadFailed,
}: {
  host: PluginHost;
  id: string;
  /** A shared deck (not local, and known to be so). */
  active: boolean;
  isPresenter: boolean;
  /** Plugins running on this device, and the same for callbacks. */
  plugins: LoadedPlugin[];
  pluginsRef: React.RefObject<LoadedPlugin[]>;
  /** Viewer: the plugins the presenter published, loaded. */
  onSessionPlugins: (plugins: LoadedPlugin[]) => void;
  /** Presenter: the settings last sent per plugin (JSON), to skip resends. */
  sentSettingsRef: React.RefObject<Map<string, string>>;
  /** Presenter: a viewer couldn't load a plugin. */
  onLoadFailed: (failure: LoadFailure) => void;
}) {
  const reportedRef = useRef(new Set<string>());
  const publishRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!active) return;
    // A volatile message (a laser position) is dropped rather than queued
    // while the socket can't take it: a late one is worse than none.
    host.setOutbound((event) => (event.volatile ? socket.volatile : socket).emit("plugin_event", event));

    // Histories: the server orders edits (server/history.ts); blobs go over
    // HTTP. The link is ready once the socket has joined (plugins_state).
    const historyLink = sharedHistoryLink(id, isPresenter, (sha) => host.history.getBlob(sha));
    const onHistoryEntry = ({ plugin, entry }: { plugin: string; entry: HistoryEntry }) => host.history.receive(plugin, entry);
    const onHistoryReset = ({ plugin }: { plugin: string }) => host.history.receiveReset(plugin);
    const onDisconnect = () => host.history.setLink(historyLink, false);

    // Only where to find each plugin: viewers load it themselves (cached like
    // any web page), never through the server.
    const publish = () => {
      const plugins = pluginsRef.current
        .filter((p) => runsOnViewers(p.manifest))
        .map(({ manifest, url, hash }): PublishedPlugin => ({
          manifest: {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            author: manifest.author,
            description: manifest.description,
            surfaces: manifest.surfaces,
            permissions: manifest.permissions,
          },
          url,
          hash,
        }));
      socket.emit("plugins_publish", { plugins });
    };

    const onEvent = (event: WireEvent) => host.receive(event);
    const onSettings = (update: SettingsUpdate) => {
      if (!isPresenter) host.setPluginSettings(update.plugin, update.settings);
    };

    const onState = async (state: PluginsState) => {
      historyLink.retryUploads();
      host.history.setLink(historyLink, true);
      if (isPresenter) {
        // The server's copy can lag ours (it restarted, or we changed plugins
        // before joining): republish, and re-seed retained state it lost.
        const server = new Map(state.plugins.map((p) => [p.manifest.id, p.hash]));
        const ours = pluginsRef.current.filter((p) => runsOnViewers(p.manifest));
        const stale = ours.length !== server.size || ours.some((p) => server.get(p.manifest.id) !== p.hash);
        if (stale) publish();
        // Retained state is merged both ways: ours goes up where the server
        // has none, and a reloaded controller adopts what the server kept.
        const onServer = new Set(state.retained.map(retainKey));
        const ourKeys = new Set(host.retainedEvents().map(retainKey));
        for (const event of host.retainedEvents()) {
          if (!onServer.has(retainKey(event))) socket.emit("plugin_event", event);
        }
        host.seedRetained(state.retained.filter((e) => !ourKeys.has(retainKey(e))));
        // And our settings, which the server may not have (or had from an
        // earlier controller).
        sentSettingsRef.current.clear();
        for (const { manifest } of pluginsRef.current) {
          const values = resolvePluginSettings(manifest.id, manifest.contributes.settings);
          sentSettingsRef.current.set(manifest.id, JSON.stringify(values));
          socket.emit("plugin_settings", { plugin: manifest.id, settings: values });
        }
        return;
      }
      for (const [plugin, values] of Object.entries(state.settings ?? {})) host.setPluginSettings(plugin, values);
      host.seedRetained(state.retained);
      // Fetch only what changed; the watchdog re-joins every 30s.
      const current = new Map(pluginsRef.current.map((p) => [p.manifest.id, p]));
      const next: LoadedPlugin[] = [];
      for (const { manifest, url, hash } of state.plugins) {
        const have = current.get(manifest.id);
        if (have?.hash === hash) {
          next.push(have);
          continue;
        }
        try {
          const loaded = await loadPlugin(url, hash);
          next.push({
            ...loaded,
            // Run as published: contributions are the presenter's business
            // (their settings arrive as values), and the deck already
            // activated it there.
            manifest: {
              ...loaded.manifest,
              activation: ["always"],
              contributes: { buttons: [], keybindings: [], settings: {} },
            },
          });
        } catch (e) {
          // Unreachable from here (a presenter's localhost dev server), or
          // changed since: this viewer goes without it, and says so to the
          // presenter (once per version: the watchdog re-joins every 30s).
          console.warn(`Plugin ${manifest.id} not loaded:`, e);
          const key = `${manifest.id}:${hash}`;
          if (!reportedRef.current.has(key)) {
            reportedRef.current.add(key);
            socket.emit("plugin_load_failed", { plugin: manifest.id, hash, reason: loadFailureReason(e, url) });
          }
        }
      }
      const changed =
        next.length !== pluginsRef.current.length || next.some((p, i) => p !== pluginsRef.current[i]);
      if (changed) onSessionPlugins(next);
    };

    const onLoadFailedEvent = (failure: LoadFailure) => {
      if (isPresenter) onLoadFailed(failure);
    };

    socket.on("plugin_event", onEvent);
    socket.on("plugin_settings", onSettings);
    socket.on("plugins_state", onState);
    socket.on("plugin_load_failed", onLoadFailedEvent);
    socket.on("history_entry", onHistoryEntry);
    socket.on("history_reset", onHistoryReset);
    socket.on("disconnect", onDisconnect);
    publishRef.current = publish;
    return () => {
      socket.off("plugin_event", onEvent);
      socket.off("plugin_settings", onSettings);
      socket.off("plugins_state", onState);
      socket.off("plugin_load_failed", onLoadFailedEvent);
      socket.off("history_entry", onHistoryEntry);
      socket.off("history_reset", onHistoryReset);
      socket.off("disconnect", onDisconnect);
      host.setOutbound(() => {});
      host.history.setLink({}, false);
      publishRef.current = null;
    };
  }, [host, id, active, isPresenter, pluginsRef, sentSettingsRef, onSessionPlugins, onLoadFailed]);

  // Republish when the presenter's own set changes mid-session (a plugin
  // switched on in Settings). Until something has been published, an empty
  // set is just "still loading" — publishing it would wipe what the server
  // kept across a controller reload; the join's plugins_state reply covers
  // the first publish.
  const publishKey = plugins
    .filter((p) => runsOnViewers(p.manifest))
    .map((p) => `${p.manifest.id}:${p.hash}`)
    .join(",");
  const publishedOnceRef = useRef(false);
  useEffect(() => {
    if (!active || !isPresenter || !socket.connected) return;
    if (!publishKey && !publishedOnceRef.current) return;
    publishedOnceRef.current = true;
    publishRef.current?.();
  }, [publishKey, active, isPresenter]);
}

/**
 * Viewers that couldn't load a plugin. Viewers report once per plugin
 * version; the presenter keeps who failed and why, per plugin id, for the
 * version it published.
 */
export function useViewerLoadFailures(plugins: LoadedPlugin[]) {
  const [failures, setFailures] = useState<Record<string, { hash: string; senders: Record<string, string> }>>({});
  const record = useCallback((failure: LoadFailure) => {
    setFailures((prev) => {
      const current = prev[failure.plugin]?.hash === failure.hash ? prev[failure.plugin].senders : {};
      return { ...prev, [failure.plugin]: { hash: failure.hash, senders: { ...current, [failure.sender]: failure.reason } } };
    });
  }, []);

  // Only failures for the version running now: a fix republishes a new hash.
  const viewerErrors: Record<string, string> = {};
  for (const plugin of plugins) {
    const failure = failures[plugin.manifest.id];
    if (!failure || failure.hash !== plugin.hash) continue;
    const reasons = Object.values(failure.senders);
    if (!reasons.length) continue;
    const n = reasons.length;
    viewerErrors[plugin.url] = `${n} viewer${n === 1 ? "" : "s"} couldn't load it: ${reasons[0]}`;
  }
  return { record, viewerErrors };
}
