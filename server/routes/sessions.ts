import type express from "express";
import multer from "multer";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nanoid, customAlphabet } from "nanoid";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { isValidHttpsUrl } from "../validation.js";
import { getBearerToken, resolveOptionalUserId, requireUser, safeEqual } from "../auth.js";
import { clearSessionState, type SocketState } from "../socket.js";

export interface RouteDeps {
  supabase: SupabaseClient;
  io: Server;
  socketState?: SocketState;
}

const generateSessionId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const generatePassphrase = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);

// How many synced presentations a single user may have live at once. Sessions
// expire after 24h (and are marked 'expired' on end), so this caps concurrent —
// not lifetime — presentations.
export const MAX_CONCURRENT_PRESENTATIONS = 3;

export function registerSessionRoutes(app: express.Express, { supabase, io, socketState }: RouteDeps) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  // Insert a session row, retrying with a fresh code on collision. Expired
  // rows are retained indefinitely, so the 6-char code space slowly fills and
  // a collision must be a retry, not a 500.
  async function insertSession(row: Record<string, unknown>): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = generateSessionId();
      const { error } = await supabase.from("sessions").insert({ ...row, id });
      if (!error) return id;
      if (error.code !== "23505") {
        console.error("Failed to create session:", error);
        return null;
      }
    }
    console.error("Failed to create session: code collision after 3 attempts");
    return null;
  }

  // Reserve a session code for a presentation kept local to the browser. No PDF
  // is uploaded — the bytes stay in the client's IndexedDB. We only record the
  // code so it is unique/trackable (and claimable once the user logs in).
  app.post("/api/sessions/local", async (req, res) => {
    const filename = typeof req.body.filename === "string" ? req.body.filename : "";
    const totalSlides = parseInt(req.body.total_slides, 10);
    if (!filename || !Number.isFinite(totalSlides) || totalSlides < 1) {
      res.status(400).json({ error: "filename and total_slides are required" });
      return;
    }

    // If the creator is logged in, attach them as the owner up front so the
    // presentation is theirs even while it stays local. Anonymous creators are
    // still allowed — the token is optional, and an invalid one is simply ignored.
    const userId = await resolveOptionalUserId(supabase, req);

    const id = await insertSession({
      pdf_path: "",
      filename,
      total_slides: totalSlides,
      controller_token: nanoid(24),
      passphrase: generatePassphrase(),
      local: true,
      user_id: userId,
    });

    if (!id) {
      res.status(500).json({ error: "Failed to create session" });
      return;
    }

    res.json({ id });
  });

  // Reserve a session whose PDF is hosted externally ("bring your own storage").
  // The client has already loaded the PDF from `url` to derive total_slides, so we
  // store only the URL — no bytes are uploaded and there is no storage cost, which
  // is why this needs neither login nor the synced-presentation cap. Viewers fetch
  // the PDF directly from the URL, so it must be a public, CORS-friendly host.
  app.post("/api/sessions/external", async (req, res) => {
    const url = req.body.url;
    const filename = typeof req.body.filename === "string" ? req.body.filename : "";
    const totalSlides = parseInt(req.body.total_slides, 10);
    if (!isValidHttpsUrl(url)) {
      res.status(400).json({ error: "A valid https PDF URL is required" });
      return;
    }
    if (!filename || !Number.isFinite(totalSlides) || totalSlides < 1) {
      res.status(400).json({ error: "filename and total_slides are required" });
      return;
    }

    const userId = await resolveOptionalUserId(supabase, req);

    const controllerToken = nanoid(24);
    const passphrase = generatePassphrase();
    const id = await insertSession({
      pdf_path: "",
      pdf_url: url,
      filename,
      total_slides: totalSlides,
      controller_token: controllerToken,
      passphrase,
      local: false,
      user_id: userId,
    });

    if (!id) {
      res.status(500).json({ error: "Failed to create session" });
      return;
    }

    res.json({ id, controllerToken, passphrase });
  });

  // Turn a local session into a synced one: upload the PDF (kept in the client's
  // IndexedDB until now) and attach the authenticated owner. Requires a valid
  // Supabase access token.
  app.post("/api/sessions/:id/claim", upload.single("pdf"), async (req, res) => {
    try {
      const token = getBearerToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData.user) {
        res.status(401).json({ error: "Invalid session" });
        return;
      }

      // Cap how many synced presentations a user can have live at once. Only count
      // ones that are still active and not past expiry; sessions marked 'expired'
      // (ended early or aged out) don't count.
      // Exclude the session being claimed so a re-claim of the same code is a no-op.
      const { count, error: countError } = await supabase
        .from("sessions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userData.user.id)
        .eq("local", false)
        .neq("id", req.params.id)
        .neq("status", "expired")
        .gt("expires_at", new Date().toISOString());
      if (countError) {
        res.status(500).json({ error: "Failed to check presentation limit" });
        return;
      }
      if ((count ?? 0) >= MAX_CONCURRENT_PRESENTATIONS) {
        res.status(403).json({
          error: `You can have at most ${MAX_CONCURRENT_PRESENTATIONS} synced presentations at once. End one before syncing another.`,
        });
        return;
      }

      const file = req.file;
      if (!file || file.mimetype !== "application/pdf") {
        res.status(400).json({ error: "A PDF file is required" });
        return;
      }

      const { data: row, error: rowError } = await supabase
        .from("sessions")
        .select("id, local, controller_token, passphrase")
        .eq("id", req.params.id)
        .single();
      if (rowError || !row) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (!row.local) {
        res.status(409).json({ error: "Presentation is already synced" });
        return;
      }

      const pdfPath = `${row.id}.pdf`;
      const doc = await getDocument({ data: new Uint8Array(file.buffer) }).promise;
      const totalSlides = doc.numPages;
      doc.destroy();

      const { error: uploadError } = await supabase.storage
        .from("presentations")
        .upload(pdfPath, file.buffer, { contentType: "application/pdf", upsert: true });
      if (uploadError) {
        res.status(500).json({ error: "Failed to upload PDF" });
        return;
      }

      // Preserve the presenter's current position if provided (a local session's
      // slide changes were never persisted server-side).
      const currentSlide = parseInt(req.body.current_slide, 10);
      const update: Record<string, unknown> = {
        local: false,
        pdf_path: pdfPath,
        total_slides: totalSlides,
        user_id: userData.user.id,
      };
      if (Number.isFinite(currentSlide) && currentSlide >= 1) update.current_slide = currentSlide;

      const { error: updateError } = await supabase
        .from("sessions")
        .update(update)
        .eq("id", row.id);
      if (updateError) {
        res.status(500).json({ error: "Failed to update session" });
        return;
      }

      res.json({
        id: row.id,
        totalSlides,
        controllerToken: row.controller_token,
        passphrase: row.passphrase,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Replace a synced presentation's PDF — used to persist edited speaker notes,
  // which are written back into the PDF as embedded-file sidecars by the client.
  // Only the authenticated owner may overwrite the stored file.
  app.post("/api/sessions/:id/pdf", upload.single("pdf"), async (req, res) => {
    try {
      const user = await requireUser(supabase, req);
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const file = req.file;
      if (!file || file.mimetype !== "application/pdf") {
        res.status(400).json({ error: "A PDF file is required" });
        return;
      }

      const { data: row, error: rowError } = await supabase
        .from("sessions")
        .select("id, local, pdf_path, user_id")
        .eq("id", req.params.id)
        .single();
      if (rowError || !row) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (row.user_id !== user.id) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }
      if (row.local || !row.pdf_path) {
        res.status(400).json({ error: "This presentation's PDF is not hosted on the server" });
        return;
      }

      const { error: uploadError } = await supabase.storage
        .from("presentations")
        .upload(row.pdf_path, file.buffer, { contentType: "application/pdf", upsert: true });
      if (uploadError) {
        res.status(500).json({ error: "Failed to save PDF" });
        return;
      }

      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/sessions/:id", async (req, res) => {
    const { data, error } = await supabase
      .from("sessions")
      .select("id, pdf_path, pdf_url, filename, total_slides, current_slide, local")
      .eq("id", req.params.id)
      .neq("status", "expired")
      .single();

    if (error || !data) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // External sessions store the URL directly; Supabase-hosted ones derive a
    // public URL from the object path; local sessions have neither.
    const pdfUrl = data.pdf_url
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
    });
  });

  app.post("/api/sessions/:id/auth", async (req, res) => {
    const { passphrase } = req.body;
    if (!passphrase) {
      res.status(400).json({ error: "Passphrase is required" });
      return;
    }

    const { data, error } = await supabase
      .from("sessions")
      .select("controller_token, passphrase")
      .eq("id", req.params.id)
      .neq("status", "expired")
      .single();

    if (error || !data) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (typeof passphrase !== "string" || !safeEqual(data.passphrase, passphrase)) {
      res.status(401).json({ error: "Invalid passphrase" });
      return;
    }

    res.json({ controllerToken: data.controller_token, passphrase: data.passphrase });
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    const { data, error } = await supabase
      .from("sessions")
      .select("id, pdf_path, controller_token")
      .eq("id", req.params.id)
      .single();

    if (error || !data) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Only the controller (who holds the token) may end a presentation.
    const token = req.get("x-controller-token") || "";
    if (!safeEqual(token, data.controller_token)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }

    if (data.pdf_path) {
      await supabase.storage.from("presentations").remove([data.pdf_path]);
    }
    // Mark the session expired rather than deleting it — the row is retained.
    await supabase.from("sessions").update({ status: "expired" }).eq("id", data.id);

    // Disconnect all sockets in this session's room
    const sockets = await io.in(data.id).fetchSockets();
    for (const s of sockets) {
      s.emit("session_ended");
      s.disconnect(true);
    }
    if (socketState) clearSessionState(socketState, data.id);

    res.json({ ok: true });
  });
}
