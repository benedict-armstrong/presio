// Strict sidecar inspection for the PDF checker tool: the checks themselves
// are shared with POST /api/check (shared/sidecar.ts).

import type { PDFDocumentProxy } from "pdfjs-dist";
import { readAttachments } from "./pdf";
import { checkSidecars, type SidecarAttachment, type SidecarPage, type SidecarReport } from "@shared/sidecar";

export type { Validity } from "@shared/sidecar";
export type InspectedAttachment = SidecarAttachment;
export type PageReport = SidecarPage<SidecarAttachment>;
export type DeckReport = SidecarReport;

export async function inspectAttachments(pdf: PDFDocumentProxy): Promise<DeckReport> {
  return checkSidecars(await readAttachments(pdf), pdf.numPages);
}
