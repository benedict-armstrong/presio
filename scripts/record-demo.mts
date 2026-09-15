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
const PORT = Number(process.env.DEMO_PORT || 4181);
const BASE = `http://localhost:${PORT}`;
const OUT = path.resolve(__dirname, ".demo-out");
const PUBLIC = path.resolve(__dirname, "../client/public");
const DECK = path.resolve(__dirname, "demo-deck/deck.pdf");
const DECK_SLIDES = 7;

// The viewer is a projector (16:9); the controller is the presenter's laptop.
const VIEWER = { width: 1280, height: 720 };
const CONTROLLER = { width: 1280, height: 800 };

// Everything before T0 (page load, dialog dismissal, the viewer's 10s hint) is
// trimmed off the front of both clips.
const LEAD_MS = 1500;
const DURATION_MS = 24_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Boot the E2E harness on our own port, serving the demo deck.
async function startHarness() {
  if (!fs.existsSync(DECK)) {
    throw new Error(`missing ${DECK} — run: typst compile scripts/demo-deck/deck.typ`);
  }
  const child = spawn("npx", ["tsx", path.resolve(__dirname, "../server/e2eHarness.ts")], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      E2E_PDF: DECK,
      E2E_TOTAL_SLIDES: String(DECK_SLIDES),
      E2E_FILENAME: "Cutting our p99 in half.pdf",
    },
    stdio: "ignore",
  });

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return child;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`harness did not come up on ${BASE}`);
}

// One full pass: both windows in the given theme, recorded and encoded.
async function record(browser: Browser, theme: "light" | "dark") {
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

  await controller.locator("body").click();
  await sleep(600);

  // ---- T0: everything below runs on a shared wall clock ----
  const t0 = Date.now();
  const at = async (ms: number) => {
    const wait = t0 + ms - Date.now();
    if (wait > 0) await sleep(wait);
  };

  const next = () => controller.keyboard.press("ArrowRight");

  await at(1500);
  await next(); // title -> "Where the time went"

  await at(5000);
  await next(); // -> "One writer, many waiters"

  await at(8500);
  await next(); // -> "What we changed"

  // "j5" + Enter: the jump-to-page binding, with the pending digits visible in
  // the footer counter as they're typed. Lands on the payoff slide.
  await at(12_000);
  await controller.keyboard.press("j");
  await at(12_500);
  await controller.keyboard.press("5");
  await at(13_200);
  await controller.keyboard.press("Enter");

  await at(17_000);
  await next(); // -> "Questions"

  // Land back on slide 1 so the loop seam is invisible. firstSlide is bound to
  // Meta+ArrowLeft, which Playwright can't press portably — reuse the jump.
  await at(20_000);
  await controller.keyboard.press("j");
  await at(20_400);
  await controller.keyboard.press("1");
  await at(20_900);
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

  const harness = await startHarness();
  process.on("exit", () => harness.kill());

  const browser = await chromium.launch();
  const written: string[] = [];
  // Sequential, not parallel: two decks rendering at once makes the wall-clock
  // choreography miss its marks on a loaded machine.
  for (const theme of ["light", "dark"] as const) {
    written.push(...(await record(browser, theme)));
  }
  await browser.close();
  harness.kill();

  for (const f of written) {
    console.log(`${path.basename(f)}  ${(fs.statSync(f).size / 1e6).toFixed(2)} MB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
