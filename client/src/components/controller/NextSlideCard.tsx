import { useEffect, useRef } from "react";
import { renderPage } from "@/lib/pdf";
import type { Deck } from "@/lib/deck";
import { AnnotationOverlay } from "@/components/AnnotationOverlay";

export function NextSlideCard({
  deck,
  currentSlide,
}: {
  deck: Deck;
  currentSlide: number;
}) {
  const { pdf, totalSlides } = deck;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    if (currentSlide < totalSlides) {
      renderPage(pdf, currentSlide + 1, 1).then((canvas) => {
        container.innerHTML = "";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.objectFit = "contain";
        container.appendChild(canvas);
      });
    } else {
      container.innerHTML =
        '<div class="flex items-center justify-center h-full text-muted-foreground text-sm">End of presentation</div>';
    }
  }, [pdf, currentSlide, totalSlides]);

  const nextStrokes = deck.annotations[currentSlide + 1];

  return (
    <div className="h-full relative rounded overflow-hidden bg-white">
      <div ref={containerRef} className="absolute inset-0" />
      {!!nextStrokes?.length && (
        <AnnotationOverlay containerRef={containerRef} strokes={nextStrokes} />
      )}
    </div>
  );
}
