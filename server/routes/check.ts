// POST /api/check — upload a PDF, get back a structured sidecar validity report.
// Accepts multipart/form-data with a `file` field (PDF).
// Returns JSON; no auth required. Useful for CI pipelines, LLM tooling, etc.

import type express from "express";
import { openPdf, closePdf, readAttachments } from "../lib/pdfDoc.js";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { canonicalBaseUrl } from "../lib/baseUrl.js";
import { isPdfUpload, uploadField } from "../lib/upload.js";
import {
  checkSidecars,
  type SidecarAttachment,
  type SidecarIssue,
  type SidecarKind,
  type Validity,
} from "../../shared/sidecar.js";

// ── Report types ──────────────────────────────────────────────────────────────
// The checks are shared with the app's checker page (shared/sidecar.ts); this
// is their shape on the wire (schema/check-report.schema.json).

interface AttachmentResult {
  filename: string;
  kind: SidecarKind;
  slide?: number;
  validity: Validity;
  issues: SidecarIssue[];
  /** Rendered notes, as markdown (notes attachments only). */
  text?: string;
  /** Parsed JSON (notes and media-json). */
  data?: unknown;
}

interface PageResult {
  page: number;
  notes: AttachmentResult | null;
  media: AttachmentResult[];
}

interface CheckReport {
  $schema: string;
  pageCount: number;
  summary: { total: number; valid: number; warning: number; invalid: number };
  pages: PageResult[];
  orphans: AttachmentResult[];
}

export type { CheckReport };

export type CheckResult =
  | { ok: true; report: CheckReport }
  | { ok: false; status: number; error: string };

/** Build a sidecar validity report from PDF bytes (shared by REST and MCP). */
export async function buildCheckReport(buffer: Buffer, schemaBaseUrl: string): Promise<CheckResult> {
  let pdf: PDFDocumentProxy;
  try {
    pdf = await openPdf({ data: new Uint8Array(buffer) });
  } catch {
    return { ok: false, status: 422, error: "Could not parse PDF" };
  }

  const pageCount = pdf.numPages;
  const entries = await readAttachments(pdf);
  await closePdf(pdf);

  const checked = checkSidecars(entries, pageCount);
  const result = ({ filename, kind, slide, validity, issues, parsed, notes }: SidecarAttachment): AttachmentResult => ({
    filename,
    kind,
    slide,
    validity,
    issues,
    text: notes,
    data: parsed,
  });
  return {
    ok: true,
    report: {
      $schema: `${schemaBaseUrl}/schema/check-report.schema.json`,
      pageCount,
      summary: checked.summary,
      pages: checked.pages.map((p) => ({ page: p.page, notes: p.notes && result(p.notes), media: p.media.map(result) })),
      orphans: checked.orphans.map(result),
    },
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export function registerCheckRoute(app: express.Express) {
  /**
   * POST /api/check
   * Body: multipart/form-data, field name "file", PDF only.
   * Returns: JSON CheckReport.
   *
   * Example:
   *   curl -s -F file=@deck.pdf https://presio.ch/api/check | jq .
   */
  app.post("/api/check", uploadField("file"), async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Missing "file" field (multipart/form-data)' });
      return;
    }
    if (!isPdfUpload(file)) {
      res.status(400).json({ error: "File must be a PDF" });
      return;
    }

    const result = await buildCheckReport(file.buffer, canonicalBaseUrl(req));
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.report);
  });
}
