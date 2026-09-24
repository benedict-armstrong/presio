// Wires a PluginHost into a running presentation: which plugins are active on
// this device, and the transport their messages travel over.
//
// The presenter decides what runs. It activates its enabled plugins against the
// deck and, for a shared deck, publishes the ones with a viewer surface to the
// session so audience devices run exactly those — viewers never install
// anything. A local deck's viewer window is in the same browser, so it reads
// the same registry and syncs over a BroadcastChannel instead.

import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { socket } from "@/lib/socket";
import { readAttachments, type PdfAttachment } from "@/lib/pdf";
import { useJoinUrl } from "@/lib/joinUrl";
import { PluginHost, type PageSize, type PluginContext, type WireEvent } from "./host";
import { isActivatedBy, type LoadedPlugin, type PluginManifest } from "./manifest";
import { loadPlugin, usePluginEntries } from "./registry";
import { clockOffset, onClockSample } from "@/lib/clock";
import { resolvePluginSettings, useSettingsDocument } from "@/lib/settings";

interface PublishedPlugin {
  manifest: Pick<PluginManifest, "id" | "name" | "version" | "author" | "description" | "surfaces" | "permissions">;
  hash: string;
}

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

/** Plugins that run on audience devices, which the presenter publishes. */
function runsOnViewers(manifest: Pick<PluginManifest, "surfaces">): boolean {
  return manifest.surfaces.includes("viewer") || manifest.surfaces.includes("slide");
}

function useTheme(): "light" | "dark" {
  const read = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** The deck's attachments, read once per document. */
function useAttachmentReader(pdf: PDFDocumentProxy | null) {
  return useMemo(() => {
    let cached: Promise<PdfAttachment[]> | null = null;
    return () => {
      if (!pdf) return Promise.resolve([]);
      return (cached ??= readAttachments(pdf).catch(() => []));
    };
  }, [pdf]);
}

/** The deck's PDF bytes, for plugins that read the file themselves. */
function useBytesReader(pdf: PDFDocumentProxy | null) {
  return useMemo(() => async () => (pdf ? pdf.getData() : null), [pdf]);
}

/** Each page's size in PDF points, read once per document. */
function usePagesReader(pdf: PDFDocumentProxy | null) {
  return useMemo(() => {
    let cached: Promise<PageSize[]> | null = null;
    return () => {
      if (!pdf) return Promise.resolve([]);
      return (cached ??= (async () => {
        const sizes: PageSize[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const [x1, y1, x2, y2] = (await pdf.getPage(n)).view;
          sizes.push({ width: x2 - x1, height: y2 - y1 });
        }
        return sizes;
      })());
    };
  }, [pdf]);
}

/** Enabled plugins from this browser's registry that the deck activates. */
function useLocallyActivePlugins(enabled: boolean, readAll: () => Promise<PdfAttachment[]>) {
  const entries = usePluginEntries();
  const urls = entries.filter((e) => e.enabled).map((e) => e.url).join("\n");
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      const names = (await readAll()).map((a) => a.filename);
      const loaded: LoadedPlugin[] = [];
      const failed: Record<string, string> = {};
      for (const url of urls ? urls.split("\n") : []) {
        try {
          const plugin = await loadPlugin(url);
          // First one wins if two sources declare the same id.
          if (isActivatedBy(plugin.manifest, names) && !loaded.some((p) => p.manifest.id === plugin.manifest.id)) {
            loaded.push(plugin);
          }
        } catch (e) {
          failed[url] = e instanceof Error ? e.message : String(e);
        }
      }
      if (cancelled) return;
      // Keep the objects of plugins that didn't change: a new one for the
      // same plugin would remount its frames (this runs again once the deck's
      // attachments are read).
      setPlugins((prev) => {
        const next = loaded.map((p) => prev.find((q) => q.hash === p.hash && q.manifest.id === p.manifest.id) ?? p);
        return next.length === prev.length && next.every((p, i) => p === prev[i]) ? prev : next;
      });
      setErrors(failed);
    })();
    return () => { cancelled = true; };
  }, [enabled, urls, readAll]);

  return { plugins: enabled ? plugins : [], errors };
}

export interface PluginHostState {
  host: PluginHost;
  /** Plugins running on this device. */
  plugins: LoadedPlugin[];
  /** Load failures by plugin URL (presenter only), for Settings. */
  errors: Record<string, string>;
}

