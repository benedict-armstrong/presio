import { test, expect } from "@playwright/test";
import { TOTAL_SLIDES } from "./constants";
import {
  jumpToSlide,
  newSession,
  openController,
  openViewer,
  slideCounter,
  waitForSlide,
} from "./helpers";

// Getting to a specific slide is the thing a presenter does most, and there are
// three ways to do it: the arrow keys (covered by sync.spec.ts), the `j<number>`
// binding, and typing into the page counter. The last two both go through the
// counter, which is also the readout, so a regression there is silent.

test("the j<number> binding jumps the deck and shows the digits as they land", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(controller);
  // The viewer has to have joined the room before the controller broadcasts,
  // or it simply misses the update.
  await waitForSlide(viewer);

  const viewerSlide = viewer.getByTestId("viewer-slide");
  await expect(viewerSlide).toHaveAttribute("data-slide", "1");
  await controller.locator("body").click();

  // jumpToSlide asserts the counter mid-flight: empty once armed, then the
  // digits as they accumulate.
  await jumpToSlide(controller, 5);

  await expect(slideCounter(controller)).toHaveValue("5");
  await expect(viewerSlide).toHaveAttribute("data-slide", "5");

  // A two-digit deck position would accumulate the same way; with a 7-page
  // fixture, check instead that a jump past the end is clamped rather than
  // sending the deck somewhere that doesn't exist.
  await jumpToSlide(controller, 9);
  await expect(viewerSlide).toHaveAttribute("data-slide", String(TOTAL_SLIDES));

  await ctx.close();
});

test("an armed jump is abandoned by any non-digit key", async ({ browser, request }) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  await waitForSlide(controller);
  await controller.locator("body").click();

  const counter = slideCounter(controller);

  // While armed, every keystroke belongs to the jump — so Escape cancels it
  // rather than firing its own shortcut halfway through a page number.
  await controller.keyboard.press("j");
  await expect(counter).toHaveValue("");
  await controller.keyboard.press("3");
  await expect(counter).toHaveValue("3");
  await controller.keyboard.press("Escape");

  // Back to reading the live page, and the deck never moved.
  await expect(counter).toHaveValue("1");

  // The arrow keys work again immediately, i.e. the jump really is disarmed.
  await controller.keyboard.press("ArrowRight");
  await expect(counter).toHaveValue("2");

  await ctx.close();
});

test("typing a page into the counter moves the deck", async ({ browser, request }) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(controller);
  await waitForSlide(viewer);

  const counter = slideCounter(controller);
  // Focusing selects the current page, so typing replaces it.
  await counter.click();
  await counter.fill("4");
  await counter.press("Enter");

  await expect(viewer.getByTestId("viewer-slide")).toHaveAttribute("data-slide", "4");
  await expect(counter).toHaveValue("4");

  await ctx.close();
});

test("a viewer that navigates on its own goes out of sync and can rejoin", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(controller);
  await waitForSlide(viewer);

  const viewerSlide = viewer.getByTestId("viewer-slide");
  const resync = viewer.getByRole("button", { name: "Sync" });

  // An audience member reading ahead: the viewer moves without the presenter.
  await expect(resync).toBeHidden();
  await viewer.locator("body").click();
  await viewer.keyboard.press("ArrowRight");
  await expect(viewerSlide).toHaveAttribute("data-slide", "2");

  // It must say so rather than silently drifting.
  await expect(resync).toBeVisible();

  // The presenter stays where they were — a viewer reading ahead must not drag
  // the room with it.
  await expect(slideCounter(controller)).toHaveValue("1");

  // And rejoining snaps back to the presenter.
  await resync.click();
  await expect(viewerSlide).toHaveAttribute("data-slide", "1");
  await expect(resync).toBeHidden();

  await ctx.close();
});
