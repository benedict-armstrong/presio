import type express from "express";
import multer from "multer";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { isValidHttpsUrl, isValidTotalSlides, MAX_TOTAL_SLIDES } from "../validation.js";
import { getBearerToken, requireUser, resolveOptionalUserId, safeEqual } from "../auth.js";
import { isLocalMode } from "../local/mode.js";
import { clearSessionState, type SocketState } from "../socket.js";
import { baseUrl } from "../lib/baseUrl.js";
import { createPresentHandoff, handoffTokenFrom, updatePresentDeck } from "../lib/presentHandoff.js";
import { generatePassphrase, insertSession, ownedExpiry } from "../lib/sessionRows.js";

export interface RouteDeps {
  supabase: SupabaseClient;
  io: Server;
  socketState?: SocketState;
}

// How many synced presentations a single user may have live at once. Sessions
// expire (and are marked 'expired' on end), so this caps concurrent —
// not lifetime — presentations.
export const MAX_CONCURRENT_PRESENTATIONS = 3;

/**
 * Read a multipart text field that may legitimately appear at most once.
 * Multer hands a repeated field back as an array, which a bare
 * `typeof x === "string"` check silently reads as "absent" — on /api/present
 * that turned a duplicated `session_id` into a brand new presentation, burning
 * a concurrent slot and handing back a fresh link. `null` means "sent more than
 * once" so callers can reject instead of guessing which copy was meant.
 */
function singleField(value: unknown): string | null {
  if (value === undefined) return "";
  return typeof value === "string" ? value : null;
}

