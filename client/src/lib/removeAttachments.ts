// Remove specific embedded-file attachments from a PDF by filename.
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString } from "pdf-lib";

function entryName(entry: unknown): string {
  if (entry instanceof PDFHexString || entry instanceof PDFString) return entry.decodeText();
  return "";
}

export async function removeAttachments(pdfBytes: Uint8Array, filenames: string[]): Promise<Uint8Array> {
  if (filenames.length === 0) return pdfBytes;
  const toRemove = new Set(filenames);
  const doc = await PDFDocument.load(pdfBytes);
  const arr = doc.catalog
    .lookupMaybe(PDFName.of("Names"), PDFDict)
    ?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict)
    ?.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (arr) {
    for (let i = arr.size() - 2; i >= 0; i -= 2) {
      if (toRemove.has(entryName(arr.lookup(i)))) {
        arr.remove(i + 1);
        arr.remove(i);
      }
    }
  }
  return doc.save();
}
