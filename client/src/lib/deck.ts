// One bundle for everything about the loaded presentation: the pdf.js document
// plus what we extract from it (speaker notes, media placements, whether it
// carries attachments) and the presenter's live drawings. Views and cards take
// this single object instead of a fistful of loose pdf/url/filename props.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { extractSpeakerNotes, loadMediaPlacements, type MediaPlacement } from "./pdf";
import type { AnnotationsBySlide } from "./annotations";

/** Everything derived from the PDF itself — stable until the file changes
 *  (e.g. when edited speaker notes are written back). */
export interface DeckInfo {
  pdf: PDFDocumentProxy;
  /** Source of the PDF bytes: server URL, or an object URL for local sessions. */
  url: string;
  filename: string;
  totalSlides: number;
  /** True when the PDF carries embedded-file attachments (presio sidecars). */
  hasAttachments: boolean;
  /** Speaker notes per slide (no entry = no notes). */
  notes: Map<number, string>;
  /** Media placements per slide. */
  mediaBySlide: Map<number, MediaPlacement[]>;
}

/** DeckInfo plus the live layer drawn on top during the session. */
export interface Deck extends DeckInfo {
  annotations: AnnotationsBySlide;
}

/** Extract everything the app needs from a freshly loaded PDF. Never rejects —
 *  notes, media and attachments are best-effort extras. */
export async function loadDeckInfo(
  pdf: PDFDocumentProxy,
  url: string,
  filename: string
): Promise<DeckInfo> {
  const totalSlides = pdf.numPages;
  const [attachments, mediaBySlide, noteTexts] = await Promise.all([
    pdf.getAttachments().catch(() => null),
    loadMediaPlacements(pdf).catch(() => new Map<number, MediaPlacement[]>()),
    Promise.all(
      Array.from({ length: totalSlides }, (_, i) =>
        extractSpeakerNotes(pdf, i + 1).catch(() => "")
      )
    ),
  ]);
  const notes = new Map<number, string>();
  noteTexts.forEach((text, i) => {
    if (text) notes.set(i + 1, text);
  });
  return {
    pdf,
    url,
    filename,
    totalSlides,
    hasAttachments: !!attachments && Object.keys(attachments).length > 0,
    notes,
    mediaBySlide,
  };
}
