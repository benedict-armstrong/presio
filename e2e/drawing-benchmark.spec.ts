import { test, expect, type BrowserContext, type CDPSession, type Frame, type Page, type WebSocket } from "@playwright/test";
import { newSession, openController, openViewer, pickTool, waitForSlide } from "./helpers";

// How smooth drawing feels, measured. Three numbers, each driven through the
// real input pipeline (page.mouse → Chrome's input router → the page) and the
// real controller → server → viewer socket:
//
//  1. Presenter input → paint latency: from a pointer event's timestamp to the
//     end of the first frame in which the stroke's ink covers that point.
//  2. Viewer updates during one long stroke: how often the viewer hears about
//     it, and how many bytes each update costs on the wire.
//  3. Redraw cost on a busy slide (a few hundred strokes already on it): frame
//     rate and main-thread time per pointer event while drawing over them.
//
// It runs as part of the suite and prints its numbers beside the baseline
// below. Counts and bytes are asserted against it outright; timings only
// loosely, since they move with the machine.

type Adapter = {
  /** The document the stroke is drawn into, and its box on the page. */
  surface(page: Page): Promise<{ frame: Frame; box: { x: number; y: number; width: number; height: number } }>;
  /** Canvases (in that document) whose pixels are the ink. */
  inkCanvases: string;
  /** Put `strokes` (presio-drawing v1 strokes) on slide 1: before the
   *  controller loads, or once it has. */
  seed(ctx: BrowserContext, sessionId: string, strokes: Stroke[]): Promise<void>;
  afterLoad(page: Page, strokes: Stroke[]): Promise<void>;
  /** Whether a socket frame the viewer received is a live-stroke update. */
  isStrokeUpdate(payload: string): boolean;
  /** Whether a socket frame the viewer received is about drawing at all. */
  isDrawing(payload: string): boolean;
};

interface Stroke {
  tool: "pen" | "highlighter";
  color: string;
  size: number;
  opacity: number;
  points: number[];
}

const DRAWING_FRAME = '[data-testid="plugin-frame-drawing-slide"]';

// The drawing plugin: a "slide" surface frame on the page, syncing over
// plugin_event messages.
const plugin: Adapter = {
  async surface(page) {
    const el = page.locator(DRAWING_FRAME).first();
    await el.waitFor({ timeout: 30_000 });
    const box = (await el.boundingBox())!;
    const frame = await (await el.elementHandle())!.contentFrame();
    return { frame: frame!, box };
  },
  inkCanvases: "canvas",
  async seed() {},
  // Loaded the way a presenter would: a saved drawing file, picked with
  // "Load from file" on the plugin's page in Settings.
  async afterLoad(page, strokes) {
    await plugin.surface(page);
    const file = { format: "presio-drawing", version: 1, annotations: { 1: strokes } };
    await page.locator('button[title="Settings"]').first().click();
    await page.locator('[data-testid="settings-tab-plugin:/plugins/drawing/"]').click();
    const chooser = page.waitForEvent("filechooser");
    await page.locator('[data-testid="plugin-button-drawing-loadFile"]').click();
    await (await chooser).setFiles({
      name: "busy.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(file)),
    });
    // Not Escape: that's also the drawing plugin's "no tool" shortcut.
    await page.getByRole("button", { name: "Close settings" }).click();
  },
  isStrokeUpdate: (p) => p.includes('"plugin":"drawing"') && /"type":"(p|b)"/.test(p),
  isDrawing: (p) => p.includes('"plugin":"drawing"'),
};

const adapter = plugin;

/**
 * What drawing measured before it moved into a plugin (core's
 * AnnotationOverlay: a full redraw per pointer event, stroke updates every
 * 33 ms each resending the whole stroke), on the same runs. Kept so a change
 * that loses ground shows up here.
 */
const BASELINE = {
  "latency median ms": 13.7,
  "latency p95 ms": 14.9,
  "viewer updates": 199,
  "viewer updates/s": 29.8,
  "viewer bytes/update (mean)": 7270,
  "viewer bytes, whole stroke": 1_460_000,
  "busy: fps while drawing": 60,
  "busy: main-thread ms per move": 17.0,
  "busy: latency median ms": 31.0,
  "busy: latency p95 ms": 32.2,
};

// --- Driving the pointer ---

type Pt = [number, number];

/** A long, wavy stroke across the lower middle of the slide, in page fractions. */
function wave(n: number, y = 0.62, amp = 0.12, turns = 3): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push([0.15 + 0.7 * t, y + amp * Math.sin(t * Math.PI * 2 * turns)]);
  }
  return pts;
}

