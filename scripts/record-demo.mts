// Records the two-up homepage demo: one video of the controller, one of the
// viewer, driven by a single script so the pair stays in lockstep.
//
// Both contexts are created back-to-back and every action fires on a wall-clock
// schedule measured from a shared T0, so the two recordings can be trimmed to a
// common origin and overlaid. The page still resyncs them at playback time —
// see DemoReel in client/src/pages/Home.tsx — but the closer they start, the
// less there is to correct.
//
// Usage:
//   npm run build --prefix client   # the harness serves client/dist
//   npm run record:demo
//
// Boots the E2E harness itself, pointed at scripts/demo-deck (not the media
// test fixture the specs use). Records the whole sequence twice, once per
// theme, and encodes client/public/demo-{controller,viewer}-{light,dark}.mp4
// plus a poster for each.
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_ID, CONTROLLER_TOKEN } from "../e2e/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT_BASE = Number(process.env.DEMO_PORT || 4181);
const OUT = path.resolve(__dirname, ".demo-out");
const PUBLIC = path.resolve(__dirname, "../client/public");
const DECK = path.resolve(__dirname, "demo-deck/deck.pdf");
const DECK_SLIDES = 8;

// The viewer is a projector (16:9); the controller is the presenter's laptop.
const VIEWER = { width: 1280, height: 720 };
const CONTROLLER = { width: 1280, height: 800 };

// Everything before T0 (page load, dialog dismissal, the viewer's 10s hint) is
// trimmed off the front of both clips.
const LEAD_MS = 1500;
const DURATION_MS = 34_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Boot the E2E harness on its own port, serving the demo deck.
//
// Each pass gets a FRESH harness. Annotations live in the session the harness
// holds, so a second pass against the same one starts with the first pass's
// strokes already drawn — they appear on the slide the moment it opens instead
// of being drawn on camera.
async function startHarness(port: number) {
  if (!fs.existsSync(DECK)) {
    throw new Error(`missing ${DECK} — run: typst compile scripts/demo-deck/deck.typ`);
  }
  const child = spawn("npx", ["tsx", path.resolve(__dirname, "../server/e2eHarness.ts")], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      E2E_PDF: DECK,
      E2E_TOTAL_SLIDES: String(DECK_SLIDES),
      E2E_FILENAME: "Presio — a quick tour.pdf",
    },
    stdio: "ignore",
  });

  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(base);
      if (res.ok) return { child, base };
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`harness did not come up on ${base}`);
}

