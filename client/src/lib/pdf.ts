import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import { typstAstToMarkdown } from "./typstNotes";

GlobalWorkerOptions.workerSrc = pdfWorker;

// Cached *source* canvases, keyed by page+scale. These are never mounted in the
// DOM: each renderPage() call returns a fresh copy (see below). A canvas is a
// DOM node that can only live in one place, so handing the same cached element
// to multiple consumers (thumbnails, next-slide preview, the main view) made
// appending it in one spot yank it out of another — e.g. clicking a thumbnail
// whose scale collided with the main view turned the thumbnail black.
const pageCache = new Map<string, HTMLCanvasElement>();

/** Blit a cached source canvas into a new, independently-mountable canvas. */
function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  out.getContext("2d")!.drawImage(source, 0, 0);
  return out;
}

export async function loadPdf(url: string): Promise<PDFDocumentProxy> {
  // Fetch the whole file in one request rather than letting pdf.js stream it
  // with HTTP range requests. Mobile Safari/iOS mishandles cross-origin 206
  // Partial Content responses, so range-loaded PDFs that work on desktop fail
  // on iOS. Presentations are small, so a single GET is cheap and robust.
  return getDocument({ url, disableRange: true, disableStream: true }).promise;
}

export async function loadPdfData(data: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({ data }).promise;
}

// Cap the rendered canvas width (device pixels). Beyond ~4K wide there's no
// visible gain and we risk hitting browser canvas-size limits / memory.
const MAX_CANVAS_WIDTH = 4096;

export interface RenderOptions {
  // Fixed scale multiplier (used for thumbnails / previews).
  scale?: number;
  // Desired output width in device pixels. When set, the scale is derived so
  // the canvas matches the display resolution and stays crisp. Takes
  // precedence over `scale`.
  targetWidth?: number;
}

export async function renderPage(
  pdf: PDFDocumentProxy,
  pageNum: number,
  opts: number | RenderOptions = {}
): Promise<HTMLCanvasElement> {
  const options: RenderOptions = typeof opts === "number" ? { scale: opts } : opts;

  const page = await pdf.getPage(pageNum);
  const baseWidth = page.getViewport({ scale: 1 }).width;

  let scale: number;
  if (options.targetWidth) {
    scale = Math.min(options.targetWidth, MAX_CANVAS_WIDTH) / baseWidth;
  } else {
    scale = options.scale ?? 2;
  }
  // Round so small layout/DPR jitters reuse the cached canvas instead of
  // re-rendering on every resize.
  scale = Math.max(0.25, Math.round(scale * 4) / 4);

  const key = `${pageNum}-${scale}`;
  const cached = pageCache.get(key);
  if (cached) return copyCanvas(cached);

  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({
    canvasContext: canvas.getContext("2d")!,
    canvas,
    viewport,
  }).promise;

  pageCache.set(key, canvas);
  return copyCanvas(canvas);
}

let notesCache: Map<number, string> | null = null;
let notesCachePdf: PDFDocumentProxy | null = null;

async function loadNotesFromAttachments(pdf: PDFDocumentProxy): Promise<Map<number, string>> {
  if (notesCachePdf === pdf && notesCache) return notesCache;

  const map = new Map<number, string>();
  const attachments = await pdf.getAttachments();
  if (attachments) {
    for (const [, attachment] of Object.entries(
      attachments as Record<string, { filename?: string; content: Uint8Array }>
    )) {
      const match = (attachment.filename ?? "").match(/^notes-slide-(\d+)\.json$/);
      if (!match) continue;
      try {
        const text = new TextDecoder().decode(attachment.content);
        const data = JSON.parse(text);
        const slideNum = parseInt(match[1], 10);
        let rendered: string;
        if (typeof data.notes === "string") {
          rendered = data.notes;
        } else if (Array.isArray(data.notes)) {
          rendered = data.notes
            .map((n: unknown) => typstAstToMarkdown(n))
            .filter((s: string) => s.length > 0)
            .join("\n\n---\n\n");
        } else {
          rendered = typstAstToMarkdown(data.notes);
        }
        map.set(slideNum, rendered);
      } catch { /* skip malformed */ }
    }
  }

  notesCache = map;
  notesCachePdf = pdf;
  return map;
}

async function extractNotesFromAnnotations(
  pdf: PDFDocumentProxy,
  pageNum: number,
  prefix = "note:"
): Promise<string> {
  const page = await pdf.getPage(pageNum);
  const annotations = await page.getAnnotations();
  const notes: string[] = [];
  for (const ann of annotations) {
    const url: string | undefined = ann.url || ann.unsafeUrl;
    if (url && url.startsWith(prefix)) {
      notes.push(decodeURIComponent(url.slice(prefix.length)));
    }
  }
  return notes.join("\n\n");
}

