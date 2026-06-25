import type { PDFDocumentProxy } from "pdfjs-dist";
import { NextSlideCard } from "./NextSlideCard";

// Mobile body: a simple non-draggable stack of the current slide (the live
// canvas) above the next-slide preview. Deliberately simpler than the desktop
// dashboard — no media controls, timer, notes or thumbnails.
export function ControllerStack({
  pdf,
  currentSlide,
  totalSlides,
  currentCanvasRef,
}: {
  pdf: PDFDocumentProxy;
  currentSlide: number;
  totalSlides: number;
  currentCanvasRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="flex-1 flex flex-col gap-2 p-3 min-h-0">
      <div className="flex-3 flex flex-col gap-1 min-h-0">
        <p className="text-xs text-muted-foreground font-medium">Current</p>
        <div
          ref={currentCanvasRef}
          className="flex-1 border rounded-lg overflow-hidden bg-white min-h-0"
        />
      </div>
      <div className="flex-2 flex flex-col gap-1 min-h-0">
        <p className="text-xs text-muted-foreground font-medium">Next</p>
        <NextSlideCard pdf={pdf} currentSlide={currentSlide} totalSlides={totalSlides} />
      </div>
    </div>
  );
}
