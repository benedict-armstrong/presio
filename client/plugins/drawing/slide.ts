// The drawing on the slide itself: on the presenter's current slide, where
// they draw (and carry the palette), and on every viewer, where it's followed.
//
// Three layers: committed strokes on a canvas of their own, only redrawn when
// they change (and then only the new ones, when strokes were just added); the
// stroke being drawn, painted a segment at a time (LiveStroke); the laser, a
// dot moved by transform. Input is read in full — every coalesced pointer
// sample, plus the predicted ones for the tip — painted once a frame, and the
// new points go out once a frame too, so nothing waits on a throttle and the
// tail of a stroke is never dropped.

import { Drawing, encodePoints, decodePoints, MAX_STROKE_POINTS, newId, opacityOf, parseBegin, parseFile, publish, serializeFile, type Stroke, type Tool } from "./model";
import { drawStrokes, LiveStroke } from "./render";
import { Palette, type PenStyle } from "./palette";

// How long a viewer keeps showing a laser dot that stopped moving (covers a
// lost "hide").
const LASER_HIDE_MS = 3000;
// Points closer than this (CSS pixels of the page) to the last one add nothing.
const MIN_POINT_PX = 0.75;
// The furthest the stroke's tip reaches ahead of the pen, to where it's
// predicted to be next (CSS pixels).
const PREDICT_MAX_PX = 8;
// The canvases' resolution follows the zoom, up to this many pixels across.
const MAX_CANVAS_PX = 4096;

interface Draft {
  stroke: Stroke;
  slide: number;
  live: LiveStroke;
  /** Points already sent (presenter). */
  sent: number;
}