/** Deterministic pseudo-random strokes spread over the page. */
function busyStrokes(count: number, points = 40): Stroke[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out: Stroke[] = [];
  for (let s = 0; s < count; s++) {
    const pen = s % 4 !== 0;
    let x = 0.1 + rnd() * 0.8;
    let y = 0.1 + rnd() * 0.8;
    const flat: number[] = [];
    for (let i = 0; i < points; i++) {
      x = Math.min(0.98, Math.max(0.02, x + (rnd() - 0.5) * 0.03));
      y = Math.min(0.98, Math.max(0.02, y + (rnd() - 0.5) * 0.03));
      flat.push(+x.toFixed(4), +y.toFixed(4));
    }
    out.push({
      tool: pen ? "pen" : "highlighter",
      // Not the pen's red, so the latency probe can tell new ink from old.
      color: pen ? "#2563eb" : "#facc15",
      size: (pen ? 3 : 14) / 960,
      opacity: pen ? 1 : 0.35,
      points: flat,
    });
  }
  return out;
}

/** Drag through `path` with the button held, one move every `everyMs`. */
async function drag(page: Page, box: { x: number; y: number; width: number; height: number }, path: Pt[], everyMs = 8) {
  const at = ([fx, fy]: Pt) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const first = at(path[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of path.slice(1)) {
    const { x, y } = at(p);
    const started = Date.now();
    await page.mouse.move(x, y);
    const left = everyMs - (Date.now() - started);
    if (left > 0) await page.waitForTimeout(left);
  }
  await page.mouse.up();
}

// --- In-page probes ---

/**
 * Time each held-button pointermove until its point is inked. Registered in
 * the capture phase on the drawing document's window, so it sees every event
 * before the implementation does; checking after the frame's rendering
 * (rAF, then a task) is fair to code that draws in the handler and to code
 * that draws in its own requestAnimationFrame.
 */
async function installLatencyProbe(frame: Frame, canvases: string) {
  await frame.evaluate((selector) => {
    const w = window as unknown as { __bench: { lat: number[]; missed: number; frames: number[] } };
    w.__bench = { lat: [], missed: 0, frames: [] };
    const inked = (x: number, y: number) => {
      for (const c of document.querySelectorAll<HTMLCanvasElement>(selector)) {
        const r = c.getBoundingClientRect();
        if (!r.width || !r.height || !c.width || !c.height) continue;
        const cx = Math.round(((x - r.left) * c.width) / r.width);
        const cy = Math.round(((y - r.top) * c.height) / r.height);
        if (cx < 1 || cy < 1 || cx >= c.width - 1 || cy >= c.height - 1) continue;
        const ctx = c.getContext("2d");
        if (!ctx) continue;
        const { data } = ctx.getImageData(cx - 1, cy - 1, 3, 3);
        // The pen's red (#e11d48), not whatever is already on the slide.
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 60 && data[i] > 150 && data[i + 1] < 100 && data[i + 2] < 130) return true;
        }
      }
      return false;
    };
    window.addEventListener(
      "pointermove",
      (e) => {
        if (!e.buttons) return;
        const ev = { t: e.timeStamp, x: e.clientX, y: e.clientY };
        const check = () =>
          requestAnimationFrame(() =>
            setTimeout(() => {
              if (inked(ev.x, ev.y)) w.__bench.lat.push(performance.now() - ev.t);
              else if (performance.now() - ev.t < 500) check();
              else w.__bench.missed++;
            }, 0)
          );
        check();
      },
      true
    );
  }, canvases);
}

async function readLatency(frame: Frame) {
  return frame.evaluate(() => (window as unknown as { __bench: { lat: number[]; missed: number } }).__bench);
}

/** Count animation frames on the page while `run` goes. */
async function measureFrames(page: Page, cdp: CDPSession, run: () => Promise<number>) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __framesOn: boolean };
    w.__frames = [];
    w.__framesOn = true;
    const tick = (t: number) => {
      if (!w.__framesOn) return;
      w.__frames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const task = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "TaskDuration")!.value * 1000;
  };
  const before = await task();
  const moves = await run();
  const after = await task();
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __framesOn: boolean };
    w.__framesOn = false;
    return w.__frames;
  });
  const gaps = frames.slice(1).map((t, i) => t - frames[i]);
  const span = frames[frames.length - 1] - frames[0];
  return {
    fps: ((frames.length - 1) * 1000) / span,
    p95FrameMs: pct(gaps, 0.95),
    maxFrameMs: Math.max(...gaps),
    taskMsPerMove: (after - before) / moves,
  };
}

function pct(values: number[], p: number) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Socket frames the viewer receives, with arrival times. */
function recordSocket(page: Page) {
  const frames: { t: number; payload: string }[] = [];
  page.on("websocket", (ws: WebSocket) => {
    ws.on("framereceived", ({ payload }) => {
      frames.push({ t: Date.now(), payload: typeof payload === "string" ? payload : payload.toString("utf8") });
    });
  });
  return frames;
}

test.describe.configure({ mode: "serial" });

// Timing-sensitive and slow: it measures, so it only means something on an
// otherwise idle machine. Run it on purpose: PRESIO_BENCH=1 npx playwright test e2e/drawing-benchmark.spec.ts
test.skip(!process.env.PRESIO_BENCH, "benchmark: set PRESIO_BENCH=1 to run");

