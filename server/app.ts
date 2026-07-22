import express from "express";
import fs from "fs";
import * as Sentry from "@sentry/node";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAllowedOrigins, buildCspDirectives } from "./security.js";
import { baseUrl } from "./lib/baseUrl.js";
import { localBlobsDir } from "./local/paths.js";
import { isLocalMode } from "./local/mode.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerNewsletterRoutes } from "./routes/newsletter.js";
import { registerCheckRoute } from "./routes/check.js";
import { registerAgentDocRoutes } from "./routes/agentDocs.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import type { SocketState } from "./socket.js";

export interface AppDeps {
  supabase: SupabaseClient;
  io: Server;
  socketState?: SocketState;
}

export function createApp({ supabase, io, socketState }: AppDeps): express.Express {
  const app = express();

  // Exactly one reverse-proxy hop (Traefik) sits in front in production, so
  // trust one level of X-Forwarded-For. Without this every request appears to
  // come from the proxy's IP and the rate limiter throttles all users as one;
  // trusting more hops would let clients spoof their IP via the header. Local
  // mode has no proxy in front, so set TRUST_PROXY=false there — otherwise an
  // unproxied client could spoof its rate-limit IP via the header itself.
  app.set("trust proxy", process.env.TRUST_PROXY === "false" ? false : 1);

  const allowedOrigins = getAllowedOrigins();
  // Local/LAN use has no fixed origin to configure ahead of time — a viewer
  // might reach this server as localhost, a LAN IP, or a hostname, none of
  // which are known at startup. Accept any origin unless ALLOWED_ORIGIN was
  // set explicitly (which still takes priority even in local mode).
  const corsOrigin: cors.CorsOptions["origin"] =
    !allowedOrigins.length && isLocalMode
      ? true
      : (origin, callback) => {
          // No Origin header => same-origin / non-browser client (curl, server-to-server).
          if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
          callback(new Error("Not allowed by CORS"));
        };

  // Helmet for sensible security headers. The CSP allows the YouTube/Vimeo embed
  // SDKs and their iframes, the Supabase API/storage, and websocket connections.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: buildCspDirectives() },
      crossOriginEmbedderPolicy: false,
      // YouTube (esp. the JS API / nocookie player) validates the embedding
      // origin via the Referer header. Helmet's default `no-referrer` strips it,
      // which triggers YouTube playback error 153. Send the origin cross-site.
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    })
  );
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());

  // Liveness probe for uptime monitoring (Uptime Kuma). Outside /api so it's
  // not rate-limited, and intentionally cheap — it doesn't touch the DB.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // Live agent discovery docs (host-aware). Before static/SPA so they aren't
  // swallowed by index.html.
  registerAgentDocRoutes(app);

  // Throttle the JSON API to blunt brute-force (passphrase auth) and abuse.
  // Generous enough not to interfere with normal presenter/viewer flows.
  const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
  app.use("/api", apiLimiter);
  app.use("/mcp", apiLimiter);

  registerSessionRoutes(app, { supabase, io, socketState });
  registerNewsletterRoutes(app, supabase);
  registerCheckRoute(app);
  registerMcpRoutes(app, supabase);

  // Unknown API paths must 404 as JSON — falling through to the SPA catch-all
  // returns index.html with a 200, which masks client bugs as parse errors.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Same for /.well-known: agent discovery scanners probe many protocols
  // (A2A, ACP, UCP, …) we don't implement; index.html with a 200 reads as a
  // corrupt discovery document, a 404 reads as "not supported".
  app.use("/.well-known", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // --- Serve client in production ---

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.join(__dirname, "../client/dist");

  // JSON schemas for the sidecar format — served at /schema/*.json
  app.use("/schema", express.static(path.join(__dirname, "../../schema"), { index: false }));

  // Local mode's blob store (server/local/blobStore.ts) writes PDFs here and
  // hands back relative /files/... URLs. In Supabase mode this directory
  // never exists, so requests just fall through to the catch-all below.
  app.use("/files", express.static(localBlobsDir(), { index: false }));

  // index: false so "/" falls through to the catch-all below and gets its
  // canonical/og:url tags like every other route.
  app.use(express.static(clientDist, { index: false }));

  // Pages with a markdown mirror advertise it via rel="alternate".
  const MD_MIRRORS: Record<string, string> = {
    "/": "/index.md",
    "/about": "/about.md",
    "/check": "/check.md",
  };

  // Serve the SPA shell with a per-request canonical URL and og:url so every
  // route carries correct metadata without the client rendering it.
  let indexHtml: string | undefined;
  app.get("*path", (req, res, next) => {
    try {
      indexHtml ??= fs.readFileSync(path.join(clientDist, "index.html"), "utf8");
    } catch (err) {
      return next(err);
    }
    // A markdown path reaching the SPA catch-all means the mirror doesn't
    // exist; the HTML shell with a 200 would read as a broken mirror.
    if (req.path.endsWith(".md")) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const base = baseUrl(req);
    const url = `${base}${req.path === "/" ? "/" : req.path}`.replace(
      /[<>"&]/g,
      (c) => ({ "<": "%3C", ">": "%3E", '"': "%22", "&": "&amp;" })[c] as string
    );
    let tags = `<link rel="canonical" href="${url}" />\n  <meta property="og:url" content="${url}" />`;
    const mirror = MD_MIRRORS[req.path];
    if (mirror) tags += `\n  <link rel="alternate" type="text/markdown" href="${base}${mirror}" />`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(indexHtml.replace("</head>", `${tags}\n</head>`));
  });

  // Report unhandled route errors to Sentry. No-op when Sentry isn't
  // initialized (no DSN), and must come after all routes.
  Sentry.setupExpressErrorHandler(app);

  return app;
}
