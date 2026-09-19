import { test, expect } from "@playwright/test";
import { newSession, openController, waitForSlide } from "./helpers";

// Spawning the second window is the first thing a presenter does, and the one
// step scripts/record-demo.mts deliberately skips (it brings its own viewer, so
// it clicks "Not now"). Nothing else covered it, so a regression in the popup
// path — a blocked window, a viewer that renders nothing, a viewer that never
// joins the session — would have gone unnoticed by the suite.

test("the controller's prompt spawns a viewer window that renders and follows the deck", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId, { keepViewerPrompt: true });

  // The prompt is the controller's opening move.
  const prompt = controller.getByRole("button", { name: "Open Viewer Window" });
  await expect(prompt).toBeVisible({ timeout: 15_000 });

  // window.open happens in the click handler, so the popup has to be awaited
  // alongside the click rather than after it.
  const [viewer] = await Promise.all([ctx.waitForEvent("page"), prompt.click()]);
  await viewer.waitForLoadState();

  // It must be a real viewer of *this* session, not a blank popup.
  expect(viewer.url()).toContain(`/s/${sessionId}`);
  const viewerSlide = viewer.getByTestId("viewer-slide");
  await expect(viewerSlide).toHaveAttribute("data-slide", "1");

  // And it must actually paint the deck — an empty viewer on the projector is
  // the failure that matters here.
  await waitForSlide(viewer);

  // Having opened, the prompt retires.
  await expect(prompt).toBeHidden();

  // The spawned window is a genuine session participant, not just a rendered
  // page: it follows the controller over the socket.
  await controller.locator("body").click();
  await controller.keyboard.press("ArrowRight");
  await expect(viewerSlide).toHaveAttribute("data-slide", "2");

  await ctx.close();
});

test("the toolbar re-opens a viewer window after the prompt is dismissed", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  // Dismisses the prompt, which is how a presenter who said "Not now" — or who
  // closed their viewer mid-talk — arrives at the toolbar button.
  const controller = await openController(ctx, sessionId);

  const [viewer] = await Promise.all([
    ctx.waitForEvent("page"),
    controller.getByRole("button", { name: "Open Viewer", exact: true }).click(),
  ]);
  await viewer.waitForLoadState();

  await expect(viewer.getByTestId("viewer-slide")).toHaveAttribute("data-slide", "1");
  await waitForSlide(viewer);

  await ctx.close();
});
