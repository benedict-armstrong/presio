import express from "express";
import * as Sentry from "@sentry/node";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAllowedOrigins, buildCspDirectives } from "./security.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerNewsletterRoutes } from "./routes/newsletter.js";
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
  // trusting more hops would let clients spoof their IP via the header.
  app.set("trust proxy", 1);

  const allowedOrigins = getAllowedOrigins();
  const corsOrigin: cors.CorsOptions["origin"] = (origin, callback) => {
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

  // Throttle the JSON API to blunt brute-force (passphrase auth) and abuse.
  // Generous enough not to interfere with normal presenter/viewer flows.
  const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
  app.use("/api", apiLimiter);

  registerSessionRoutes(app, { supabase, io, socketState });
  registerNewsletterRoutes(app, supabase);

  // --- Serve client in production ---

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.join(__dirname, "../client/dist");

  app.use(express.static(clientDist));
  app.get("*path", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });

  // Report unhandled route errors to Sentry. No-op when Sentry isn't
  // initialized (no DSN), and must come after all routes.
  Sentry.setupExpressErrorHandler(app);

  return app;
}
