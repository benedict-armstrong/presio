import { useEffect, useRef } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import type { PluginHost } from "@/lib/plugins/host";
import type { LoadedPlugin, PluginSurface } from "@/lib/plugins/manifest";
import { cn } from "@/lib/utils";

/**
 * One plugin surface: a sandboxed iframe running plugin-frame.html, booted
 * with the plugin's HTML and a MessagePort into the host.
 *
 * `sandbox="allow-scripts"` without allow-same-origin gives the frame an
 * opaque origin — no cookies, storage or tokens of the app — and the frame
 * page's own CSP takes away the network. Key it by the plugin's hash so a new
 * version gets a fresh frame rather than a second boot of the old one.
 */
export function PluginFrame({
  host,
  plugin,
  surface,
  onVisibleChange,
  className,
}: {
  host: PluginHost;
  plugin: LoadedPlugin;
  surface: PluginSurface;
  onVisibleChange?: (visible: boolean) => void;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const onVisibleRef = useLatestRef(onVisibleChange);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let disconnect: (() => void) | null = null;
    // Once per mount: writing the plugin's document into the frame fires
    // `load` again, and a second boot would close the port it's using.
    const boot = () => {
      if (disconnect) return;
      const { port1, port2 } = new MessageChannel();
      disconnect = host.connect(plugin, surface, port1, (v) => onVisibleRef.current?.(v));
      frame.contentWindow?.postMessage(
        { type: "presio:boot", html: plugin.html, context: host.frameContext(plugin, surface) },
        // The frame's origin is opaque, so there is no origin to name. It
        // can only be the page this component just pointed it at.
        "*",
        [port2]
      );
    };
    frame.addEventListener("load", boot);
    // A rerun of this effect finds the frame already booted, on the port the
    // cleanup just closed. Load it afresh rather than leave it running deaf.
    if (frame.dataset.booted) frame.src = "/plugin-frame.html";
    frame.dataset.booted = "1";
    return () => {
      frame.removeEventListener("load", boot);
      disconnect?.();
    };
  }, [host, plugin, surface, onVisibleRef]);

  return (
    <iframe
      ref={ref}
      src="/plugin-frame.html"
      sandbox="allow-scripts"
      title={plugin.manifest.name}
      data-testid={`plugin-frame-${plugin.manifest.id}-${surface}`}
      className={cn("border-0 bg-transparent", className)}
    />
  );
}
