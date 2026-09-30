// Multipart PDF uploads: the multer setup, reading their text fields, and the
// checks every upload route applies to the file and its name.

import type express from "express";
import multer from "multer";
import { MAX_PDF_BYTES, MAX_PDF_MB } from "../../shared/limits.js";

/** A presentation's name when none was given. */
export const DEFAULT_DECK_NAME = "Presentation";
/** Longest presentation name kept. */
const MAX_DECK_NAME_LENGTH = 200;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } });

/**
 * Accept one file in `field`, answering upload failures as JSON.
 *
 * Multer/busboy failures are otherwise unhandled: they carry no `status`, so
 * they fall past the body-parser handler in app.ts to the terminal error
 * handler as a 500. The common case is a body that ends before its closing
 * boundary ("Unexpected end of form") — the browser aborted mid-upload, e.g.
 * because the Blob it was streaming couldn't be read — which is the uploader's
 * problem to retry, not a server fault. Answer 400 with a usable message.
 */
export function uploadField(field: string): express.RequestHandler {
  const handler = upload.single(field);
  return (req, res, next) =>
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      const code = (err as { code?: string }).code;
      if (code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: `PDF exceeds the ${MAX_PDF_MB}MB limit` });
        return;
      }
      console.error(`Upload failed for ${req.method} ${req.path}:`, err);
      res.status(400).json({
        error: "The upload didn't complete. Check your connection and try again.",
      });
    });
}

/**
 * Read a multipart text field that may legitimately appear at most once.
 * Multer hands a repeated field back as an array, which a bare
 * `typeof x === "string"` check silently reads as "absent" — on /api/present
 * that turned a duplicated `session_id` into a brand new presentation, burning
 * a concurrent slot and handing back a fresh link. `null` means "sent more than
 * once" so callers can reject instead of guessing which copy was meant.
 */
export function singleField(value: unknown): string | null {
  if (value === undefined) return "";
  return typeof value === "string" ? value : null;
}

/** Whether an upload says it's a PDF, by type or by name. What it really is,
 *  countPages() finds out. */
export function isPdfUpload(file: Express.Multer.File | undefined): file is Express.Multer.File {
  return !!file && (file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf"));
}

/** A presentation name from a filename: trimmed, without ".pdf", capped.
 *  Empty when there's nothing left. */
export function normalizeDeckName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\.pdf$/i, "").trim().slice(0, MAX_DECK_NAME_LENGTH);
}
