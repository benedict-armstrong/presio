import { test, expect } from "@playwright/test";
import {
  inkPixels,
  leaveSlide,
  newSession,
  openController,
  openViewer,
  pickTool,
  slideBox,
  trace,
  waitForSlide,
  type Frac,
} from "./helpers";

// The laser and the pen are the two presenter tools the demo reel shows, and
// both are only meaningful if they reach the *other* window: a laser dot the
// audience can't see is a no-op. These drive the real palette and the real
// pointer, then assert on what the viewer actually renders.
//
// Paths stay in the lower/middle of the slide. The tool palette parks itself at
// the slide's top-left and the pen's colour popover opens over the same corner,
// so a stroke aimed up there lands on the popover instead of the canvas —
// scripts/record-demo.mts drags the palette away for the same reason.

test("the laser dot reaches the viewer and clears when the pointer leaves", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(controller);
  await waitForSlide(viewer);

  const viewerDot = viewer.getByTestId("laser-dot");
  await expect(viewerDot).toHaveCount(0);

  await pickTool(controller, "laser");
  const sweep: Frac[] = [
    [0.3, 0.6],
    [0.45, 0.58],
    [0.6, 0.62],
    [0.72, 0.6],
  ];
  await trace(controller, sweep, false);

  // The controller sees its own dot, and the viewer sees the relayed one.
  await expect(controller.getByTestId("laser-dot")).toHaveAttribute("data-laser", "local");
  await expect(viewerDot).toHaveAttribute("data-laser", "remote");

  // It must land where it was pointed, not at the origin. The sweep ends near
  // x = 0.72 of the slide's content rect, which is where the viewer's dot
  // should sit too (the two windows are different sizes, so compare fractions).
  const { box: viewerBox } = await slideBox(viewer);
  const dotBox = await viewerDot.boundingBox();
  const dotFracX = ((dotBox?.x ?? 0) + (dotBox?.width ?? 0) / 2 - viewerBox.x) / viewerBox.width;
  expect(dotFracX).toBeGreaterThan(0.6);
  expect(dotFracX).toBeLessThan(0.85);

  // Leaving the slide sends an explicit null, so the audience's dot goes out
  // with the gesture rather than lingering until the 3s fallback timer.
  await leaveSlide(controller);
  await expect(viewerDot).toHaveCount(0);

  await ctx.close();
});

test("a pen stroke is drawn on the viewer and survives leaving and returning to the slide", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(controller);
  await waitForSlide(viewer);

  // Nothing drawn yet, on either side.
  expect(await inkPixels(controller)).toBe(0);
  expect(await inkPixels(viewer)).toBe(0);

  await pickTool(controller, "pen");
  const underline: Frac[] = [
    [0.25, 0.7],
    [0.38, 0.71],
    [0.5, 0.7],
    [0.62, 0.71],
    [0.75, 0.7],
  ];
  await trace(controller, underline, true);

  // Strokes live on a canvas, so "did it arrive" can only be answered in
  // pixels. Both windows must have ink.
  await expect.poll(() => inkPixels(controller)).toBeGreaterThan(0);
  await expect.poll(() => inkPixels(viewer)).toBeGreaterThan(0);

  // The stroke was committed, not just previewed: leaving the slide and coming
  // back re-renders it from the session's stored annotations rather than from
  // the in-flight draft.
  await controller.keyboard.press("ArrowRight");
  await expect(viewer.getByTestId("viewer-slide")).toHaveAttribute("data-slide", "2");
  await expect.poll(() => inkPixels(viewer)).toBe(0);

  await controller.keyboard.press("ArrowLeft");
  await expect(viewer.getByTestId("viewer-slide")).toHaveAttribute("data-slide", "1");
  await expect.poll(() => inkPixels(viewer)).toBeGreaterThan(0);

  await ctx.close();
});
