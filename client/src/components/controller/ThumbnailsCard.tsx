import { useEffect, useRef, useState } from "react";
import { renderPage } from "@/lib/pdf";
import type { Deck } from "@/lib/deck";
import { drawStrokes, type Stroke } from "@/lib/annotations";
import { MediaPoster } from "@/components/MediaPosterOverlay";

export function ThumbnailsCard({
  deck,
  currentSlide,
  onGoTo,
}: {
  deck: Deck;
  currentSlide: number;
  onGoTo: (slide: number) => void;
}) {
  const { pdf, totalSlides, mediaBySlide } = deck;
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);

  useEffect(() => {
    pdf.getPage(1).then((page) => {
      const vp = page.getViewport({ scale: 1 });
      setAspectRatio(vp.width / vp.height);
    });
  }, [pdf]);

  // The canvas is rendered at the tile's pixel size, so a tile that grows would
  // otherwise keep showing the old, smaller canvas upscaled. Track the width
  // and let the render effect below re-run when it changes. Quantised to 32px
  // steps so dragging a mosaic divider re-renders a handful of times rather
  // than on every pixel.
  const [tileWidth, setTileWidth] = useState(0);
  useEffect(() => {
    // Wait for the page aspect ratio: until it lands the tiles are just their
    // 80px minWidth, so measuring now would render every thumbnail at that
    // size and — since the container itself never resizes when the tiles grow
    // — leave them upscaled for good.
    if (!aspectRatio) return;
    const tile = thumbRefs.current.values().next().value;
    if (!tile) return;
    const measure = () => {
      if (tile.clientWidth) setTileWidth(Math.ceil(tile.clientWidth / 32) * 32);
    };
    measure();
    // Observe a tile rather than the scroll container: the tile changes size
    // both when the pane is resized and when the aspect ratio arrives.
    const ro = new ResizeObserver(measure);
    ro.observe(tile);
    return () => ro.disconnect();
  }, [totalSlides, aspectRatio]);

  useEffect(() => {
    if (!tileWidth) return;
    // A swapped document (notes edit, deck replace) invalidates every rendered
    // thumbnail: drop the old canvases so the observer below re-renders them
    // from the new document instead of keeping whatever was on screen.
    thumbRefs.current.forEach((el) => {
      el.innerHTML = "";
    });
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const pageNum = Number((entry.target as HTMLElement).dataset.page);
          if (!pageNum) return;
          // Match the tile's real pixel size rather than a fixed multiplier:
          // `scale` is relative to PDF points, so a fixed one renders a beamer
          // deck half the size of a wide one and upscales on HiDPI either way.
          const el = entry.target as HTMLDivElement;
          const targetWidth = Math.round(tileWidth * (window.devicePixelRatio || 1));
          renderPage(pdf, pageNum, { targetWidth }).then((canvas) => {
            if (el.childElementCount > 0) return;
            canvas.style.width = "100%";
            canvas.style.height = "100%";
            canvas.style.objectFit = "contain";
            el.appendChild(canvas);
          });
          observer.unobserve(entry.target);
        });
      },
      { root: containerRef.current, threshold: 0.1 }
    );
    thumbRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pdf, totalSlides, tileWidth]);

  useEffect(() => {
    const el = thumbRefs.current.get(currentSlide);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [currentSlide]);

  return (
    <div
      ref={containerRef}
      className="flex gap-2 overflow-x-auto h-full items-start p-1"
    >
      {Array.from({ length: totalSlides }, (_, i) => i + 1).map((num) => (
        <button
          key={num}
          type="button"
          onClick={() => onGoTo(num)}
          className={`relative shrink-0 h-full rounded border overflow-hidden transition-all ${
            num === currentSlide
              ? "ring-2 ring-red-500 border-red-500"
              : "border-border hover:border-foreground/30"
          }`}
          style={aspectRatio ? { aspectRatio, minWidth: 80 } : { minWidth: 80 }}
        >
          <div
            ref={(el) => {
              if (el) thumbRefs.current.set(num, el);
              else thumbRefs.current.delete(num);
            }}
            data-page={num}
            className="w-full h-full"
          />
          {mediaBySlide.get(num)?.map((p) => (
            <MediaPoster key={p.id} placement={p} />
          ))}
          <ThumbStrokes strokes={deck.annotations[num]} />
        </button>
      ))}
    </div>
  );
}

// Paints the slide's drawings over its thumbnail. The thumb container matches
// the page's aspect ratio exactly (no letterboxing), so a full-size canvas in
// normalized coordinates lines up with the page.
function ThumbStrokes({ strokes }: { strokes?: readonly Stroke[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !strokes?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const box = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawStrokes(ctx, strokes, canvas.width, canvas.height);
  }, [strokes]);

  if (!strokes?.length) return null;
  return <canvas ref={ref} className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden />;
}
