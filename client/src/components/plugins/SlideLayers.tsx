import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useContainedCanvasRect } from "@/hooks/useContainedCanvasRect";
import { FULL_VIEW, type Interactive, type PluginHost, type SlideView } from "@/lib/plugins/host";
import type { LoadedPlugin } from "@/lib/plugins/manifest";
import type { PluginHostState } from "@/lib/plugins/usePluginHost";
import { PluginFrame } from "./PluginFrame";

// Plugins' layers over a slide — the part every view of a slide shares.
//
//  - "static" views (Next Slide, Thumbnails) draw each plugin's still images
//    (presio.layers): a video's poster, the drawings on a slide.
//  - "live" views (the presenter's current slide, every viewer) mount the
//    plugins' "slide" surfaces instead: frames sized to the page that play,
//    draw and sync. Plugins without one still show their static images.
//
// Positioned over the page: over the letterboxed canvas in `containerRef`,
// or filling the parent when it already has the page's shape (a thumbnail).
// Live layers sit above the slide's link regions: a surface that takes input
// (a drawing tool) must get it first, and one that doesn't lets it through.

/** A pinch-zoom applied to the container (see useSlidePinchZoom). */
export interface LayerZoom {
  scale: number;
  x: number;
  y: number;
}

export function SlideLayers({
  plugins,
  slide,
  mode,
  containerRef,
  zoom,
}: {
  plugins: PluginHostState;
  slide: number;
  mode: "static" | "live";
  containerRef?: React.RefObject<HTMLElement | null>;
  /** The zoom the container is shown at, for "slide" surfaces' view. */
  zoom?: LayerZoom;
}) {
  const { host } = plugins;
  const layers = useSyncExternalStore(host.subscribeLayers, () => host.slideLayers(slide));
  const live = mode === "live" ? plugins.plugins.filter((p) => p.manifest.surfaces.includes("slide")) : [];
  const liveIds = new Set(live.map((p) => p.manifest.id));
  const stills = layers.filter((l) => !liveIds.has(l.pluginId));
  if (!stills.length && !live.length) return null;

  const content = (view: SlideView) => (
    <>
      {stills.flatMap((layer) =>
        layer.items.map((item, i) => (
          <img
            key={`${layer.pluginId}:${i}`}
            src={item.image}
            alt=""
            draggable={false}
            className="absolute pointer-events-none select-none"
            style={{
              left: `${item.x * 100}%`,
              top: `${item.y * 100}%`,
              width: `${item.w * 100}%`,
              height: `${item.h * 100}%`,
              objectFit: item.fit,
            }}
          />
        ))
      )}
      {live.map((plugin) => (
        <SlideSurface key={plugin.hash} host={host} plugin={plugin} view={view} />
      ))}
    </>
  );

  return containerRef ? (
    <PageBox containerRef={containerRef} slide={slide} zoom={zoom}>{content}</PageBox>
  ) : (
    <div className="absolute inset-0 pointer-events-none">{content(FULL_VIEW)}</div>
  );
}

/** A box exactly over the page drawn letterboxed in `containerRef`. */
function PageBox({
  containerRef,
  slide,
  zoom,
  children,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  slide: number;
  zoom?: LayerZoom;
  children: (view: SlideView) => React.ReactNode;
}) {
  const rect = useContainedCanvasRect(containerRef, slide);
  const view = useMemo(() => {
    if (!zoom || zoom.scale <= 1 || rect.width === 0) return FULL_VIEW;
    // What of the container is on screen, in its own (unzoomed) pixels, as
    // fractions of the page within it. The page is centered in it, so the
    // container is the page plus its margins twice over.
    const left = -zoom.x / zoom.scale;
    const top = -zoom.y / zoom.scale;
    const right = left + (rect.width + 2 * rect.left) / zoom.scale;
    const bottom = top + (rect.height + 2 * rect.top) / zoom.scale;
    const x0 = Math.max(0, (left - rect.left) / rect.width);
    const y0 = Math.max(0, (top - rect.top) / rect.height);
    const x1 = Math.min(1, (right - rect.left) / rect.width);
    const y1 = Math.min(1, (bottom - rect.top) / rect.height);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0), scale: zoom.scale };
  }, [zoom, rect]);
  if (rect.width === 0) return null;
  return (
    <div
      className="absolute z-[5] pointer-events-none"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {children(view)}
    </div>
  );
}

