// One bundle for everything about the loaded presentation: the pdf.js document
// plus what we extract from it (media placements, links, whether it
// carries attachments) and the presenter's live drawings. Views and cards take
// this single object instead of a fistful of loose pdf/url/filename props.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { hasAttachments, loadMediaPlacements, type MediaPlacement } from "./pdf";
import { loadLinks, type PdfLink } from "./pdfLinks";
import type { AnnotationsBySlide } from "./annotations";

/** Everything derived from the PDF itself — stable until the file changes
 *  (e.g. when a plugin saves an edited deck). */
export interface DeckInfo {
  pdf: PDFDocumentProxy;
  /** Source of the PDF bytes: server URL, or an object URL for local sessions. */
  url: string;
  filename: string;
  totalSlides: number;
  /** True when the PDF carries embedded-file attachments (presio sidecars). */
  hasAttachments: boolean;
  /** Media placements per slide. */
  mediaBySlide: Map<number, MediaPlacement[]>;
  /** Link annotations per slide (no entry = no links). */
  linksBySlide: Map<number, PdfLink[]>;
}

/** DeckInfo plus the live layer drawn on top during the session. */
export interface Deck extends DeckInfo {
  annotations: AnnotationsBySlide;
}

/** Extract everything the app needs from a freshly loaded PDF. Never rejects —
 *  media, links and attachments are best-effort extras. */
export async function loadDeckInfo(
  pdf: PDFDocumentProxy,
  url: string,
  filename: string
): Promise<DeckInfo> {
  const totalSlides = pdf.numPages;
  const [attachments, mediaBySlide, linksBySlide] = await Promise.all([
    hasAttachments(pdf).catch(() => false),
    loadMediaPlacements(pdf).catch(() => new Map<number, MediaPlacement[]>()),
    loadLinks(pdf).catch(() => new Map<number, PdfLink[]>()),
  ]);
  return {
    pdf,
    url,
    filename,
    totalSlides,
    hasAttachments: attachments,
    mediaBySlide,
    linksBySlide,
  };
}
