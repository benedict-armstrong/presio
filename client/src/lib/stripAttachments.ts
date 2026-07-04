// Produce a copy of a PDF with all embedded-file attachments removed.
// Used to offer a slimmed-down download without the presio media / notes
// JSON sidecars.

import { PDFDocument } from "pdf-lib";

export async function stripAttachments(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes);
  // copyPages only pulls page-reachable objects into the new doc, so any
  // embedded-files name tree on the source catalog is naturally dropped.
  const dst = await PDFDocument.create();
  const pages = await dst.copyPages(src, src.getPageIndices());
  for (const p of pages) dst.addPage(p);
  return dst.save();
}