type Region = { x: number; y: number; w: number; h: number };

const inside = (regions: Region[], fx: number, fy: number) =>
  regions.some((r) => fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h);

/** Whether nothing covers the frame at this point (a dialog, a menu): only
 *  then is a tap there meant for it. */
function onTop(frame: HTMLIFrameElement, x: number, y: number): boolean {
  const before = frame.style.pointerEvents;
  frame.style.pointerEvents = "auto";
  const hit = document.elementFromPoint(x, y);
  frame.style.pointerEvents = before;
  return hit === frame;
}

/**
 * One plugin's live "slide" surface. It lets pointer input through to the
 * slide (links, pinch) unless the plugin claims it: all of it, or only some
 * areas (presio.ui.setInteractive). For areas, a mouse makes the frame take
 * input while it hovers one; a tap, which has no hover, is forwarded into the
 * frame as a click at the same spot. Two fingers are always Presio's: touches
 * that land in a frame taking input are handed on to the slide's pinch-zoom
 * once a second one comes down.
 */
function SlideSurface({ host, plugin, view }: { host: PluginHost; plugin: LoadedPlugin; view: SlideView }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [interactive, setInteractive] = useState<Interactive>(false);
  const [hot, setHot] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [readyCount, setReadyCount] = useState(0);
  const regions = useMemo(() => (Array.isArray(interactive) ? interactive : null), [interactive]);
  const presenter = host.context.role === "presenter";

  // Whether a mouse is over the page (presio.ui.onHover): over the frame when
  // it takes input, over what's under it when it doesn't. The presenter's
  // only — it's for their own controls.
  useEffect(() => {
    const frame = frameRef.current;
    if (!presenter || !frame) return;
    let leaving: ReturnType<typeof setTimeout> | null = null;
    const settle = (over: boolean) => {
      if (leaving) clearTimeout(leaving);
      leaving = null;
      setHovered(over);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const box = frame.getBoundingClientRect();
      settle(e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom);
    };
    const onOut = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && !e.relatedTarget) settle(false);
    };
    // Leaving the frame looks the same whether the mouse went to the page
    // around it or out of the window; the page's own pointermove says which.
    const onInnerMove = (e: PointerEvent) => {
      if (e.pointerType === "mouse") settle(true);
    };
    const onInnerLeave = () => {
      if (leaving) clearTimeout(leaving);
      leaving = setTimeout(() => setHovered(false), 80);
    };
    const inner = frame.contentWindow;
    window.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerout", onOut);
    inner?.addEventListener("pointermove", onInnerMove);
    inner?.document.documentElement.addEventListener("pointerleave", onInnerLeave);
    return () => {
      if (leaving) clearTimeout(leaving);
      window.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerout", onOut);
      inner?.removeEventListener("pointermove", onInnerMove);
      inner?.document.documentElement.removeEventListener("pointerleave", onInnerLeave);
    };
  }, [presenter, readyCount]);

  // Touches the frame took, passed on to the page once two are down: the
  // pinch-zoom (useSlidePinchZoom) listens above the frame, where input that
  // lands inside it never arrives. One finger stays the plugin's.
  useEffect(() => {
    const frame = frameRef.current;
    const inner = frame?.contentWindow;
    if (!presenter || !frame || !inner) return;
    const down = new Map<number, PointerEvent>();
    let forwarding = false;
    const forward = (type: string, e: PointerEvent) => {
      const box = frame.getBoundingClientRect();
      const scale = frame.clientWidth ? box.width / frame.clientWidth : 1;
      frame.parentElement?.dispatchEvent(
        new PointerEvent(type, {
          pointerId: e.pointerId,
          pointerType: "touch",
          isPrimary: e.isPrimary,
          clientX: box.left + e.clientX * scale,
          clientY: box.top + e.clientY * scale,
          bubbles: true,
          cancelable: true,
        })
      );
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      down.set(e.pointerId, e);
      if (forwarding) forward("pointerdown", e);
      else if (down.size >= 2) {
        forwarding = true;
        for (const d of down.values()) forward("pointerdown", d);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!down.has(e.pointerId)) return;
      down.set(e.pointerId, e);
      if (forwarding) forward("pointermove", e);
    };
    const onEnd = (e: PointerEvent) => {
      if (!down.delete(e.pointerId)) return;
      if (forwarding) forward(e.type, e);
      if (!down.size) forwarding = false;
    };
    inner.addEventListener("pointerdown", onDown, true);
    inner.addEventListener("pointermove", onMove, true);
    inner.addEventListener("pointerup", onEnd, true);
    inner.addEventListener("pointercancel", onEnd, true);
    return () => {
      inner.removeEventListener("pointerdown", onDown, true);
      inner.removeEventListener("pointermove", onMove, true);
      inner.removeEventListener("pointerup", onEnd, true);
      inner.removeEventListener("pointercancel", onEnd, true);
    };
  }, [presenter, readyCount]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!regions || !frame) return;
    const fraction = (clientX: number, clientY: number) => {
      const box = frame.getBoundingClientRect();
      return [(clientX - box.left) / box.width, (clientY - box.top) / box.height] as const;
    };
    // Outside the frame's own input: where the pointer is over the page.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      setHot(inside(regions, ...fraction(e.clientX, e.clientY)));
    };
    // A tap on one of the areas is the plugin's (forwarded as a click below),
    // so the slide under it mustn't take it too — as a tap to turn the page.
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      if (inside(regions, ...fraction(e.clientX, e.clientY)) && onTop(frame, e.clientX, e.clientY)) e.stopPropagation();
    };
    const onClick = (e: MouseEvent) => {
      const [fx, fy] = fraction(e.clientX, e.clientY);
      if (!inside(regions, fx, fy) || !onTop(frame, e.clientX, e.clientY)) return;
      const target = frame.contentDocument?.elementFromPoint(fx * frame.clientWidth, fy * frame.clientHeight);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      // Dispatched rather than .click(): the point may be on an icon's SVG,
      // which has no click() of its own; the event bubbles to its button.
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: frame.contentWindow }));
    };
    // Inside it, while it's taking input (same origin, so its window is ours
    // to listen to): leaving the areas hands input back to the slide.
    const inner = frame.contentWindow;
    const onInnerMove = (e: PointerEvent) => {
      setHot(inside(regions, e.clientX / frame.clientWidth, e.clientY / frame.clientHeight));
    };
    const onInnerLeave = () => setHot(false);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onClick, true);
    inner?.addEventListener("pointermove", onInnerMove);
    inner?.document.documentElement.addEventListener("pointerleave", onInnerLeave);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onClick, true);
      inner?.removeEventListener("pointermove", onInnerMove);
      inner?.document.documentElement.removeEventListener("pointerleave", onInnerLeave);
    };
    // readyCount: the plugin's document replaces the frame's, so re-listen.
  }, [regions, readyCount]);

  const takesInput = interactive === true || (!!regions && hot);
  return (
    <PluginFrame
      host={host}
      plugin={plugin}
      surface="slide"
      frameRef={frameRef}
      onInteractiveChange={(v) => {
        setInteractive(v);
        setHot(false);
      }}
      onReady={() => setReadyCount((n) => n + 1)}
      view={view}
      hovered={presenter ? hovered : undefined}
      className="absolute inset-0 w-full h-full"
      style={{ pointerEvents: takesInput ? "auto" : "none" }}
    />
  );
}
