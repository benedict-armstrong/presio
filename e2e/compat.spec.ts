import { test, expect } from "@playwright/test";
import { newSession, openController, waitForSlide } from "./helpers";

// Browser-compatibility smoke test. Runs on Chromium and WebKit (see
// playwright.config.ts) and fails on any uncaught error, which is how the
// "black screen on iPadOS 17" class of bug (#145) shows up.
//
// Playwright's browsers are current, so they have every API. The "legacy"
// variant deletes the ones src/polyfills.ts exists to supply before any page
// script runs, to prove the polyfills are loaded early enough. This only
// reaches the main thread; the pdf.js worker's own polyfill import is covered
// by scripts/check-compat.mjs (client: `npm run check:compat`).

/** Runs in the page before any of its scripts. */
function removeModernApis() {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.Iterator;
  delete (URL as unknown as Record<string, unknown>).parse;
  delete (Promise as unknown as Record<string, unknown>).withResolvers;
  delete (AbortSignal as unknown as Record<string, unknown>).any;
  delete (AbortSignal as unknown as Record<string, unknown>).timeout;
  delete (Uint8Array.prototype as unknown as Record<string, unknown>).toHex;
  delete (Map.prototype as unknown as Record<string, unknown>).getOrInsertComputed;
  delete (Array.prototype as unknown as Record<string, unknown>).toSorted;
}

for (const legacy of [false, true]) {
  test.describe(legacy ? "without modern APIs" : "current browser", () => {
    test("the home page renders without errors", async ({ browser }) => {
      const ctx = await browser.newContext();
      if (legacy) await ctx.addInitScript(removeModernApis);
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("/");
      await expect(page.locator("#root > *").first()).toBeAttached();
      expect(errors).toEqual([]);
      await ctx.close();
    });

    test("a deck opens and paints its first slide", async ({ browser, request }) => {
      const sessionId = await newSession(request);
      const ctx = await browser.newContext();
      if (legacy) await ctx.addInitScript(removeModernApis);
      // Attached before the page exists, so load-time errors are seen.
      const errors: string[] = [];
      ctx.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
      const controller = await openController(ctx, sessionId);
      await waitForSlide(controller);
      expect(errors).toEqual([]);
      await ctx.close();
    });
  });
}
