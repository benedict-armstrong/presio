import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeEqual } from "../auth.js";
import { HistoryError, MAX_BLOB_BYTES, SHA256_RE, type HistoryStore } from "../history.js";

// Blobs for plugin histories (presio.history): content-addressed bytes too big
// for a plugin message — snapshots, images. They travel over HTTP, not the
// session's socket, so a big one never holds up slide changes or the laser.
//
// The controller uploads (its token, like every presenter-side write); anyone
// with the session's code may download, as they may its PDF. A blob's URL is
// its hash, so it never changes and caches forever.

const SESSION_ID_RE = /^[A-Z0-9]{6}$/;

export function registerHistoryRoutes(app: express.Express, { supabase, history }: { supabase: SupabaseClient; history: HistoryStore }) {
  app.put(
    "/api/sessions/:id/blobs/:sha",
    express.raw({ type: () => true, limit: MAX_BLOB_BYTES }),
    async (req, res) => {
      const { id, sha } = req.params;
      if (!SESSION_ID_RE.test(id) || !SHA256_RE.test(sha)) {
        res.status(400).json({ error: "Bad blob address" });
        return;
      }
      const { data } = await supabase.from("sessions").select("controller_token").eq("id", id).neq("status", "expired").single();
      if (!data) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (!safeEqual(req.get("x-controller-token") || "", data.controller_token)) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        await history.putBlob(id, sha, body);
        res.json({ ok: true });
      } catch (err) {
        if (err instanceof HistoryError) {
          res.status(422).json({ error: err.message });
          return;
        }
        console.warn("Blob upload failed:", err);
        res.status(500).json({ error: "Couldn't store the blob" });
      }
    }
  );

  app.get("/api/sessions/:id/blobs/:sha", async (req, res) => {
    const { id, sha } = req.params;
    if (!SESSION_ID_RE.test(id) || !SHA256_RE.test(sha)) {
      res.status(400).json({ error: "Bad blob address" });
      return;
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await history.getBlob(id, sha);
    } catch (err) {
      console.warn("Blob download failed:", err);
      res.status(500).json({ error: "Couldn't read the blob" });
      return;
    }
    if (!bytes) {
      // Maybe not uploaded yet: say so without letting anything cache it.
      res.setHeader("Cache-Control", "no-store");
      res.status(404).json({ error: "No such blob" });
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(Buffer.from(bytes));
  });
}
