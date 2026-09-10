// Link annotations extracted from the PDF. Typst's `#link` produces these, and
// nothing in the app used them before: the slide is painted to a canvas, which
// has no notion of a clickable region, so links were dead on screen.
//
// Positions use the same convention as MediaPlacement — a fraction of the page,
// top-left origin — so an overlay can place them over the rendered canvas.

import type { PDFDocumentProxy } from "pdfjs-dist";

export interface SlideLink {
  id: string;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  /** Target slide, for a jump within the deck. */
  slide?: number;
  /** Target URL, for a link out. Exactly one of `slide` / `url` is set. */
  url?: string;
}

// A PDF is untrusted input (decks get handed around and downloaded), and unlike
// the media sidecars these URLs end up in an <a href> that a presenter clicks.
// An allow-list is the only safe shape here: it drops `javascript:` and friends,
// and incidentally drops presio's own `note:` annotations, which share the URL
// field but are speaker notes rather than links (see extractSpeakerNotes).
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function safeLinkUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a rectangle already converted to viewport space into page
 * fractions. pdf.js hands back the corners in either order, so this doesn't
 * assume which is which.
 */
export function linkRectPct(
  rect: number[],
  viewportW: number,
  viewportH: number
): Pick<SlideLink, "xPct" | "yPct" | "wPct" | "hPct"> | null {
  if (!viewportW || !viewportH || rect.length < 4) return null;
  const [x1, y1, x2, y2] = rect;
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  if (!width || !height) return null;
  return {
    xPct: left / viewportW,
    yPct: top / viewportH,
    wPct: width / viewportW,
    hPct: height / viewportH,
  };
}

/**
 * The 1-based slide a link destination points at, or null if it can't be
 * resolved. A destination is either a named string (needing a lookup) or an
 * explicit array whose first entry identifies the page — as a page ref for a
 * real document, or already as an index in some generated files.
 */
export async function resolveDestSlide(
  pdf: PDFDocumentProxy,
  dest: unknown
): Promise<number | null> {
  try {
    const resolved = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) return null;
    const target = resolved[0];
    if (typeof target === "number") return target + 1;
    if (!target || typeof target !== "object") return null;
    return (await pdf.getPageIndex(target as never)) + 1;
  } catch {
    return null;
  }
}

const linksCache = new WeakMap<PDFDocumentProxy, Map<number, SlideLink[]>>();

/** Every link on every page, keyed by 1-based slide number. Best-effort: a page
 *  whose annotations fail to parse simply contributes no links. */
export async function loadSlideLinks(
  pdf: PDFDocumentProxy
): Promise<Map<number, SlideLink[]>> {
  const cached = linksCache.get(pdf);
  if (cached) return cached;

  const bySlide = new Map<number, SlideLink[]>();
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const annotations = await page.getAnnotations();
      const links: SlideLink[] = [];

      for (const [i, ann] of annotations.entries()) {
        if (ann.subtype !== "Link") continue;
        if (!Array.isArray(ann.rect)) continue;

        // Go through the viewport so page rotation is applied for us.
        const box = linkRectPct(
          viewport.convertToViewportRectangle(ann.rect),
          viewport.width,
          viewport.height
        );
        if (!box) continue;

        const id = `${pageNum}-${i}`;
        if (ann.dest != null) {
          const slide = await resolveDestSlide(pdf, ann.dest);
          if (slide) links.push({ id, ...box, slide });
          continue;
        }
        const url = safeLinkUrl(ann.url ?? ann.unsafeUrl);
        if (url) links.push({ id, ...box, url });
      }

      if (links.length) bySlide.set(pageNum, links);
    } catch {
      /* a page that won't give up its annotations just has no links */
    }
  }

  linksCache.set(pdf, bySlide);
  return bySlide;
}
