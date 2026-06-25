// Write speaker notes into a PDF as a `notes-slide-{n}.json` embedded-file
// attachment — the same sidecar format the presio Typst package emits, so the
// notes read back through `extractSpeakerNotes` (see pdf.ts).

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString } from "pdf-lib";

function entryName(entry: unknown): string {
  if (entry instanceof PDFHexString || entry instanceof PDFString) return entry.decodeText();
  return "";
}

// Drop an existing `filename` entry from the (flat) EmbeddedFiles name array so
// re-saving a slide replaces its notes instead of piling up duplicates. No-op
// when the name tree is nested or the entry is absent.
function removeAttachment(doc: PDFDocument, filename: string) {
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const ef = names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  const arr = ef?.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (!arr) return;
  for (let i = arr.size() - 2; i >= 0; i -= 2) {
    if (entryName(arr.lookup(i)) === filename) {
      arr.remove(i + 1);
      arr.remove(i);
    }
  }
}

export async function setSlideNotes(
  pdfBytes: Uint8Array,
  slide: number,
  notes: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const filename = `notes-slide-${slide}.json`;
  removeAttachment(doc, filename);

  const trimmed = notes.trim();
  if (trimmed) {
    const json = new TextEncoder().encode(JSON.stringify({ notes: trimmed }));
    await doc.attach(json, filename, { mimeType: "application/json" });
  }

  return doc.save();
}