export function runSlide() {
  const presenter = presio.role === "presenter";
  const root = document.getElementById("root")!;
  const drawing = new Drawing();
  let slide = presio.slide.current;

  // --- Layers ---

  const canvas = (fast: boolean) => {
    const c = document.createElement("canvas");
    // A low-latency canvas for what's drawn under the pen: it can reach the
    // screen without waiting on the rest of the page.
    const ctx = c.getContext("2d", fast && presenter ? { desynchronized: true } : undefined)!;
    return { c, ctx };
  };
  const committed = canvas(false);
  const liveLayer = document.createElement("div");
  liveLayer.className = "live";
  const stable = canvas(true);
  const tip = canvas(true);
  liveLayer.append(stable.c, tip.c);
  const laserDot = document.createElement("div");
  laserDot.className = "laser";
  laserDot.dataset.testid = "laser-dot";
  laserDot.dataset.laser = presenter ? "local" : "remote";
  laserDot.hidden = true;
  root.append(committed.c, liveLayer, laserDot);

  let W = 0;
  let H = 0;
  let resolution = 1;
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.max(1, presio.ui.view?.scale ?? 1);
    resolution = Math.min(dpr * scale, MAX_CANVAS_PX / Math.max(1, innerWidth));
    const w = Math.max(1, Math.round(innerWidth * resolution));
    const h = Math.max(1, Math.round(innerHeight * resolution));
    if (w === W && h === H) return;
    W = w;
    H = h;
    for (const { c } of [committed, stable, tip]) {
      c.width = W;
      c.height = H;
    }
    drawn = null;
    redrawCommitted();
    if (draft) {
      draft.live.reset();
      schedule();
    }
  };

  // --- Committed strokes ---

  // What's on the committed canvas now, so adding strokes draws only those;
  // null when it has to be drawn afresh.
  let drawn: Stroke[] | null = null;
  const redrawCommitted = () => {
    const strokes = drawing.strokes(slide);
    const prev = drawn;
    const extends_ = !!prev && prev.length <= strokes.length && prev.every((s, i) => strokes[i] === s);
    if (!extends_) committed.ctx.clearRect(0, 0, W, H);
    drawStrokes(committed.ctx, extends_ ? strokes.slice(prev!.length) : strokes, W, H);
    drawn = strokes;
    // A stroke being drawn that has now arrived committed is done.
    if (draft && strokes.some((s) => s.id === draft!.stroke.id)) endDraft();
    palette?.render();
  };

  // --- The stroke being drawn ---

  let draft: Draft | null = null;
  const beginDraft = (stroke: Stroke, onSlide: number) => {
    if (draft) endDraft();
    draft = { stroke, slide: onSlide, live: new LiveStroke(stroke, stable.ctx, tip.ctx), sent: 0 };
    liveLayer.style.opacity = String(opacityOf(stroke));
    schedule();
  };
  const endDraft = () => {
    draft = null;
    predicted = [];
    stable.ctx.clearRect(0, 0, W, H);
    tip.ctx.clearRect(0, 0, W, H);
  };

  // --- One frame's work ---

  let queued = false;
  let predicted: number[] = [];
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(frame);
  };
  const frame = () => {
    queued = false;
    if (draft && draft.slide === slide) draft.live.paint(W, H, predicted);
    if (presenter) {
      sendPoints();
      sendLaser();
    } else if (moveRemoteLaser()) schedule();
  };

  // --- Presenter: drawing ---

  let tool: Tool = "none";
  const styleOf = (t: "pen" | "highlighter"): PenStyle => ({
    color: String(presio.settings.get(`${t}Color`) ?? (t === "pen" ? "#e11d48" : "#facc15")),
    size: Number(presio.settings.get(`${t}Size`) ?? (t === "pen" ? 3 : 14)),
  });
  // Touches down on the frame: a second one is a pinch (Presio's), which
  // abandons whatever the first began.
  const touches = new Set<number>();
  let pinching = false;

  const toPage = (e: PointerEvent) => [
    Math.min(1, Math.max(0, e.clientX / innerWidth)),
    Math.min(1, Math.max(0, e.clientY / innerHeight)),
  ];

  const addPoint = (e: PointerEvent) => {
    if (!draft) return;
    const p = draft.stroke.points;
    const [x, y] = toPage(e);
    const n = p.length;
    if (n && Math.hypot((x - p[n - 2]) * innerWidth, (y - p[n - 1]) * innerHeight) < MIN_POINT_PX) return;
    p.push(x, y);
    // Past what one message holds: finish this one and carry on in a new one
    // from the same spot, so the line is unbroken.
    if (p.length >= MAX_STROKE_POINTS * 2) {
      const { tool: t, color, width } = draft.stroke;
      finishStroke();
      startStroke({ id: newId(), tool: t, color, width, points: [x, y] });
    }
  };

  // Where the pen is about to be (getPredictedEvents), for the tip to reach
  // ahead to. A prediction is a guess, and a bad one on a quick turn shows as
  // a spike for a frame: it's used only when it carries on the way the pen is
  // already going, and never further than the pen's last step.
  const predict = (e: PointerEvent): number[] => {
    const p = draft?.stroke.points;
    const ahead = e.getPredictedEvents?.() ?? [];
    if (!p || p.length < 4 || !ahead.length) return [];
    const n = p.length;
    const [x, y] = toPage(ahead[ahead.length - 1]);
    const lx = (p[n - 2] - p[n - 4]) * innerWidth;
    const ly = (p[n - 1] - p[n - 3]) * innerHeight;
    const dx = (x - p[n - 2]) * innerWidth;
    const dy = (y - p[n - 1]) * innerHeight;
    const last = Math.hypot(lx, ly);
    const reach = Math.hypot(dx, dy);
    if (!last || !reach || (lx * dx + ly * dy) / (last * reach) < 0.9) return [];
    const k = Math.min(1, last / reach, PREDICT_MAX_PX / reach);
    return [p[n - 2] + (dx * k) / innerWidth, p[n - 1] + (dy * k) / innerHeight];
  };

  const startStroke = (stroke: Stroke) => {
    beginDraft(stroke, slide);
    draft!.sent = stroke.points.length;
    presio.send("b", {
      i: stroke.id,
      s: slide,
      t: stroke.tool === "highlighter" ? "h" : "p",
      c: stroke.color,
      w: stroke.width,
      d: encodePoints(stroke.points),
    });
  };

  const sendPoints = () => {
    if (!draft || draft.sent >= draft.stroke.points.length) return;
    presio.send("p", { i: draft.stroke.id, d: encodePoints(draft.stroke.points, draft.sent) });
    draft.sent = draft.stroke.points.length;
  };

  const finishStroke = () => {
    if (!draft) return;
    sendPoints();
    const { stroke, slide: on } = draft;
    endDraft();
    publish(drawing.commit(on, stroke));
    if (on === slide) redrawCommitted();
  };

  const abandonStroke = () => {
    if (!draft) return;
    presio.send("x", { i: draft.stroke.id });
    endDraft();
  };

  // --- Laser ---

  let laser: { x: number; y: number } | null = null;
  let laserSent: { x: number; y: number } | null = null;
  const showLaser = (x: number, y: number) => {
    laserDot.hidden = false;
    laserDot.style.transform = `translate(${x * innerWidth}px, ${y * innerHeight}px)`;
  };
  const sendLaser = () => {
    if (!laser || (laserSent && laserSent.x === laser.x && laserSent.y === laser.y)) return;
    laserSent = laser;
    presio.send("l", { x: Math.round(laser.x * 1e4) / 1e4, y: Math.round(laser.y * 1e4) / 1e4 }, { volatile: true });
  };
  const hideLaser = () => {
    laserDot.hidden = true;
    if (presenter && (laser || laserSent)) presio.send("l", null);
    laser = null;
    laserSent = null;
  };

  // A viewer's dot glides from where it is to each new position over about
  // the time between updates, so a 60 Hz stream reads as motion, not steps.
  let remoteLaser: { fx: number; fy: number; tx: number; ty: number; t0: number; dur: number; at: number } | null = null;
  let laserHideTimer: ReturnType<typeof setTimeout> | null = null;
  const moveRemoteLaser = () => {
    if (!remoteLaser) return false;
    const k = Math.min(1, (performance.now() - remoteLaser.t0) / remoteLaser.dur);
    showLaser(remoteLaser.fx + (remoteLaser.tx - remoteLaser.fx) * k, remoteLaser.fy + (remoteLaser.ty - remoteLaser.fy) * k);
    return k < 1;
  };
  const onRemoteLaser = (payload: unknown) => {
    if (laserHideTimer) clearTimeout(laserHideTimer);
    const p = payload as { x?: unknown; y?: unknown } | null;
    if (!p || typeof p.x !== "number" || typeof p.y !== "number") {
      remoteLaser = null;
      laserDot.hidden = true;
      return;
    }
    const now = performance.now();
    const prev = remoteLaser;
    const k = prev ? Math.min(1, (now - prev.t0) / prev.dur) : 1;
    const fx = prev && !laserDot.hidden ? prev.fx + (prev.tx - prev.fx) * k : p.x;
    const fy = prev && !laserDot.hidden ? prev.fy + (prev.ty - prev.fy) * k : p.y;
    const dur = prev ? Math.min(60, Math.max(8, now - prev.at)) : 16;
    remoteLaser = { fx, fy, tx: p.x, ty: p.y, t0: now, dur, at: now };
    laserHideTimer = setTimeout(() => {
      remoteLaser = null;
      laserDot.hidden = true;
    }, LASER_HIDE_MS);
    schedule();
  };

  // --- Presenter input ---

  const drawingTool = () => tool === "pen" || tool === "highlighter";
  if (presenter) {
    const onPalette = (e: Event) => !!palette && palette.el.contains(e.target as Node);

    window.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") {
        touches.add(e.pointerId);
        if (touches.size >= 2) {
          pinching = true;
          abandonStroke();
          hideLaser();
          return;
        }
      }
      if (!e.isPrimary || pinching || onPalette(e)) return;
      if (drawingTool() && e.button === 0) {
        document.body.setPointerCapture?.(e.pointerId);
        const t = tool as "pen" | "highlighter";
        const style = styleOf(t);
        startStroke({ id: newId(), tool: t, color: style.color, width: style.size, points: toPage(e) });
      } else if (tool === "laser") {
        const [x, y] = toPage(e);
        laser = { x, y };
        showLaser(x, y);
        schedule();
      }
    });

    window.addEventListener("pointermove", (e) => {
      if (!e.isPrimary || pinching) return;
      if (draft) {
        for (const c of e.getCoalescedEvents?.() ?? [e]) addPoint(c);
        predicted = predict(e);
        schedule();
      } else if (tool === "laser" && !onPalette(e) && (e.pointerType === "mouse" || e.buttons)) {
        const [x, y] = toPage(e);
        laser = { x, y };
        showLaser(x, y);
        schedule();
      } else if (tool === "laser" && laser) hideLaser();
    });

    const end = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        touches.delete(e.pointerId);
        if (!touches.size) pinching = false;
      }
      if (!e.isPrimary) return;
      if (draft) {
        if (e.type === "pointerup") addPoint(e);
        finishStroke();
      }
      if (tool === "laser" && e.pointerType !== "mouse") hideLaser();
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    document.documentElement.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse" && tool === "laser") hideLaser();
    });
  }

  // --- Presenter: palette and tools ---

  const touchFirst = matchMedia("(pointer: coarse)").matches;
  let palette: Palette | null = null;

  const setTool = (next: Tool) => {
    presio.storage.set("tool", next);
    applyTool(next);
  };

  const applyTool = (next: Tool) => {
    if (next === tool) return;
    if (draft) finishStroke();
    if (tool === "laser") hideLaser();
    tool = next;
    document.body.classList.toggle("drawing", tool !== "none");
    palette?.render();
    updateInteractive();
  };

  let interactiveKey = "";
  const updateInteractive = () => {
    if (!presenter) return;
    const value = tool !== "none" ? true : palette ? [palette.region()] : false;
    const key = JSON.stringify(value);
    if (key === interactiveKey) return;
    interactiveKey = key;
    presio.ui.setInteractive(value);
  };

  const showPalette = () => {
    const wanted = presenter && presio.settings.get("toolbar") !== false;
    if (wanted && !palette) {
      palette = new Palette(root, {
        tool: () => tool,
        setTool,
        style: styleOf,
        setStyle: (t, style) => {
          const current = styleOf(t);
          if (style.color && style.color !== current.color) void presio.settings.set(`${t}Color`, style.color);
          if (style.size && style.size !== current.size) void presio.settings.set(`${t}Size`, style.size);
        },
        canUndo: () => drawing.strokes(slide).length > 0,
        undo: () => {
          publish(drawing.undo(slide));
          redrawCommitted();
        },
        clear: () => {
          publish(drawing.clear(slide));
          redrawCommitted();
        },
        canSave: () => drawing.drawnSlides().length > 0,
        save: () => {
          const url = URL.createObjectURL(new Blob([serializeFile(drawing)], { type: "application/json" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = "slides-drawing.json";
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
        load: async (file) => {
          try {
            publish(drawing.replaceAll(parseFile(await file.text(), presio.slide.total)));
            redrawCommitted();
          } catch (err) {
            alert(err instanceof Error ? err.message : "Failed to load the drawing");
          }
        },
        changed: () => requestAnimationFrame(updateInteractive),
      });
      palette.setView(presio.ui.view);
      palette.setDimmed(!touchFirst && !presio.ui.hovered);
    } else if (!wanted && palette) {
      palette.el.remove();
      palette = null;
      setTool("none");
    }
    updateInteractive();
  };

  if (presenter) {
    // The palette is drawn in Presio's colors.
    const theme = () => (document.documentElement.className = presio.theme);
    theme();
    presio.onContextChange(theme);
    tool = "none";
    const stored = presio.storage.get("tool");
    if (stored === "laser" || stored === "pen" || stored === "highlighter") applyTool(stored);
    presio.storage.onChange((all) => {
      const t = all.tool;
      applyTool(t === "laser" || t === "pen" || t === "highlighter" ? t : "none");
    });
    presio.settings.onChange(() => {
      showPalette();
      palette?.render();
    });
    presio.ui.onHover((hovered) => {
      palette?.setDimmed(!touchFirst && !hovered);
      // A mouse that wandered off leaves nothing to point at.
      if (!hovered && tool === "laser") hideLaser();
    });
    showPalette();
  } else {
    // A viewer's own download gets what's drawn too.
    // pdf-lib only loads when a download asks for it.
    presio.deck.onExport(async (bytes) => (await import("./bake")).bakeDrawing(bytes, drawing));
  }

  presio.ui.onViewChange((view) => {
    palette?.setView(view);
    resize();
  });
  window.addEventListener("resize", () => {
    resize();
    palette?.setView(presio.ui.view);
  });

  // --- Messages ---

  presio.onMessage(({ type, payload }) => {
    const changed = drawing.apply(type, payload);
    if (changed !== null) {
      if (changed === slide) redrawCommitted();
      return;
    }
    if (presenter) return;
    if (type === "b") {
      const b = parseBegin(payload);
      if (b) beginDraft({ id: b.id, tool: b.tool, color: b.color, width: b.width, points: b.points }, b.slide);
    } else if (type === "p") {
      const p = payload as { i?: unknown; d?: unknown } | null;
      const points = decodePoints(p?.d);
      if (draft && points && p?.i === draft.stroke.id) {
        draft.stroke.points.push(...points);
        schedule();
      }
    } else if (type === "x") {
      if (draft && (payload as { i?: unknown } | null)?.i === draft.stroke.id) endDraft();
    } else if (type === "l") {
      onRemoteLaser(payload);
    }
  });

  presio.slide.onChange(({ current }) => {
    if (current === slide) return;
    // A stroke in progress belongs to the slide it began on.
    if (presenter && draft) finishStroke();
    slide = current;
    drawn = null;
    redrawCommitted();
    if (draft) {
      stable.ctx.clearRect(0, 0, W, H);
      tip.ctx.clearRect(0, 0, W, H);
      draft.live.reset();
      schedule();
    }
  });

  // A different document: what was drawn belonged to the old one's slides
  // (and its retained chunks are forgotten everywhere with it).
  presio.deck.onChange((kind) => {
    if (kind !== "replace") return;
    if (draft) endDraft();
    drawing.reset();
    redrawCommitted();
  });

  resize();
}
