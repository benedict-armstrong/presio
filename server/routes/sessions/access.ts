// Getting into a session and out of it: what a viewer loads, the shared-control
// passphrase, an external-URL session, and ending one.

import type express from "express";
import { nanoid } from "nanoid";
import type { AppDeps } from "../../app.js";
import { resolveOptionalUserId, safeEqual } from "../../auth.js";
import { isValidHttpsUrl, isValidTotalSlides } from "../../validation.js";
import { authorizeController, loadSession } from "../../lib/sessionAccess.js";
import { endSessions } from "../../lib/sessionLifecycle.js";
import { generatePassphrase, insertSession, ownedExpiry } from "../../lib/sessionRows.js";
import { normalizeDeckName } from "../../lib/upload.js";

export function registerAccessRoutes(app: express.Express, { supabase, io, socketState }: AppDeps) {
  // Mint — or hand back — the shared-control passphrase. It is created on first
  // need rather than at session creation: most decks are never co-presented,
  // and a deck that was never shared has no row to hold one.
  app.post("/api/sessions/:id/passphrase", async (req, res) => {
    const row = await loadSession(supabase, req.params.id, "id, controller_token, passphrase, user_id");
    if (!row) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Same authorization as the other presenter-side writes: the controller
    // token this browser holds, or (hosted only) the logged-in owner.
    if (!(await authorizeController(supabase, req, row, { allowOwner: true }))) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }

    if (row.passphrase) {
      res.json({ passphrase: row.passphrase });
      return;
    }

    const passphrase = generatePassphrase();
    const { error: updateError } = await supabase
      .from("sessions")
      .update({ passphrase })
      .eq("id", row.id);
    if (updateError) {
      res.status(500).json({ error: "Failed to create passphrase" });
      return;
    }
    res.json({ passphrase });
  });

  // Reserve a session whose PDF is hosted externally ("bring your own storage").
  // The client has already loaded the PDF from `url` to derive total_slides, so we
  // store only the URL — no bytes are uploaded and there is no storage cost, which
  // is why this needs neither login nor the synced-presentation cap. Viewers fetch
  // the PDF directly from the URL, so it must be a public, CORS-friendly host.
  app.post("/api/sessions/external", async (req, res) => {
    const url = req.body.url;
    const filename = normalizeDeckName(req.body.filename);
    const totalSlides = parseInt(req.body.total_slides, 10);
    if (!isValidHttpsUrl(url)) {
      res.status(400).json({ error: "A valid https PDF URL is required" });
      return;
    }
    if (!filename || !isValidTotalSlides(totalSlides)) {
      res.status(400).json({ error: "filename and total_slides are required" });
      return;
    }

    const userId = await resolveOptionalUserId(supabase, req);

    const controllerToken = nanoid(24);
    const passphrase = generatePassphrase();
    const id = await insertSession(supabase, {
      pdf_path: "",
      pdf_url: url,
      filename,
      total_slides: totalSlides,
      controller_token: controllerToken,
      passphrase,
      local: false,
      user_id: userId,
      ...(userId ? { expires_at: ownedExpiry() } : {}),
    });

    if (!id) {
      res.status(500).json({ error: "Failed to create session" });
      return;
    }

    res.json({ id, controllerToken, passphrase });
  });

  app.get("/api/sessions/:id", async (req, res) => {
    const data = await loadSession(supabase, req.params.id, "id, pdf_path, pdf_url, filename, total_slides, current_slide, local");
    if (!data) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // External sessions store the URL directly; Supabase-hosted ones derive a
    // public URL from the object path. Local sessions (including staged handoffs)
    // must never expose pdfUrl — the PDF only belongs in the presenter's browser.
    const pdfUrl = data.local
      ? ""
      : data.pdf_url
        ? data.pdf_url
        : data.pdf_path
          ? supabase.storage.from("presentations").getPublicUrl(data.pdf_path).data.publicUrl
          : "";

    // Return only fields the client needs; never leak controller_token,
    // passphrase, owner user_id, or internal timestamps.
    res.json({
      id: data.id,
      filename: data.filename,
      total_slides: data.total_slides,
      current_slide: data.current_slide,
      local: data.local,
      pdfUrl,
      // Whether pdfUrl points at someone else's host rather than our storage.
      // The client needs this to re-fetch a changed deck correctly: our own
      // object URLs take a cache-busting query parameter, but an external one
      // may be presigned, where an extra parameter invalidates the signature.
      external: !!data.pdf_url,
    });
  });

  app.post("/api/sessions/:id/auth", async (req, res) => {
    const { passphrase } = req.body;
    if (!passphrase) {
      res.status(400).json({ error: "Passphrase is required" });
      return;
    }

    const data = await loadSession(supabase, req.params.id, "controller_token, passphrase");
    if (!data) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // An unminted passphrase (created on demand — see the route above) must
    // never match anything, however the caller shapes the request.
    if (!data.passphrase || typeof passphrase !== "string" || !safeEqual(data.passphrase, passphrase)) {
      res.status(401).json({ error: "Invalid passphrase" });
      return;
    }

    res.json({ controllerToken: data.controller_token, passphrase: data.passphrase });
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    const data = await loadSession(supabase, req.params.id, "id, pdf_path, controller_token");
    if (!data) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Only the controller (who holds the token) may end a presentation.
    if (!(await authorizeController(supabase, req, data))) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }

    await endSessions(supabase, io, socketState, [{ id: data.id, pdf_path: data.pdf_path }]);

    res.json({ ok: true });
  });
}
