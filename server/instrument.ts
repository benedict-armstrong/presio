// Sentry initialization. Imported first thing in index.ts so the SDK can
// auto-instrument http/express before they're required. Gated by SENTRY_DSN:
// with no DSN set the SDK never initializes and is a complete no-op, so this is
// safe to ship disabled by default. The DSN can point at Sentry's SaaS or a
// self-hosted GlitchTip instance — same protocol, no code change.
import "dotenv/config";
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;
const isDev = process.env.NODE_ENV === "development";

// Idempotent: this file is loaded both via `--import` (for full auto-
// instrumentation, before any app module) and as the first import in index.ts
// (a fallback so a plain `tsx index.ts` still reports errors). Skip if already
// initialized so the two paths don't double-init. Also skip in development so
// local debugging doesn't spam Sentry.
if (dsn && !isDev && !Sentry.getClient()) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "production",
    // Sample a fraction of transactions for performance traces. Tune via env;
    // default low so a busy server doesn't flood the quota.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
  });
  console.log("Sentry error tracking enabled");
}
