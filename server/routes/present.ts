// POST /api/present — the agent-facing upload (next to mcp.ts, which exposes
// the same thing as the present_pdf tool, and lib/presentHandoff.ts).

import type express from "express";
import type { AppDeps } from "../app.js";
import { resolveOptionalUserId } from "../auth.js";
import { baseUrl } from "../lib/baseUrl.js";
import { createPresentHandoff, updatePresentDeck } from "../lib/presentHandoff.js";
import { isPdfUpload, singleField, uploadField } from "../lib/upload.js";

export function registerPresentRoute(app: express.Express, { supabase, io, socketState }: AppDeps) {
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
  });
}
