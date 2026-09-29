import type express from "express";
import { nanoid } from "nanoid";
import { countPages } from "../lib/pdfDoc.js";
import { DEFAULT_DECK_NAME, isPdfUpload, normalizeDeckName, singleField, uploadField } from "../lib/upload.js";
import { isValidHttpsUrl, isValidTotalSlides } from "../validation.js";
import { requireUser, resolveOptionalUserId, safeEqual } from "../auth.js";
import { isLocalMode } from "../local/mode.js";
import type { AppDeps } from "../app.js";
import { endSessions } from "../lib/sessionLifecycle.js";
import { announceDeckUpdate, clampSlide, replaceHostedDeck } from "../lib/hostedDeck.js";
import { baseUrl } from "../lib/baseUrl.js";
import { fetchRemotePdfMeta } from "../lib/remotePdf.js";
import { createPresentHandoff, handoffTokenFrom, updatePresentDeck } from "../lib/presentHandoff.js";
import { authorizeController, loadSession } from "../lib/sessionAccess.js";
import { generatePassphrase, insertSession, ownedExpiry } from "../lib/sessionRows.js";

// How many synced presentations a single user may have live at once. Sessions
// expire (and are marked 'expired' on end), so this caps concurrent —
// not lifetime — presentations.
export const MAX_CONCURRENT_PRESENTATIONS = 3;