export function registerSessionRoutes(app: express.Express, { supabase, io, socketState }: RouteDeps) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  // Multer/busboy failures are otherwise unhandled: they carry no `status`, so
  // they fall past the body-parser handler in app.ts to Express's default one,
  // which dumps a stack to stderr and answers with an HTML 500 the client can't
  // parse. The common case is a body that ends before its closing boundary
  // ("Unexpected end of form") — the browser aborted mid-upload, e.g. because
  // the Blob it was streaming couldn't be read — which is the uploader's
  // problem to retry, not a server fault. Answer 400 with a usable message.
  const uploadField = (field: string): express.RequestHandler => {
    const handler = upload.single(field);
    return (req, res, next) =>
      handler(req, res, (err: unknown) => {
        if (!err) return next();
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") {
          res.status(413).json({ error: "PDF exceeds the 50MB limit" });
          return;
        }
        console.error(`Upload failed for ${req.method} ${req.path}:`, err);
        res.status(400).json({
          error: "The upload didn't complete. Check your connection and try again.",
        });
      });
  };

  /**
   * POST /api/present — upload a PDF; get a URL that opens a local presentation
   * (skips share). The PDF is staged briefly, then moved into the browser.
   *
   *   curl -s -F file=@deck.pdf https://presio.xyz/api/present
   *   # open the returned url
   *
   * Update mode: pass `session_id` (multipart field) plus its controller token
   * (`controller_token` field or `x-controller-token` header) to replace an
   * existing presentation's deck instead of creating one — the response keeps
   * the same id/link and no extra concurrent slot is used.
   */
  app.post("/api/present", uploadField("file"), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Missing "file" field (multipart/form-data)' });
        return;
      }
      if (file.mimetype !== "application/pdf" && !file.originalname.toLowerCase().endsWith(".pdf")) {
        res.status(400).json({ error: "File must be a PDF" });
        return;
      }

      const rawSessionId = singleField(req.body.session_id);
      const rawToken = singleField(req.body.controller_token);
      if (rawSessionId === null || rawToken === null) {
        res.status(400).json({
          error: 'Send "session_id" and "controller_token" at most once each',
        });
        return;
      }

      const sessionId = rawSessionId.trim();
      if (sessionId) {
        // The token is compared byte-for-byte, so it is never trimmed.
        const token = rawToken || req.get("x-controller-token") || "";
        if (!token) {
          // Reject rather than falling back to create: silently minting a new
          // presentation would hand the agent a fresh link and consume a slot.
          res.status(401).json({
            error: 'A controller token is required to update an existing presentation ("controller_token" field or "x-controller-token" header)',
          });
          return;
        }
        const result = await updatePresentDeck(supabase, {
          sessionId,
          token,
          buffer: file.buffer,
          originalName: file.originalname,
          baseUrl: baseUrl(req),
          io,
          socketState,
        });
        if (!result.ok) {
          res.status(result.status).json({ error: result.error });
          return;
        }
        res.json({
          id: result.id,
          url: result.url,
          filename: result.filename,
          totalSlides: result.totalSlides,
          next: result.next,
          updated: true,
        });
        return;
      }

      const userId = await resolveOptionalUserId(supabase, req);
      const result = await createPresentHandoff(supabase, {
        buffer: file.buffer,
        originalName: file.originalname,
        userId,
        baseUrl: baseUrl(req),
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({
        id: result.id,
        url: result.url,
        filename: result.filename,
        totalSlides: result.totalSlides,
        next: result.next,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /api/sessions/mine — the signed-in account's live synced presentations,
   * newest first. The home screen asks this on any device the user signs in on:
   * local decks are device-bound IndexedDB, but synced ones belong to the
   * account, so a new device needs this list (plus each deck's controller
   * token — the owner is entitled to it, and without it the device could never
   * open the controller). Local handoff rows are excluded: their PDF only ever
   * belongs in the creating browser.
   */
  if (!isLocalMode) {
    app.get("/api/sessions/mine", async (req, res) => {
      try {
        const user = await requireUser(supabase, req);
        if (!user) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        // The filter comes from the verified token only — a client-supplied id
        // is never trusted, so no account can see another's rows.
        const { data, error } = await supabase
          .from("sessions")
          .select("id, filename, total_slides, created_at, expires_at, controller_token")
          .eq("user_id", user.id)
          .eq("local", false)
          .neq("status", "expired")
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false });
        if (error) {
          res.status(500).json({ error: "Failed to list presentations" });
          return;
        }
        // Whitelist the response fields; only controller_token is renamed.
        res.json(
          (data ?? []).map((row) => ({
            id: row.id,
            filename: row.filename,
            total_slides: row.total_slides,
            created_at: row.created_at,
            expires_at: row.expires_at,
            controllerToken: row.controller_token,
          }))
        );
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal server error" });
      }
    });
  }

  // Download a staged handoff PDF (token required). Does not delete yet.
  app.get("/api/sessions/:id/handoff", async (req, res) => {
    try {
      const token = handoffTokenFrom(req);
      const { data, error } = await supabase
        .from("sessions")
        .select("id, local, pdf_path, controller_token, filename, total_slides")
        .eq("id", req.params.id)
        .neq("status", "expired")
        .single();
      if (error || !data) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (!safeEqual(token, data.controller_token)) {
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
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(data.filename)}.pdf"`);
      res.setHeader("X-Filename", data.filename);
      res.setHeader("X-Total-Slides", String(data.total_slides));
      res.send(buf);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // After the browser has stored the PDF in IndexedDB, clear the server copy.
  app.post("/api/sessions/:id/handoff/complete", async (req, res) => {
    try {
      const token = handoffTokenFrom(req);
      const { data, error } = await supabase
        .from("sessions")
        .select("id, local, pdf_path, controller_token")
        .eq("id", req.params.id)
        .neq("status", "expired")
        .single();
      if (error || !data) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (!safeEqual(token, data.controller_token)) {
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
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Reserve a session code for a presentation kept local to the browser. No PDF
  // is uploaded — the bytes stay in the client's IndexedDB. We only record the
  // code so it is unique/trackable (and claimable once the user logs in).
  app.post("/api/sessions/local", async (req, res) => {
    const filename = typeof req.body.filename === "string" ? req.body.filename : "";
    const totalSlides = parseInt(req.body.total_slides, 10);
    if (!filename || !isValidTotalSlides(totalSlides)) {
      res.status(400).json({ error: "filename and total_slides are required" });
      return;
    }

    // If the creator is logged in, attach them as the owner up front so the
    // presentation is theirs even while it stays local. Anonymous creators are
    // still allowed — the token is optional, and an invalid one is simply ignored.
    const userId = await resolveOptionalUserId(supabase, req);

    const controllerToken = nanoid(24);
    const passphrase = generatePassphrase();
    const id = await insertSession(supabase, {
      pdf_path: "",
      filename,
      total_slides: totalSlides,
      controller_token: controllerToken,
      passphrase,
      local: true,
      user_id: userId,
      ...(userId ? { expires_at: ownedExpiry() } : {}),
    });

    if (!id) {
      res.status(500).json({ error: "Failed to create session" });
      return;
    }

    // Local/offline mode has no login, so the creator proves they're the
    // controller by holding this token (the browser stores it and sends it to
    // authorize claim / notes-resave). Hosted mode withholds it on purpose —
    // there, control is tied to the logged-in owner, and the token is only
    // handed back on a claim.
    res.json(isLocalMode ? { id, controllerToken, passphrase } : { id });
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

  // Turn a local session into a synced one: upload the PDF (kept in the client's
  // IndexedDB until now) and attach the authenticated owner. Requires a valid
  // Supabase access token.
  app.post("/api/sessions/:id/claim", uploadField("pdf"), async (req, res) => {
    try {
      // Local/offline mode has no auth provider, so a synced (server-hosted)
      // presentation can't have a logged-in owner. Authorize the claim with the
      // controller token the presenter's browser already holds (same model as
      // the delete route) and skip the per-user quota, which only exists to cap
      // storage on the shared hosted service.
      let userId: string | null;
      if (isLocalMode) {
        const { data: row } = await supabase
          .from("sessions")
          .select("controller_token")
          .eq("id", req.params.id)
          .single();
        const controllerToken = req.get("x-controller-token") || "";
        if (!row || !safeEqual(controllerToken, row.controller_token)) {
          res.status(403).json({ error: "Not authorized" });
          return;
        }
        userId = null;
      } else {
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
        userId = userData.user.id;

        // Cap how many synced presentations a user can have live at once. Only count
        // ones that are still active and not past expiry; sessions marked 'expired'
        // (ended early or aged out) don't count.
        // Exclude the session being claimed so a re-claim of the same code is a no-op.
        const { count, error: countError } = await supabase
          .from("sessions")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
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
      if (!isValidTotalSlides(totalSlides)) {
        res.status(400).json({ error: `PDF exceeds the ${MAX_TOTAL_SLIDES}-page limit` });
        return;
      }

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
        user_id: userId,
        // A shared deck should outlive the default 24h anonymous expiry so it
        // doesn't vanish mid-session; owned/hosted claims get the same TTL.
        expires_at: ownedExpiry(),
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

      // The pre-claim count check races with concurrent claims (check-then-act
      // isn't atomic). Re-count now that this claim is visible; if parallel
      // claims overshot the cap, roll this one back. Fail-closed: in the rare
      // tie both claims revert and the user simply retries one. No cap in local
      // mode, so nothing to reconcile there.
      if (userId) {
        const { count: afterCount } = await supabase
          .from("sessions")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("local", false)
          .neq("status", "expired")
          .gt("expires_at", new Date().toISOString());
        if ((afterCount ?? 0) > MAX_CONCURRENT_PRESENTATIONS) {
          await supabase.storage.from("presentations").remove([pdfPath]);
          await supabase
            .from("sessions")
            .update({ local: true, pdf_path: "" })
            .eq("id", row.id);
          res.status(403).json({
            error: `You can have at most ${MAX_CONCURRENT_PRESENTATIONS} synced presentations at once. End one before syncing another.`,
          });
          return;
        }
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

  // Replace a synced presentation's PDF in place, keeping its id, code,
  // controller token and passphrase. Two callers:
  //
  //   - Notes editing re-uploads the same document with an embedded sidecar
  //     written by the client. No filename field → nothing announced.
  //   - A deck replacement sends `filename`. The row's filename/slide count
  //     follow the new document, the current slide is clamped into range,
  //     drawings are dropped (they are keyed by slide number), and everyone
  //     in the room gets `deck_updated` so they reload the new bytes live.
  app.post("/api/sessions/:id/pdf", uploadField("pdf"), async (req, res) => {
    try {
      // Authorized either by the controller token — the same model as ending a
      // session, so an anonymous presenter (and later agents/CLIs) can rewrite
      // the deck they control — or, in hosted mode, by the logged-in owner.
      const user = isLocalMode ? null : await resolveOptionalUserId(supabase, req);

      const file = req.file;
      if (!file || file.mimetype !== "application/pdf") {
        res.status(400).json({ error: "A PDF file is required" });
        return;
      }

      const { data: row, error: rowError } = await supabase
        .from("sessions")
        .select("id, local, pdf_path, pdf_url, user_id, controller_token, filename, current_slide")
        .eq("id", req.params.id)
        .single();
      if (rowError || !row) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const authorized =
        safeEqual(req.get("x-controller-token") || "", row.controller_token) ||
        (!isLocalMode && !!user && row.user_id === user);
      if (!authorized) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }
      if (row.local || !row.pdf_path) {
        res.status(400).json({ error: "This presentation's PDF is not hosted on the server" });
        return;
      }

      let totalSlides: number;
      try {
        const doc = await getDocument({ data: new Uint8Array(file.buffer) }).promise;
        totalSlides = doc.numPages;
        doc.destroy();
      } catch {
        res.status(400).json({ error: "The file could not be read as a PDF" });
        return;
      }
      if (!isValidTotalSlides(totalSlides)) {
        res.status(400).json({ error: `PDF exceeds the ${MAX_TOTAL_SLIDES}-page limit` });
        return;
      }

      const rawName = typeof req.body.filename === "string" ? req.body.filename.trim() : "";
      const newFilename = rawName.replace(/\.pdf$/i, "");
      const clampedSlide = Math.min(Math.max(row.current_slide ?? 1, 1), totalSlides);

      const { error: uploadError } = await supabase.storage
        .from("presentations")
        .upload(row.pdf_path, file.buffer, { contentType: "application/pdf", upsert: true });
      if (uploadError) {
        res.status(500).json({ error: "Failed to save PDF" });
        return;
      }

      const update: Record<string, unknown> = {
        total_slides: totalSlides,
        current_slide: clampedSlide,
      };
      if (newFilename) update.filename = newFilename;
      const { error: updateError } = await supabase
        .from("sessions")
        .update(update)
        .eq("id", row.id);
      if (updateError) {
        res.status(500).json({ error: "Failed to update session" });
        return;
      }

      // A real replacement announces itself; a notes re-save (no filename)
      // stays silent so viewers aren't forced to re-download identical slides.
      if (newFilename) {
        socketState?.annotations.delete(String(req.params.id));
        io.to(req.params.id).emit("deck_updated", { filename: newFilename, totalSlides });
      }

      res.json({ ok: true, totalSlides, filename: newFilename || row.filename });
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
