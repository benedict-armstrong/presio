import type express from "express";
import { detectLanAddress } from "../lib/lanAddress.js";

// GET /api/lan-address — "what should a QR code scanned by a phone point at?"
//
// Registered only for development and PRESIO_MODE=local. A hosted deployment is
// always reached on its real domain, so the answer would be useless there, and
// publishing the origin's internal addressing to anonymous callers is a needless
// disclosure. When the route isn't registered the request falls through to the
// /api JSON 404, which clients treat the same as "no answer" (see
// client/src/lib/joinUrl.ts).
export function registerLanAddressRoute(app: express.Express, { enabled }: { enabled: boolean }) {
  if (!enabled) return;
  app.get("/api/lan-address", async (_req, res) => {
    res.json(await detectLanAddress());
  });
}
