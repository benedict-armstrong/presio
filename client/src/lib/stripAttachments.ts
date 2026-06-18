// Produce a copy of a PDF with all embedded-file attachments removed.
// Used to offer viewers/controllers a slimmed-down download without the
// presio media / notes JSON sidecars.

import { PDFDocument } from "pdf-lib";

export interface StripResult {
  blob: Blob;
  originalSize: number;
  strippedSize: number;
}

export async function stripAttachments(pdfUrl: string): Promise<StripResult> {
  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`Failed to fetch PDF (${res.status})`);
  const original = await res.arrayBuffer();

  const src = await PDFDocument.load(original);
  // copyPages only pulls page-reachable objects into the new doc, so any
  // embedded-files name tree on the source catalog is naturally dropped.
  const dst = await PDFDocument.create();
  const pages = await dst.copyPages(src, src.getPageIndices());
  for (const p of pages) dst.addPage(p);

  const out = await dst.save();
  // Some bundlers/types return Uint8Array<ArrayBufferLike>; coerce to a
  // plain ArrayBuffer slice so Blob's BlobPart typing is happy.
  const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  const blob = new Blob([buf], { type: "application/pdf" });
  return {
    blob,
    originalSize: original.byteLength,
    strippedSize: out.byteLength,
  };
}