export async function extractSpeakerNotes(
  pdf: PDFDocumentProxy,
  pageNum: number,
  prefix = "note:"
): Promise<string> {
  const map = await loadNotesFromAttachments(pdf);
  if (map.has(pageNum)) return map.get(pageNum)!;
  return extractNotesFromAnnotations(pdf, pageNum, prefix);
}

export type MediaKind = "file" | "url" | "youtube" | "vimeo";

export interface MediaPlacement {
  slide: number;
  id: string;
  kind: MediaKind;
  filename?: string;
  mime: string;
  // Position/size as fraction of page (0..1), top-left origin
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  autoplay: boolean;
  loop: boolean;
  // For file/url kinds: blob URL (file) or remote URL. For youtube/vimeo:
  // the canonical embed URL — see MediaOverlay for player construction.
  blobUrl: string;
  videoId?: string;
}

let mediaCache: Map<number, MediaPlacement[]> | null = null;
let mediaCachePdf: PDFDocumentProxy | null = null;
let mediaBlobUrls: string[] = [];

interface MediaMetaJson {
  slide: number;
  id: string;
  kind?: MediaKind;
  filename?: string;
  url?: string;
  video_id?: string;
  mime: string;
  x_pt: number;
  y_pt: number;
  w_pt: number;
  h_pt: number;
  autoplay: boolean;
  loop: boolean;
}

function revokeMediaUrls() {
  for (const url of mediaBlobUrls) URL.revokeObjectURL(url);
  mediaBlobUrls = [];
}

export async function loadMediaPlacements(
  pdf: PDFDocumentProxy
): Promise<Map<number, MediaPlacement[]>> {
  if (mediaCachePdf === pdf && mediaCache) return mediaCache;
  revokeMediaUrls();

  const attachments = await pdf.getAttachments();
  const binaries = new Map<string, string>(); // filename -> blob URL
  const metas: MediaMetaJson[] = [];

  if (attachments) {
    for (const [, att] of Object.entries(
      attachments as Record<string, { filename?: string; content: Uint8Array }>
    )) {
      const name: string = att.filename ?? "";
      if (/^media-slide-\d+-.+\.json$/.test(name)) {
        try {
          const text = new TextDecoder().decode(att.content);
          metas.push(JSON.parse(text));
        } catch { /* skip */ }
      } else if (/^media-.+\.(gif|mp4|webm)$/i.test(name)) {
        if (binaries.has(name)) continue;
        const mime =
          /\.gif$/i.test(name) ? "image/gif" :
          /\.mp4$/i.test(name) ? "video/mp4" :
          /\.webm$/i.test(name) ? "video/webm" : "application/octet-stream";
        const blob = new Blob([att.content as BlobPart], { type: mime });
        const url = URL.createObjectURL(blob);
        mediaBlobUrls.push(url);
        binaries.set(name, url);
      }
    }
  }

  // Need page dimensions to convert pt -> fractional. All slides share size
  // in the polylux template (presentation-16-9), but read per-slide to be safe.
  const pageDimsCache = new Map<number, { w: number; h: number }>();
  async function getPageDims(n: number) {
    let dims = pageDimsCache.get(n);
    if (!dims) {
      const page = await pdf.getPage(n);
      const v = page.view; // [x1, y1, x2, y2] in PDF pt
      dims = { w: v[2] - v[0], h: v[3] - v[1] };
      pageDimsCache.set(n, dims);
    }
    return dims;
  }

  const map = new Map<number, MediaPlacement[]>();
  for (const m of metas) {
    const kind: MediaKind =
      m.kind ?? (m.url ? "url" : "file");
    let source: string | undefined;
    if (kind === "youtube" || kind === "vimeo" || kind === "url") {
      source = m.url;
    } else if (m.filename) {
      source = binaries.get(m.filename);
    }
    if (!source) continue;
    const dims = await getPageDims(m.slide);
    const placement: MediaPlacement = {
      slide: m.slide,
      id: m.id,
      kind,
      filename: m.filename,
      mime: m.mime,
      xPct: m.x_pt / dims.w,
      yPct: m.y_pt / dims.h,
      wPct: m.w_pt / dims.w,
      hPct: m.h_pt / dims.h,
      autoplay: !!m.autoplay,
      loop: !!m.loop,
      blobUrl: source,
      videoId: m.video_id,
    };
    const arr = map.get(m.slide) ?? [];
    arr.push(placement);
    map.set(m.slide, arr);
  }

  mediaCache = map;
  mediaCachePdf = pdf;
  return map;
}

export function clearCache() {
  pageCache.clear();
  revokeMediaUrls();
  mediaCache = null;
  mediaCachePdf = null;
}
