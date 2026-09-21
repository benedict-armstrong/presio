import type express from "express";

/**
 * The deployment's public origins, in priority order.
 *
 * PUBLIC_BASE_URLS is comma-separated so one deployment can serve several
 * domains at once (presio.ch and presio.xyz both serve the app — see #108).
 * PUBLIC_BASE_URL remains a single-value alias so existing self-hosted .env
 * files keep working unchanged.
 *
 * Derived once at startup so a malformed value is reported here rather than
 * silently per request. A bad entry is dropped and the rest still apply —
 * losing one domain is better than falling back to the Host header for all of
 * them (see baseUrl below for why that matters).
 */
const configuredOrigins: string[] = (() => {
  const raw = (process.env.PUBLIC_BASE_URLS ?? process.env.PUBLIC_BASE_URL ?? "").trim();
  if (!raw) return [];
  const origins: string[] = [];
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (!value) continue;
    try {
      const { origin } = new URL(value);
      if (!origins.includes(origin)) origins.push(origin);
    } catch {
      console.error(`Ignoring malformed public base URL: ${value}`);
    }
  }
  return origins;
})();

/** Host (including any port) of each configured origin, for request matching. */
const originsByHost = new Map(configuredOrigins.map((o) => [new URL(o).host.toLowerCase(), o]));

/** Falls back to the request's own origin when nothing is configured. */
function requestOrigin(req: express.Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

/**
 * Absolute origin for links we hand back to the caller — presentation handoff
 * and share URLs.
 *
 * Follows the request: a visitor on presio.ch who shares a deck must get a
 * presio.ch link, because the whole point of the second domain is that some
 * networks block the first one (#74). An unlisted Host falls back to the first
 * configured origin rather than being echoed, so a spoofed Host still cannot
 * poison a generated link — Traefik's Host() rule rejects anything unlisted
 * long before it reaches Express, but this does not depend on that.
 *
 * With nothing configured we use the request's own protocol + Host, which the
 * client controls. That is still the right default for local / LAN use, where
 * the server is legitimately reached as localhost, a LAN IP, or a hostname
 * that isn't knowable at startup — so set PUBLIC_BASE_URLS on any deployment
 * served from a known domain.
 */
export function baseUrl(req: express.Request): string {
  if (!configuredOrigins.length) return requestOrigin(req);
  const host = req.get("host")?.toLowerCase();
  return (host && originsByHost.get(host)) || configuredOrigins[0];
}

/**
 * Absolute origin for statements about who this deployment *is*, rather than
 * how the caller happened to reach it: <link rel="canonical">, og:url, the
 * sitemap, OpenAPI `servers`, MCP discovery and JSON Schema `$schema` ids.
 *
 * Always the first configured origin. Dual-homed, both domains serve
 * byte-identical pages, so self-canonicalising on each would present two
 * origins of duplicate content and split them for crawlers; and a `$schema`
 * id that varies by which domain you asked is not much of an id.
 */
export function canonicalBaseUrl(req: express.Request): string {
  return configuredOrigins[0] ?? requestOrigin(req);
}
