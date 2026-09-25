// One bundle for everything about the loaded presentation: the pdf.js document
// plus what we extract from it (links, whether it carries attachments). Views
// and cards take this single object instead of a fistful of loose
// pdf/url/filename props.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { hasAttachments } from "./pdf";
import { loadLinks, type PdfLink } from "./pdfLinks";

/** Everything derived from the PDF itself — stable until the file changes
 *  (e.g. when a plugin saves an edited deck). */
export interface Deck {
  pdf: PDFDocumentProxy;
  /** Source of the PDF bytes: server URL, or an object URL for local sessions. */
  url: string;
  filename: string;
  totalSlides: number;
  /** True when the PDF carries embedded-file attachments (presio sidecars). */
  hasAttachments: boolean;
  /** Link annotations per slide (no entry = no links). */
  linksBySlide: Map<number, PdfLink[]>;
}

/** Extract everything the app needs from a freshly loaded PDF. Never rejects —
 *  links and attachments are best-effort extras. */
export async function loadDeck(
  pdf: PDFDocumentProxy,
  url: string,
  filename: string
): Promise<Deck> {
  const totalSlides = pdf.numPages;
  const [attachments, linksBySlide] = await Promise.all([
    hasAttachments(pdf).catch(() => false),
    loadLinks(pdf).catch(() => new Map<number, PdfLink[]>()),
  ]);
  return {
    pdf,
    url,
    filename,
    totalSlides,
    hasAttachments: attachments,
    linksBySlide,
  };
}
