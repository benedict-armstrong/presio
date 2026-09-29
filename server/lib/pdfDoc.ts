// Owns the two pdf.js API shapes that changed in v6, so the rest of the server
// keeps talking about documents rather than about loading tasks and Maps.
//
// v6 moved `destroy()` off PDFDocumentProxy and onto the loading task, and
// changed `getAttachments()` to return a Map whose entries no longer carry
// their bytes eagerly. Both changes are quiet: `Object.keys()` on a Map is
// `[]`, so the old call sites reported a deck with notes as a deck with none,
// and the `as Record<...>` casts they used hid it from the compiler.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { MAX_TOTAL_SLIDES } from "../../shared/limits.js";

type DocumentSource = Parameters<typeof getDocument>[0];

/**
 * The loading task that owns each open document.
 *
 * Weak so a document that is dropped without being closed doesn't pin its task
 * here for the life of the process.
 */
const tasks = new WeakMap<PDFDocumentProxy, ReturnType<typeof getDocument>>();

/** Open a PDF. Pair with closePdf() to release the worker. */
export async function openPdf(source: DocumentSource): Promise<PDFDocumentProxy> {
  const task = getDocument(source);
  const doc = await task.promise;
  tasks.set(doc, task);
  return doc;
}

/**
 * Release a document's worker.
 *
 * Destroying the task is what v5's `doc.destroy()` did internally, so this is
 * the same operation reached through the handle the caller already holds.
 */
export async function closePdf(doc: PDFDocumentProxy | null | undefined): Promise<void> {
  if (!doc) return;
  await tasks.get(doc)?.destroy();
}

export type PageCount = { ok: true; totalSlides: number } | { ok: false; status: number; error: string };

/**
 * An uploaded deck's page count: 422 when it isn't a PDF pdf.js can read, 400
 * when it has more pages than a session may (MAX_TOTAL_SLIDES).
 */
export async function countPages(bytes: Uint8Array): Promise<PageCount> {
  let totalSlides: number;
  try {
    // pdf.js may detach the buffer it's given; callers still need theirs.
    const doc = await openPdf({ data: new Uint8Array(bytes) });
    totalSlides = doc.numPages;
    void closePdf(doc);
  } catch {
    return { ok: false, status: 422, error: "Could not parse PDF" };
  }
  if (totalSlides < 1 || totalSlides > MAX_TOTAL_SLIDES) {
    return { ok: false, status: 400, error: `PDF exceeds the ${MAX_TOTAL_SLIDES}-page limit` };
  }
  return { ok: true, totalSlides };
}

/** One of a deck's sidecar attachments, with its bytes resolved. */
export interface PdfAttachment {
  filename: string;
  content: Uint8Array;
}

/**
 * Read a deck's attachments, bytes included.
 *
 * In v6 an entry's `content` is only populated when it happens to be loaded
 * already; otherwise the bytes are fetched on demand. Entries whose content
 * cannot be resolved are dropped rather than surfaced as empty, so callers
 * never mistake a failed read for an empty file.
 */
export async function readAttachments(doc: PDFDocumentProxy): Promise<PdfAttachment[]> {
  const raw = await doc.getAttachments();
  if (!raw) return [];

  const out: PdfAttachment[] = [];
  for (const [id, entry] of raw) {
    const content = entry.content ?? (await doc.getAttachmentContent(id));
    if (content) out.push({ filename: entry.filename ?? id, content });
  }
  return out;
}