// One full pass: both windows in the given theme, recorded and encoded.
async function record(browser: Browser, theme: "light" | "dark", BASE: string) {
  const controllerCtx = await browser.newContext({
    viewport: CONTROLLER,
    recordVideo: { dir: OUT, size: CONTROLLER },
  });
  const viewerCtx = await browser.newContext({
    viewport: VIEWER,
    recordVideo: { dir: OUT, size: VIEWER },
  });

  // Recording starts when the PAGE opens, not when the context is created, so
  // both pages are opened back-to-back and stamped here — before either
  // navigation, which is slow enough to skew the two clips seconds apart.
  const controller = await controllerCtx.newPage();
  const controllerStart = Date.now();
  const viewer = await viewerCtx.newPage();
  const viewerStart = Date.now();

  // ThemeProvider reads localStorage on mount, so pinning it here avoids
  // recording whatever the machine's OS preference happens to be.
  for (const page of [controller, viewer]) {
    await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
  }
  await controller.addInitScript(
    ([id, token]) => {
      localStorage.setItem(`session_${id}`, JSON.stringify({ controllerToken: token }));
      localStorage.setItem("presio_controller_onboarded", "true");
    },
    [SESSION_ID, CONTROLLER_TOKEN]
  );
  await controller.goto(`${BASE}/s/${SESSION_ID}?role=controller`);
  await viewer.goto(`${BASE}/s/${SESSION_ID}?role=viewer`);

  // The controller offers to spawn a viewer window; we already have one.
  const notNow = controller.getByRole("button", { name: "Not now" });
  await notNow.click({ timeout: 15_000 }).catch(() => {});

  // Both decks must actually be rendered before the clock starts.
  await viewer.locator('[data-testid="viewer-slide"] canvas').first().waitFor({ timeout: 30_000 });
  await controller.locator("canvas").first().waitFor({ timeout: 30_000 });

  // The viewer's keyboard hint fades after 10s or on a navigation key. PageUp on
  // slide 1 is a no-op, so it dismisses the hint without moving the deck.
  await viewer.keyboard.press("PageUp");
  await sleep(1200);

  // A running clock sells the presenter-tools half of the story; start it just
  // before T0 so it reads as a live talk rather than a fresh page.
  await controller.getByRole("button", { name: "Start", exact: true }).click().catch(() => {});

  // The tool palette collapses to a grip when idle; make sure it is expanded so
  // the laser and pen buttons are hittable once the clock starts.
  const anyTool = controller.getByTestId("tool-laser").or(controller.getByTestId("tool-collapsed"));
  if (!(await anyTool.first().isVisible().catch(() => false))) {
    await controller.getByTestId("toolbar-toggle").click().catch(() => {});
    await anyTool.first().waitFor({ timeout: 10_000 });
  }

  await controller.locator("body").click();
  await sleep(600);

  // ---- T0: everything below runs on a shared wall clock ----
  const t0 = Date.now();
  const at = async (ms: number) => {
    const wait = t0 + ms - Date.now();
    if (wait > 0) await sleep(wait);
  };

  const next = () => controller.keyboard.press("ArrowRight");

  // Coordinates are fractions of the RENDERED PAGE, not of the card holding it
  // — the slide is letterboxed inside that card, so card fractions land in the
  // empty margin. The pdf.js canvas is exactly the page rect.
  const surface = controller.locator(".touch-none canvas").first();
  const box = await surface.boundingBox();
  if (!box) throw new Error("could not find the controller's rendered slide");
  const at_ = (fx: number, fy: number) =>
    ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // With a tool active and the pointer away, the palette collapses to just the
  // active tool, so the others have to be revealed before they can be clicked.
  const pickTool = async (key: "none" | "laser" | "pen") => {
    const btn = controller.getByTestId(`tool-${key}`);
    if (!(await btn.isVisible().catch(() => false))) {
      await controller.getByTestId("tool-collapsed").click();
      await btn.waitFor({ timeout: 5_000 });
    }
    await btn.click();
  };

  // Trace a path with the pointer, optionally holding the button down (a
  // stroke) rather than just hovering (a laser).
  const trace = async (points: [number, number][], draw: boolean, stepMs = 45) => {
    const first = at_(...points[0]);
    await controller.mouse.move(first.x, first.y);
    if (draw) await controller.mouse.down();
    for (const [fx, fy] of points.slice(1)) {
      const p = at_(fx, fy);
      await controller.mouse.move(p.x, p.y, { steps: 6 });
      await sleep(stepMs);
    }
    if (draw) await controller.mouse.up();
  };

  // The deck opens on a cover and a title slide, so two presses get to the
  // first slide with anything on it to point at.
  await at(800);
  await next();
  await at(1800);
  await next(); // -> "Two windows, one deck"

  // Laser: sweep across the three window sketches as if calling them out in
  // the room. One pass per window, alternating direction.
  await at(3200);
  await pickTool("laser");
  await at(3800);
  await trace(
    [[0.55, 0.295], [0.72, 0.29], [0.90, 0.295], [0.80, 0.445], [0.62, 0.445], [0.56, 0.615], [0.70, 0.61]],
    false
  );

  await at(8000);
  await next(); // -> "Your PDF stays in the browser"

  // Drawing: underline the clause that matters, twice, the way a marker does.
  await at(9000);
  await pickTool("pen");
  await at(9800);
  await trace([[0.05, 0.285], [0.32, 0.30], [0.62, 0.29], [0.92, 0.305]], true, 35);
  await at(11_400);
  await trace([[0.05, 0.355], [0.18, 0.368], [0.32, 0.358]], true, 35);

  // Back to the plain pointer before moving on, so the cursor is not a pen for
  // the rest of the run. The strokes themselves can stay: the clip is linear,
  // so this slide is never revisited and the loop restarts before it.
  await at(13_000);
  await pickTool("none");

  await at(14_200);
  await next(); // -> "While you are talking"

  // "j6" + Enter: the jump binding, digits visible in the footer counter as
  // they land. Goes to the media slide, which needs a beat to start playing.
  await at(17_000);
  await controller.keyboard.press("j");
  await at(17_500);
  await controller.keyboard.press("6");
  await at(18_200);
  await controller.keyboard.press("Enter");

  await at(25_000);
  await next(); // -> "One import away"

  await at(28_500);
  await next(); // -> "Questions"

  // Land back on slide 1 so the loop seam is invisible. firstSlide is bound to
  // Meta+ArrowLeft, which Playwright can't press portably — reuse the jump.
  await at(31_000);
  await controller.keyboard.press("j");
  await at(31_400);
  await controller.keyboard.press("1");
  await at(31_900);
  await controller.keyboard.press("Enter");

  await at(DURATION_MS);
  // ---- end ----

  const grab = async (ctx: BrowserContext, page: Page, name: string) => {
    const video = page.video();
    if (!video) throw new Error(`no video recorded for ${name}`);
    await ctx.close(); // flushes the file
    const src = await video.path();
    const dest = path.join(OUT, `${name}-${theme}.webm`);
    fs.renameSync(src, dest);
    return dest;
  };

  const controllerWebm = await grab(controllerCtx, controller, "controller");
  const viewerWebm = await grab(viewerCtx, viewer, "viewer");

  // Trim each clip to the shared T0. The offsets differ by the few ms between
  // the two page creations, which is when recording actually began.
  const encode = (webm: string, out: string, startedAt: number, size: { width: number; height: number }) => {
    const seek = Math.max(0, (t0 - startedAt + LEAD_MS) / 1000);
    const dest = path.join(PUBLIC, out);
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-ss", seek.toFixed(3),
        "-i", webm,
        "-t", ((DURATION_MS - LEAD_MS) / 1000).toFixed(3),
        "-an",
        "-vf", `scale=${size.width}:${size.height}:flags=lanczos,fps=30`,
        "-c:v", "libx264",
        "-profile:v", "high",
        "-crf", "26",
        "-preset", "slow",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        dest,
      ],
      { stdio: "inherit" }
    );
    return dest;
  };

  const c = encode(controllerWebm, `demo-controller-${theme}.mp4`, controllerStart, CONTROLLER);
  const v = encode(viewerWebm, `demo-viewer-${theme}.mp4`, viewerStart, VIEWER);

  // Poster frames for the reduced-motion path.
  const poster = (clip: string, out: string) =>
    execFileSync(
      "ffmpeg",
      ["-y", "-ss", "3", "-i", clip, "-frames:v", "1", "-q:v", "4", path.join(PUBLIC, out)],
      { stdio: "inherit" }
    );
  poster(c, `demo-controller-${theme}-poster.jpg`);
  poster(v, `demo-viewer-${theme}-poster.jpg`);

  return [c, v];
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const written: string[] = [];
  const themes = ["light", "dark"] as const;

  // Sequential, not parallel: two decks rendering at once makes the wall-clock
  // choreography miss its marks on a loaded machine. Each pass gets its own
  // harness on its own port so no state carries between them.
  for (const [i, theme] of themes.entries()) {
    const { child, base } = await startHarness(PORT_BASE + i);
    try {
      written.push(...(await record(browser, theme, base)));
    } finally {
      child.kill();
    }
  }
  await browser.close();

  for (const f of written) {
    console.log(`${path.basename(f)}  ${(fs.statSync(f).size / 1e6).toFixed(2)} MB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
