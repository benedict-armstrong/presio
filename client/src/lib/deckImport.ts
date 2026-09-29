// Bringing a PDF into this browser: reading a picked or dropped file, and
// storing it as a local deck. The home screen's import and replace, the
// controller's replace, and the checker's "Present" all go through here.

import { openPdf, destroyPdf } from "@/lib/pdf";
import { idbPut } from "@/lib/localStore";
import { newLocalDeckId } from "@/lib/localId";
import { lsSetString, deckWatchKey } from "@/lib/storage";
import { track, sha256Hex } from "@/lib/analytics";

/** A PDF read into memory, with what's known about it. */
export interface IngestedPdf {
  /** An in-memory copy of the bytes (not the File, see ingestPdfBytes). */
  blob: Blob;
  /** SHA-256 of the bytes; absent where crypto.subtle isn't (plain http). */
  sha256?: string;
  totalSlides: number;
  /** The file's name without ".pdf". */
  filename: string;
  size: number;
}

export const PRIVATE_MODE_ERROR =
  "Couldn't store the presentation in this browser. Private/incognito mode isn't supported — please use a normal window.";

/**
 * Read PDF bytes: copy them, fingerprint them and count their pages.
 *
 * The copy matters: a File from the picker is only a reference to the file on
 * disk, and IndexedDB persists that reference — not the bytes. If the file is
 * moved, edited, or removed before the deck is synced, reading it back fails
 * partway through the upload. And both the copy and the hash have to happen
 * before pdf.js gets the buffer, which it transfers to its worker, detaching
 * it. Hashing reads memory already in hand, and only the digest ever leaves
 * the browser.
 */
export async function ingestPdfBytes(buf: ArrayBuffer, name: string): Promise<IngestedPdf> {
  const blob = new Blob([buf], { type: "application/pdf" });
  let sha256: string | undefined;
  try {
    sha256 = await sha256Hex(buf);
  } catch {
    // No crypto.subtle (e.g. plain-http origins): go on without a fingerprint.
  }
  const size = buf.byteLength;
  const doc = await openPdf({ data: new Uint8Array(buf) });
  const totalSlides = doc.numPages;
  destroyPdf(doc);
  return { blob, sha256, totalSlides, filename: name.replace(/\.pdf$/i, ""), size };
}

/** Read a picked or dropped PDF file (see ingestPdfBytes). */
export async function ingestPdfFile(file: File): Promise<IngestedPdf> {
  return ingestPdfBytes(await file.arrayBuffer(), file.name);
}

/**
 * Store a PDF as a new local deck under an id minted here, and return the id.
 * Nothing touches the network: the deck, its id and everything keyed by it are
 * local to this browser, so a PDF can be imported and presented with no
 * connection at all. The join code is created later, server-side, if and when
 * the presenter shares the deck.
 */
export async function createLocalDeck(
  pdf: IngestedPdf,
  opts: { handle?: FileSystemFileHandle; hotReload?: boolean } = {}
): Promise<string> {
  const id = newLocalDeckId();
  try {
    await idbPut({
      id,
      filename: pdf.filename,
      totalSlides: pdf.totalSlides,
      blob: pdf.blob,
      sha256: pdf.sha256,
      ...(opts.handle ? { handle: opts.handle } : {}),
      createdAt: Date.now(),
    });
  } catch {
    throw new Error(PRIVATE_MODE_ERROR);
  }
  // Remember how this deck should treat recompiles. The handle is stored
  // either way, so the controller's live-reload control can turn watching on
  // later without asking for the file again.
  lsSetString(deckWatchKey(id), opts.handle && opts.hotReload ? "prompt" : "off");
  // Counted only once the deck is durably stored; the analytics sink
  // timestamps each event, so two uploads of the same filename can be compared
  // by hash to spot recompiled vs. re-uploaded decks.
  track("upload", { filename: pdf.filename, sha256: pdf.sha256, size: pdf.size, slides: pdf.totalSlides });
  return id;
}
