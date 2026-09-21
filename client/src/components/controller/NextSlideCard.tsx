import { useEffect, useRef } from "react";
import { renderPage } from "@/lib/pdf";
import { useRenderTargetWidth } from "@/hooks/useRenderTargetWidth";
import type { Deck } from "@/lib/deck";
import { AnnotationOverlay } from "@/components/AnnotationOverlay";
import { MediaPosterOverlay } from "@/components/MediaPosterOverlay";

export function NextSlideCard({
  deck,
  currentSlide,
}: {
  deck: Deck;
  currentSlide: number;
}) {
  const { pdf, totalSlides } = deck;
  const containerRef = useRef<HTMLDivElement>(null);

  // Tracks the resolution this canvas should be rendered at — container size
  // and device pixel ratio both, so browser zoom and a move to a differently
  // scaled monitor re-render rather than upscale.
  const width = useRenderTargetWidth(containerRef);

  useEffect(() => {
    if (!containerRef.current || !width) return;
    const container = containerRef.current;
    if (currentSlide < totalSlides) {
      // Renders resolve out of order (cache hits are near-instant); drop any
      // that finish after the effect has moved to another slide.
      let stale = false;
      // Same rule as the current slide: render at the container's real pixel
      // size so the preview isn't an upscaled fixed-size canvas on HiDPI.
      const targetWidth = width;
      renderPage(pdf, currentSlide + 1, { targetWidth }).then((canvas) => {
        if (stale) return;
        container.innerHTML = "";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.objectFit = "contain";
        container.appendChild(canvas);
      });
      return () => { stale = true; };
    } else {
      container.innerHTML =
        '<div class="flex items-center justify-center h-full text-muted-foreground text-sm">End of presentation</div>';
    }
  }, [pdf, currentSlide, totalSlides, width]);

  const nextStrokes = deck.annotations[currentSlide + 1];
  // An embed bakes only its watch URL into the page, so without a poster this
  // card shows a raw youtube.com/watch?v=… line where the thumbnail strip
  // shows the real preview (#94).
  const nextMedia =
    currentSlide < totalSlides ? deck.mediaBySlide.get(currentSlide + 1) : undefined;

  return (
    <div className="h-full relative rounded overflow-hidden bg-white">
      <div ref={containerRef} className="absolute inset-0" />
      {!!nextMedia?.length && (
        <MediaPosterOverlay canvasContainerRef={containerRef} placements={nextMedia} />
      )}
      {!!nextStrokes?.length && (
        <AnnotationOverlay containerRef={containerRef} strokes={nextStrokes} />
      )}
    </div>
  );
}
