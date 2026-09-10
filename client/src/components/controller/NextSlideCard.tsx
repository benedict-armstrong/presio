import { useEffect, useRef } from "react";
import { renderPage } from "@/lib/pdf";
import type { Deck } from "@/lib/deck";
import { AnnotationOverlay } from "@/components/AnnotationOverlay";
import { MediaPosterOverlay } from "@/components/MediaPosterOverlay";
import { useRenderTargetWidth } from "@/hooks/useRenderTargetWidth";

export function NextSlideCard({
  deck,
  currentSlide,
}: {
  deck: Deck;
  currentSlide: number;
}) {
  const { pdf, totalSlides } = deck;
  const containerRef = useRef<HTMLDivElement>(null);
  // Match the card's real pixel size instead of a fixed scale, which on a
  // high-DPI screen (or in a card the presenter has made large) was upscaled
  // and soft. Tracks resizes and DPI changes the same way the main slide does.
  const renderWidth = useRenderTargetWidth(containerRef);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    if (currentSlide < totalSlides) {
      // Renders resolve out of order (cache hits are near-instant); drop any
      // that finish after the effect has moved to another slide.
      let stale = false;
      renderPage(pdf, currentSlide + 1, { targetWidth: renderWidth, minScale: 1 }).then((canvas) => {
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
  }, [pdf, currentSlide, totalSlides, renderWidth]);

  const nextStrokes = deck.annotations[currentSlide + 1];
  // Embeds bake only their URL into the page, so preview them the way the
  // thumbnail strip does rather than showing the raw "youtube.com/watch?v=…".
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