test("drawing benchmark", async ({ browser, request }, testInfo) => {
  test.setTimeout(120_000);
  const results: Record<string, number> = {};

  // --- 1 + 2: a long stroke on an empty slide, watched by a viewer ---
  {
    const sessionId = await newSession(request);
    const presenterCtx = await browser.newContext();
    // A separate context, so the only path to the viewer is the server socket.
    const viewerCtx = await browser.newContext();
    const viewer = await openViewer(viewerCtx, sessionId);
    const received = recordSocket(viewer);
    const controller = await openController(presenterCtx, sessionId);
    await waitForSlide(controller);
    await waitForSlide(viewer);
    await pickTool(controller, "pen");
    const { frame, box } = await adapter.surface(controller);
    await installLatencyProbe(frame, adapter.inkCanvases);

    await controller.waitForTimeout(500);
    const from = received.length;
    await drag(controller, box, wave(400));
    // Let the tail and the commit arrive.
    await controller.waitForTimeout(1500);

    const { lat, missed } = await readLatency(frame);
    results["latency median ms"] = round(pct(lat, 0.5));
    results["latency p95 ms"] = round(pct(lat, 0.95));
    results["latency missed"] = missed;

    const updates = received.slice(from).filter((f) => adapter.isStrokeUpdate(f.payload));
    const drawing = received.slice(from).filter((f) => adapter.isDrawing(f.payload));
    const span = updates.length > 1 ? updates[updates.length - 1].t - updates[0].t : NaN;
    results["viewer updates"] = updates.length;
    results["viewer updates/s"] = round(((updates.length - 1) * 1000) / span);
    results["viewer bytes/update (mean)"] = round(updates.reduce((n, f) => n + f.payload.length, 0) / updates.length, 0);
    results["viewer bytes/update (max)"] = Math.max(...updates.map((f) => f.payload.length));
    results["viewer bytes, whole stroke"] = drawing.reduce((n, f) => n + f.payload.length, 0);

    await presenterCtx.close();
    await viewerCtx.close();
  }

  // --- 3: drawing over a slide that already holds a few hundred strokes ---
  {
    const sessionId = await newSession(request);
    const ctx = await browser.newContext();
    const busy = busyStrokes(300);
    await adapter.seed(ctx, sessionId, busy);
    const controller = await openController(ctx, sessionId);
    await waitForSlide(controller);
    await pickTool(controller, "pen");
    await adapter.afterLoad(controller, busy);
    const { frame, box } = await adapter.surface(controller);
    // The seeded strokes are on screen before timing starts.
    await expect.poll(() => frame.evaluate((sel) => document.querySelectorAll(sel).length, adapter.inkCanvases)).toBeGreaterThan(0);
    await controller.waitForTimeout(1000);
    await installLatencyProbe(frame, adapter.inkCanvases);

    const cdp = await ctx.newCDPSession(controller);
    await cdp.send("Performance.enable");
    const path = wave(240, 0.5, 0.2, 4);
    const perf = await measureFrames(controller, cdp, async () => {
      await drag(controller, box, path);
      return path.length;
    });
    const { lat } = await readLatency(frame);
    results["busy: fps while drawing"] = round(perf.fps);
    results["busy: p95 frame ms"] = round(perf.p95FrameMs);
    results["busy: main-thread ms per move"] = round(perf.taskMsPerMove, 2);
    results["busy: latency median ms"] = round(pct(lat, 0.5));
    results["busy: latency p95 ms"] = round(pct(lat, 0.95));

    await ctx.close();
  }

  const base = BASELINE as Record<string, number>;
  console.log(
    `\nDrawing benchmark (baseline: before the plugin)\n${Object.entries(results)
      .map(([k, v]) => `  ${k.padEnd(34)} ${String(v).padStart(8)}   ${k in base ? `(${base[k]})` : ""}`)
      .join("\n")}\n`
  );
  await testInfo.attach("drawing-benchmark.json", { body: JSON.stringify(results, null, 2), contentType: "application/json" });

  expect(results["latency missed"]).toBe(0);
  // The rate is bounded by how fast the input comes, which a busy machine
  // slows; how many of the 400 moves reached the viewer as updates isn't.
  expect(results["viewer updates"]).toBeGreaterThan(BASELINE["viewer updates"]);
  expect(results["viewer bytes/update (mean)"]).toBeLessThan(BASELINE["viewer bytes/update (mean)"]);
  expect(results["viewer bytes, whole stroke"]).toBeLessThan(BASELINE["viewer bytes, whole stroke"]);
  expect(results["latency median ms"]).toBeLessThan(BASELINE["latency median ms"] * 1.5);
  expect(results["busy: main-thread ms per move"]).toBeLessThan(BASELINE["busy: main-thread ms per move"]);
});
