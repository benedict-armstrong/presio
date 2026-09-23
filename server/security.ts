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

// Content-Security-Policy directives. Allows the YouTube/Vimeo embed SDKs and
// their iframes, the Supabase API/storage, optional analytics, and websockets.
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
    "script-src": ["'self'", "'wasm-unsafe-eval'", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com", ...(analyticsHost ? [analyticsHost] : [])],
    "frame-src": ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "media-src": ["'self'", "blob:", "https:"],
    // `https:` lets the client fetch externally-hosted PDFs ("bring your own
    // storage") from any HTTPS origin via pdf.js. img-src/media-src already
    // allow https:, so this keeps connect-src consistent with them.
    // The loopback origins let a presenter load a plugin they're developing
    // from their own dev server (Settings → Plugins → dev URL) against any
    // Presio deployment, the way a VS Code extension is run from source.
    "connect-src": ["'self'", "blob:", "data:", "ws:", "wss:", "https:", "https://vimeo.com", "http://localhost:*", "http://127.0.0.1:*", ...(supabaseHost ? [supabaseHost] : [])],
    "worker-src": ["'self'", "blob:"],
    "upgrade-insecure-requests": null,
  };
}

// The page every plugin runs in (client/public/plugin-frame.html), loaded in a
// sandboxed iframe with an opaque origin. Plugins are single-file HTML, so
// inline script and style are allowed — and nothing else: no network in any
// form (fetch, images, fonts, navigation), so a plugin that was handed the deck
// has no way to send it anywhere. Mirrored by the page's own <meta> policy,
// which is what applies under the Vite dev server.
export const PLUGIN_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");
