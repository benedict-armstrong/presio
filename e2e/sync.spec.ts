import { test, expect } from "@playwright/test";
import { newSession, openController, openViewer, waitForSlide } from "./helpers";

// The controller and viewer run in separate browser contexts, so they share no
// BroadcastChannel (that's per-origin-per-profile) — the only path between them
// is the server socket. A slide change propagating from one to the other
// therefore exercises the full controller -> server -> viewer round-trip.

test("controller advancing a slide syncs to the viewer", async ({ browser, request }) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();

  const controller = await openController(ctx, sessionId);
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(controller);
  await waitForSlide(viewer);

  // Both load on slide 1.
  const viewerSlide = viewer.getByTestId("viewer-slide");
  await expect(viewerSlide).toHaveAttribute("data-slide", "1");

  // Advance on the controller; the viewer must follow via the server.
  await controller.locator("body").click(); // ensure the window has focus
  await controller.keyboard.press("ArrowRight");
  await expect(viewerSlide).toHaveAttribute("data-slide", "2");

  // And back.
  await controller.keyboard.press("ArrowLeft");
  await expect(viewerSlide).toHaveAttribute("data-slide", "1");

  await ctx.close();
});
