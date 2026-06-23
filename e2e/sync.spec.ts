import { test, expect } from "@playwright/test";
import { SESSION_ID, CONTROLLER_TOKEN } from "./constants";

// The controller and viewer run in separate browser contexts, so they share no
// BroadcastChannel (that's per-origin-per-profile) — the only path between them
// is the server socket. A slide change propagating from one to the other
// therefore exercises the full controller -> server -> viewer round-trip.

test("controller advancing a slide syncs to the viewer", async ({ browser }) => {
  const controllerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();

  // The controller proves ownership with the token stored in localStorage.
  const controller = await controllerCtx.newPage();
  await controller.addInitScript(
    ([id, token]) => {
      localStorage.setItem(`session_${id}`, JSON.stringify({ controllerToken: token }));
      // Skip the first-run tutorial overlay so it can't swallow key presses.
      localStorage.setItem("presio_controller_onboarded", "true");
    },
    [SESSION_ID, CONTROLLER_TOKEN]
  );
  await controller.goto(`/s/${SESSION_ID}?role=controller`);

  const viewer = await viewerCtx.newPage();
  await viewer.goto(`/s/${SESSION_ID}?role=viewer`);

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

  await controllerCtx.close();
  await viewerCtx.close();
});
