import { useState, useEffect } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { extractSpeakerNotes } from "@/lib/pdf";
import { marked } from "marked";
import DOMPurify from "dompurify";

export function SpeakerNotesCard({
  pdf,
  currentSlide,
}: {
  pdf: PDFDocumentProxy;
  currentSlide: number;
}) {
  const [notes, setNotes] = useState("");

  useEffect(() => {
    extractSpeakerNotes(pdf, currentSlide).then(setNotes);
  }, [pdf, currentSlide]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto min-h-0">
        {notes ? (
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(notes) as string) }}
          />
        ) : (
          <p className="text-xs text-muted-foreground">No speaker notes for this slide.</p>
        )}
      </div>
    </div>
  );
}
