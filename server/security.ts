import helmet from "helmet";

// Allowed browser origins for cross-origin requests. The client and server are
// served from the same origin in production, so same-origin requests (which
// carry no Origin header, or one matching the host) always work. Set
// ALLOWED_ORIGIN (comma-separated) only when the client is hosted separately.
export function getAllowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function originOf(envUrl: string | undefined): string {
  try {
    return envUrl ? new URL(envUrl).origin : "";
  } catch {
    return "";
  }
}

// Content-Security-Policy directives. Allows the Supabase API/storage, optional
// analytics, and websockets. Media players (YouTube, Vimeo) run in the media
// plugin's frame, under PLUGIN_FRAME_CSP below, not in the app's own page.
export function buildCspDirectives() {
  const supabaseHost = originOf(process.env.SUPABASE_URL);
  const analyticsHost = originOf(process.env.ANALYTICS_URL);
  return {
    ...helmet.contentSecurityPolicy.getDefaultDirectives(),
    "default-src": ["'self'"],
    // 'wasm-unsafe-eval' is required for the code samples' syntax highlighting:
    // Shiki's Oniguruma regex engine is WebAssembly, and under a script-src
    // without it the browser refuses to compile the module. The failure is
    // silent by design (CodeBlock falls back to an unhighlighted <pre>) and
    // invisible in dev, where Vite serves the page without this CSP — so it
    // only ever shows up on a deployed origin. It permits WebAssembly
    // compilation, not JavaScript eval(): 'unsafe-eval' is still not granted.
    "script-src": ["'self'", "'wasm-unsafe-eval'", ...(analyticsHost ? [analyticsHost] : [])],
    "frame-src": ["'self'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "media-src": ["'self'", "blob:", "https:"],
    // `https:` lets the client fetch externally-hosted PDFs ("bring your own
    // storage") from any HTTPS origin via pdf.js. img-src/media-src already
    // allow https:, so this keeps connect-src consistent with them.
    // The loopback origins let a presenter load a plugin they're developing
    // from their own dev server (Settings → Plugins → dev URL) against any
    // Presio deployment, the way a VS Code extension is run from source.
    "connect-src": ["'self'", "blob:", "data:", "ws:", "wss:", "https:", "http://localhost:*", "http://127.0.0.1:*", ...(supabaseHost ? [supabaseHost] : [])],
    "worker-src": ["'self'", "blob:"],
    "upgrade-insecure-requests": null,
  };
}

// The plugin frame's policy, in place of the app's. Plugins are trusted code
// the presenter chose to install (as with VS Code extensions): the frame gives
// them a stable API and keeps a crashing plugin from taking the page down, not
// a security boundary. So nothing is locked down beyond keeping the frame
// embeddable only by Presio itself — plugins may fetch, embed players (YouTube,
// Vimeo), load media and scripts. What protects audiences is the separate
// viewer origin (VIEWER_BASE_URLS), not this frame.
export const PLUGIN_FRAME_CSP = [
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "frame-ancestors 'self'",
].join("; ");