export function registerSessionRoutes(app: express.Express, { supabase, io, socketState }: AppDeps) {
  /**
   * POST /api/present — upload a PDF; get a URL that opens a local presentation
   * (skips share). The PDF is staged briefly, then moved into the browser.
   *
   *   curl -s -F file=@deck.pdf https://presio.ch/api/present
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
      if (!isPdfUpload(file)) {
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
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // After the browser has stored the PDF in IndexedDB, clear the server copy.
  app.post("/api/sessions/:id/handoff/complete", async (req, res) => {
    try {
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
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * How many synced presentations this user has live right now. `exceptId`
   * leaves one row out, so a re-claim of the same code doesn't count itself.
   * Null means the count failed and the caller must not assume there's room.
   */
  async function liveSyncedCount(
    userId: string,
    exceptId?: string | string[]
  ): Promise<number | null> {
    const base = supabase
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("local", false);
    const scoped = exceptId ? base.neq("id", exceptId) : base;
    const { count, error } = await scoped
      .neq("status", "expired")
      .gt("expires_at", new Date().toISOString());
    return error ? null : (count ?? 0);
  }

  const capReached = () => ({
    error: `You can have at most ${MAX_CONCURRENT_PRESENTATIONS} synced presentations at once. End one before syncing another.`,
  });

  /**
   * Whether the user has room for one more synced presentation (a re-claim of
   * `exceptId` doesn't count itself). Answers the request when not.
   */
  async function ensureQuota(res: express.Response, userId: string, exceptId?: string): Promise<boolean> {
    const live = await liveSyncedCount(userId, exceptId);
    if (live === null) {
      res.status(500).json({ error: "Failed to check presentation limit" });
      return false;
    }
    if (live >= MAX_CONCURRENT_PRESENTATIONS) {
      res.status(403).json(capReached());
      return false;
    }
    return true;
  }

  /**
   * The quota check races with concurrent shares (check-then-act isn't
   * atomic). Re-count once the new synced row is visible; if parallel requests
   * overshot the cap, undo this one and answer 403. Fail-closed: in the rare
   * tie both revert and the user simply retries one. Returns whether it stands.
   */
  async function reconcileQuota(res: express.Response, userId: string, undo: () => Promise<void>): Promise<boolean> {
    const after = await liveSyncedCount(userId);
    if (after === null || after <= MAX_CONCURRENT_PRESENTATIONS) return true;
    await undo();
    res.status(403).json(capReached());
    return false;
  }

  // Share a presentation that until now existed only in the presenter's
  // browser: the PDF is uploaded and its session row is created here — which is
  // where the join code is minted, by insertSession's collision-retrying insert.
  // The client proposes no id and no code.
  //
  // This is the create-with-PDF counterpart of POST /api/sessions/:id/claim.
  // A deck imported in the browser has no row to claim (that's what lets the
  // import work with no connection at all); a deck staged by POST /api/present
  // does, keeps its code, and still goes through claim.
  app.post("/api/sessions", uploadField("pdf"), async (req, res) => {
    try {
      // Hosted mode ties a synced presentation to the logged-in owner and caps
      // how many they may have live. Local/offline mode has no accounts: the
      // controller token handed back below is the only credential there is.
      let userId: string | null = null;
      if (!isLocalMode) {
        const user = await requireUser(supabase, req);
        if (!user) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        userId = user.id;
        if (!(await ensureQuota(res, userId))) return;
      }

      const file = req.file;
      if (!isPdfUpload(file)) {
        res.status(400).json({ error: "A PDF file is required" });
        return;
      }

      const rawName = singleField(req.body.filename);
      if (rawName === null) {
        res.status(400).json({ error: "filename was sent more than once" });
        return;
      }
      const filename = normalizeDeckName(rawName) || DEFAULT_DECK_NAME;

      const pages = await countPages(file.buffer);
      if (!pages.ok) {
        res.status(pages.status).json({ error: pages.error });
        return;
      }
      const { totalSlides } = pages;

      // The row is inserted before the upload because the code it reserves is
      // also the object path. It starts as a local placeholder, so a failed
      // upload can never leave a synced row pointing at a PDF that isn't there.
      const controllerToken = nanoid(24);
      const id = await insertSession(supabase, {
        pdf_path: "",
        filename,
        total_slides: totalSlides,
        controller_token: controllerToken,
        // Minted on first need instead (POST /api/sessions/:id/passphrase):
        // most decks are never co-presented.
        passphrase: "",
        local: true,
        user_id: userId,
        // A shared deck should outlive the default 24h anonymous expiry so it
        // doesn't vanish mid-session — same TTL a claim grants.
        expires_at: ownedExpiry(),
      });
      if (!id) {
        res.status(500).json({ error: "Failed to create session" });
        return;
      }

      const pdfPath = `${id}.pdf`;
      const { error: uploadError } = await supabase.storage
        .from("presentations")
        .upload(pdfPath, file.buffer, { contentType: "application/pdf", upsert: true });
      if (uploadError) {
        await supabase.from("sessions").update({ status: "expired" }).eq("id", id);
        res.status(500).json({ error: "Failed to upload PDF" });
        return;
      }

      // Preserve the presenter's position: a local deck's slide changes were
      // never persisted server-side, so this is the first the row hears of it.
      const update: Record<string, unknown> = { local: false, pdf_path: pdfPath };
      const currentSlide = parseInt(req.body.current_slide, 10);
      if (Number.isFinite(currentSlide) && currentSlide >= 1) {
        update.current_slide = clampSlide(currentSlide, totalSlides);
      }
      const { error: updateError } = await supabase.from("sessions").update(update).eq("id", id);
      if (updateError) {
        await supabase.storage.from("presentations").remove([pdfPath]);
        await supabase.from("sessions").update({ status: "expired" }).eq("id", id);
        res.status(500).json({ error: "Failed to update session" });
        return;
      }

      const undo = async () => {
        await supabase.storage.from("presentations").remove([pdfPath]);
        await supabase.from("sessions").update({ status: "expired" }).eq("id", id);
      };
      if (userId && !(await reconcileQuota(res, userId, undo))) return;

      res.json({ id, totalSlides, controllerToken });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Mint — or hand back — the shared-control passphrase. It is created on first
  // need rather than at session creation: most decks are never co-presented,
  // and a deck that was never shared has no row to hold one.
  app.post("/api/sessions/:id/passphrase", async (req, res) => {
    try {
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
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
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
        const row = await loadSession(supabase, req.params.id, "controller_token");
        if (!row || !(await authorizeController(supabase, req, row))) {
          res.status(403).json({ error: "Not authorized" });
          return;
        }
        userId = null;
      } else {
        const user = await requireUser(supabase, req);
        if (!user) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        userId = user.id;

        // Cap how many synced presentations a user can have live at once. Only
        // rows that are still active and not past expiry count, and the session
        // being claimed is excluded so a re-claim of the same code is a no-op.
        if (!(await ensureQuota(res, userId, String(req.params.id)))) return;
      }

      const file = req.file;
      if (!isPdfUpload(file)) {
        res.status(400).json({ error: "A PDF file is required" });
        return;
      }

      const row = await loadSession(supabase, req.params.id, "id, local, controller_token, passphrase");
      if (!row) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (!row.local) {
        res.status(409).json({ error: "Presentation is already synced" });
        return;
      }

      const pdfPath = `${row.id}.pdf`;
      const pages = await countPages(file.buffer);
      if (!pages.ok) {
        res.status(pages.status).json({ error: pages.error });
        return;
      }
      const { totalSlides } = pages;

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
      if (Number.isFinite(currentSlide) && currentSlide >= 1) update.current_slide = clampSlide(currentSlide, totalSlides);

      const { error: updateError } = await supabase
        .from("sessions")
        .update(update)
        .eq("id", row.id);
      if (updateError) {
        res.status(500).json({ error: "Failed to update session" });
        return;
      }

      // No cap in local mode, so nothing to reconcile there.
      const undo = async () => {
        await supabase.storage.from("presentations").remove([pdfPath]);
        await supabase.from("sessions").update({ local: true, pdf_path: "" }).eq("id", row.id);
      };
      if (userId && !(await reconcileQuota(res, userId, undo))) return;

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
  //     what plugins retained for the old deck is dropped (drawings, keyed by
  //     slide number), and everyone in the room gets `deck_updated` so they
  //     reload the new bytes live.
  app.post("/api/sessions/:id/pdf", uploadField("pdf"), async (req, res) => {
    try {
      const file = req.file;
      if (!isPdfUpload(file)) {
        res.status(400).json({ error: "A PDF file is required" });
        return;
      }

      const row = await loadSession(supabase, req.params.id, "id, local, pdf_path, pdf_url, user_id, controller_token, filename, current_slide");
      if (!row) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      // Authorized either by the controller token — the same model as ending a
      // session, so an anonymous presenter (and later agents/CLIs) can rewrite
      // the deck they control — or, in hosted mode, by the logged-in owner.
      if (!(await authorizeController(supabase, req, row, { allowOwner: true }))) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }
      if (row.local || !row.pdf_path) {
        res.status(400).json({ error: "This presentation's PDF is not hosted on the server" });
        return;
      }

      const pages = await countPages(file.buffer);
      if (!pages.ok) {
        res.status(pages.status).json({ error: pages.error });
        return;
      }
      const { totalSlides } = pages;

      const newFilename = normalizeDeckName(req.body.filename);

      const replaced = await replaceHostedDeck(supabase, row, { buffer: file.buffer, totalSlides, filename: newFilename });
      if (!replaced.ok) {
        res.status(replaced.status).json({ error: replaced.error });
        return;
      }

      // A real replacement announces itself; a notes re-save (no filename)
      // stays silent so viewers aren't forced to re-download identical slides.
      if (newFilename) announceDeckUpdate(io, socketState, row.id, { filename: newFilename, totalSlides });

      res.json({ ok: true, totalSlides, filename: newFilename || row.filename });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/sessions/:id/remote-version — cheap republish detection for a
  // URL-backed deck. Answers with the remote PDF's validator tuple (ETag /
  // Last-Modified / Content-Length, as available) so the controller can tell,
  // without downloading anything, whether the file at `pdf_url` has changed
  // since the previous poll. Authorized like the /pdf route (controller token
  // or the logged-in owner): the values themselves are opaque strings, but
  // there is no reason to let arbitrary visitors probe them.
  //
  //   - 404 when the session is unknown/expired or not URL-backed (local and
  //     server-hosted decks have no pdf_url) — the client reads this as
  //     "nothing to watch" and stops polling.
  //   - 502 when the remote host is unreachable or errors — the client backs
  //     off and keeps today's behaviour; nothing surfaces to the presenter.
  app.get("/api/sessions/:id/remote-version", async (req, res) => {
    try {
      const row = await loadSession(supabase, req.params.id, "id, local, pdf_url, user_id, controller_token");
      if (!row) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (!(await authorizeController(supabase, req, row, { allowOwner: true }))) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }
      if (row.local || !row.pdf_url) {
        res.status(404).json({ error: "This presentation is not backed by an external URL" });
        return;
      }

      const meta = await fetchRemotePdfMeta(row.pdf_url);
      if (!meta) {
        res.status(502).json({ error: "The remote host could not be reached" });
        return;
      }
      res.json(meta);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/sessions/:id/deck-refreshed — the controller noticed (via
  // remote-version polling) that a URL-backed deck was republished at its
  // source and the presenter accepted the new version. Unlike /pdf there are
  // no bytes to store — pdf_url decks keep no server copy — so this only
  // records the new page count, clamps the current slide into range, drops
  // what plugins retained for the old deck (drawings, keyed by slide number)
  // and announces the swap to the room; every client re-fetches the URL
  // itself. The filename is unchanged: a republish replaces the content, not
  // the presentation's title.
  //
  // Unlike /pdf, the page count is asserted by the client rather than parsed
  // here — there are no bytes on this side to count. That is safe because only
  // the controller can call this, and because isValidTotalSlides bounds the
  // value: total_slides gates slide numbers, so an unbounded one would be a
  // lever, but a wrong-but-bounded one only mis-clamps the presenter's own deck
  // until the next real update.
  app.post("/api/sessions/:id/deck-refreshed", async (req, res) => {
    try {
      const totalSlides = parseInt(req.body.total_slides, 10);
      if (!isValidTotalSlides(totalSlides)) {
        res.status(400).json({ error: "A valid total_slides is required" });
        return;
      }

      const row = await loadSession(supabase, req.params.id, "id, local, pdf_url, user_id, controller_token, filename, current_slide");
      if (!row) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (!(await authorizeController(supabase, req, row, { allowOwner: true }))) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }
      if (row.local || !row.pdf_url) {
        res.status(400).json({ error: "This presentation is not backed by an external URL" });
        return;
      }

      const { error: updateError } = await supabase
        .from("sessions")
        .update({ total_slides: totalSlides, current_slide: clampSlide(row.current_slide, totalSlides) })
        .eq("id", row.id);
      if (updateError) {
        res.status(500).json({ error: "Failed to update session" });
        return;
      }

      announceDeckUpdate(io, socketState, row.id, { filename: row.filename, totalSlides });

      res.json({ ok: true, totalSlides, filename: row.filename });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
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
