// The browser side of POST /api/present's handoff: /start/:id fetches the
// staged PDF into IndexedDB, then clears the server copy.

import type express from "express";
import type { AppDeps } from "../../app.js";
import { handoffTokenFrom } from "../../lib/presentHandoff.js";
import { authorizeController, loadSession } from "../../lib/sessionAccess.js";

export function registerHandoffRoutes(app: express.Express, { supabase }: AppDeps) {
  // Download a staged handoff PDF (token required). Does not delete yet.
  app.get("/api/sessions/:id/handoff", async (req, res) => {
    const data = await loadSession(supabase, req.params.id, "id, local, pdf_path, controller_token, filename, total_slides");
    if (!data) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!(await authorizeController(supabase, req, data, { token: handoffTokenFrom(req) }))) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    if (!data.local || !data.pdf_path) {
      res.status(410).json({ error: "Handoff already completed or unavailable" });
      return;
    }

    const { data: blob, error: dlError } = await supabase.storage
      .from("presentations")
      .download(data.pdf_path);
    if (dlError || !blob) {
      res.status(404).json({ error: "PDF not found" });
      return;
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    res.setHeader("Content-Type", "application/pdf");
    // Header values must be Latin-1, so a CJK or emoji name would make Node
    // throw. Send it percent-encoded (Start.tsx decodes X-Filename), with an
    // ASCII fallback plus the RFC 6266 filename* form for downloads.
    const encoded = encodeURIComponent(data.filename).replace(
      /['()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
    const ascii = data.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encoded}.pdf`);
    res.setHeader("X-Filename", encoded);
    res.setHeader("X-Total-Slides", String(data.total_slides));
    res.send(buf);
  });

  // After the browser has stored the PDF in IndexedDB, clear the server copy.
  app.post("/api/sessions/:id/handoff/complete", async (req, res) => {
    const data = await loadSession(supabase, req.params.id, "id, local, pdf_path, controller_token");
    if (!data) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!(await authorizeController(supabase, req, data, { token: handoffTokenFrom(req) }))) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    if (!data.local) {
      res.status(409).json({ error: "Not a local handoff session" });
      return;
    }
    if (data.pdf_path) {
      await supabase.storage.from("presentations").remove([data.pdf_path]);
      await supabase.from("sessions").update({ pdf_path: "" }).eq("id", data.id);
    }
    res.json({ ok: true });
  });
}
