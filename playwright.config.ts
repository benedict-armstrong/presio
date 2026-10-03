import { defineConfig, devices } from "@playwright/test";

const PORT = 4180;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      // Default to Playwright's bundled chromium (used in CI). Set PW_CHANNEL=chrome
      // to drive a locally-installed Google Chrome instead, avoiding the browser
      // download on machines that already have Chrome.
      use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL || undefined },
    },
    {
      // Safari's engine, for the compat smoke test only: the full suite's
      // timing-sensitive specs are tuned for Chromium.
      name: "webkit",
      testMatch: "compat.spec.ts",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    // The harness serves the built client, so build it first.
    command: `npm run build --prefix client && PORT=${PORT} npx tsx server/e2eHarness.ts`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