export function usePluginHost({
  id,
  local,
  isPresenter,
  pdf,
  currentSlide,
  totalSlides,
}: {
  id: string;
  /** null until the presentation knows whether it's local. */
  local: boolean | null;
  isPresenter: boolean;
  pdf: PDFDocumentProxy | null;
  currentSlide: number;
  totalSlides: number;
}): PluginHostState {
  const theme = useTheme();
  const join = useJoinUrl(id, "viewer");
  const ctx: PluginContext = {
    role: isPresenter ? "presenter" : "audience",
    theme,
    session: { id, local: !!local, joinUrl: local ? null : join.url },
    slide: { current: currentSlide, total: totalSlides },
  };
  const [host] = useState(() => new PluginHost(ctx));
  useEffect(() => {
    host.updateContext(ctx);
  });

  const readAll = useAttachmentReader(pdf);
  const readBytes = useBytesReader(pdf);
  const readPages = usePagesReader(pdf);
  useEffect(() => host.setDeckSource(readAll, readBytes, readPages), [host, readAll, readBytes, readPages]);

  // Server viewers get their plugin list from the session; everyone else
  // (the presenter, and a local deck's viewer window) from this browser.
  const fromSession = local === false && !isPresenter;
  const localActive = useLocallyActivePlugins(local !== null && !fromSession, readAll);
  const [sessionPlugins, setSessionPlugins] = useState<LoadedPlugin[]>([]);
  const plugins = fromSession ? sessionPlugins : localActive.plugins;
  const pluginsRef = useRef(plugins);
  useEffect(() => { pluginsRef.current = plugins; });

  // Static layers belong to running plugins only, and downloads pass through
  // them in this order.
  const runningIds = plugins.map((p) => p.manifest.id).join(",");
  useEffect(() => host.setRunning(runningIds ? runningIds.split(",") : []), [host, runningIds]);

  // Plugins keep their own copy of the server clock (presio.clock).
  useEffect(() => onClockSample(() => host.setClockOffset(clockOffset())), [host]);

  // --- Local deck: BroadcastChannel between this browser's windows ---
  useEffect(() => {
    if (local !== true) return;
    const channel = new BroadcastChannel(`presio-plugins-${id}`);
    host.setOutbound((event) => channel.postMessage({ kind: "event", event }));
    channel.onmessage = (e) => {
      const { kind, event, events } = e.data ?? {};
      if (kind === "event") host.receive(event);
      else if (kind === "retained") host.seedRetained(events);
      else if (kind === "hello" && isPresenter) channel.postMessage({ kind: "retained", events: host.retainedEvents() });
    };
    if (!isPresenter) channel.postMessage({ kind: "hello" });
    return () => {
      channel.close();
      host.setOutbound(() => {});
    };
  }, [host, id, local, isPresenter]);

  // --- Settings ---
  // Plugins loaded from this browser's registry take their settings from this
  // browser's settings document; a shared deck's presenter also sends them on,
  // so viewers run with the presenter's values.
  const settingsDoc = useSettingsDocument();
  const sentSettingsRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (fromSession) return;
    for (const { manifest } of plugins) {
      const values = resolvePluginSettings(manifest.id, manifest.contributes.settings, settingsDoc);
      host.setPluginSettings(manifest.id, values);
      if (local !== false || !isPresenter || !socket.connected) continue;
      const json = JSON.stringify(values);
      if (sentSettingsRef.current.get(manifest.id) === json) continue;
      sentSettingsRef.current.set(manifest.id, json);
      socket.emit("plugin_settings", { plugin: manifest.id, settings: values });
    }
  }, [host, plugins, settingsDoc, fromSession, local, isPresenter]);

  // --- Shared deck: the session's socket ---
  const publishRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (local !== false) return;
    // A volatile message (a laser position) is dropped rather than queued
    // while the socket can't take it: a late one is worse than none.
    host.setOutbound((event) => (event.volatile ? socket.volatile : socket).emit("plugin_event", event));

    const publish = () => {
      const bundles = pluginsRef.current
        .filter((p) => runsOnViewers(p.manifest))
        .map(({ manifest, html }) => ({ manifest, html }));
      socket.emit("plugins_publish", { bundles });
    };

    const onEvent = (event: WireEvent) => host.receive(event);
    const onSettings = (update: SettingsUpdate) => {
      if (!isPresenter) host.setPluginSettings(update.plugin, update.settings);
    };

    const onState = async (state: PluginsState) => {
      if (isPresenter) {
        // The server's copy can lag ours (it restarted, or we changed plugins
        // before joining): republish, and re-seed retained state it lost.
        const server = new Map(state.plugins.map((p) => [p.manifest.id, p.hash]));
        const ours = pluginsRef.current.filter((p) => runsOnViewers(p.manifest));
        const stale = ours.length !== server.size || ours.some((p) => server.get(p.manifest.id) !== p.hash);
        if (stale) publish();
        // Retained state is merged both ways: ours goes up where the server
        // has none, and a reloaded controller adopts what the server kept.
        const key = (e: WireEvent) => `${e.plugin}\u0000${e.type}`;
        const onServer = new Set(state.retained.map(key));
        const ourKeys = new Set(host.retainedEvents().map(key));
        for (const event of host.retainedEvents()) {
          if (!onServer.has(key(event))) socket.emit("plugin_event", event);
        }
        host.seedRetained(state.retained.filter((e) => !ourKeys.has(key(e))));
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
      for (const { manifest, hash } of state.plugins) {
        const have = current.get(manifest.id);
        if (have?.hash === hash) {
          next.push(have);
          continue;
        }
        const bundle = await new Promise<{ html: string; hash: string } | null>((resolve) =>
          socket.emit("plugin_fetch", { id: manifest.id }, resolve)
        );
        if (!bundle) continue;
        next.push({
          // Viewers get the published subset of the manifest; contributions
          // are the presenter's business (their settings arrive as values).
          manifest: {
            ...manifest,
            main: "index.html",
            activation: ["always"],
            contributes: { buttons: [], keybindings: [], settings: {} },
          } as LoadedPlugin["manifest"],
          html: bundle.html,
          hash: bundle.hash,
        });
      }
      const changed =
        next.length !== pluginsRef.current.length || next.some((p, i) => p !== pluginsRef.current[i]);
      if (changed) setSessionPlugins(next);
    };

    socket.on("plugin_event", onEvent);
    socket.on("plugin_settings", onSettings);
    socket.on("plugins_state", onState);
    publishRef.current = publish;
    return () => {
      socket.off("plugin_event", onEvent);
      socket.off("plugin_settings", onSettings);
      socket.off("plugins_state", onState);
      host.setOutbound(() => {});
      publishRef.current = null;
    };
  }, [host, local, isPresenter]);

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
    if (local !== false || !isPresenter || !socket.connected) return;
    if (!publishKey && !publishedOnceRef.current) return;
    publishedOnceRef.current = true;
    publishRef.current?.();
  }, [publishKey, local, isPresenter]);

  return { host, plugins, errors: localActive.errors };
}
