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
import { PluginHost } from "./host";
import type { PageSize, PluginContext } from "./protocol";
import { isActivatedBy, type LoadedPlugin } from "./manifest";
import { loadPlugin, usePluginEntries } from "./registry";
import { clockOffset, onClockSample } from "@/lib/clock";
import { resolvePluginSettings, useSettingsDocument } from "@/lib/settings";
import { connectLocalChannel } from "./localChannel";
import { usePluginSocket, useViewerLoadFailures } from "./usePluginSocket";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";

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
  /** Presenter of a shared deck: plugins some viewers couldn't load, by URL. */
  viewerErrors: Record<string, string>;
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
  const theme = useResolvedTheme();
  const join = useJoinUrl(id, "viewer");
  const ctx: PluginContext = {
    role: isPresenter ? "presenter" : "audience",
    theme,
    session: { id, local: !!local, joinUrl: local ? null : join.url },
    slide: { current: currentSlide, total: totalSlides },
  };
  const [host] = useState(() => new PluginHost(ctx));
  useEffect(() => {
    host.attach();
    return () => host.dispose();
  }, [host]);
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
    return connectLocalChannel(host, id, isPresenter);
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
  const loadFailures = useViewerLoadFailures(plugins);
  usePluginSocket({
    host,
    id,
    active: local === false,
    isPresenter,
    plugins,
    pluginsRef,
    onSessionPlugins: setSessionPlugins,
    sentSettingsRef,
    onLoadFailed: loadFailures.record,
  });

  return { host, plugins, errors: localActive.errors, viewerErrors: loadFailures.viewerErrors };
}
