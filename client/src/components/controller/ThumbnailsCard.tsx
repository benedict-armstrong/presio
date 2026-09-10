import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
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
  // The page aspect, tagged with the document it came from, so a swapped deck is
  // never measured against the previous page shape. A null ratio means settled
  // but unknown (page one wouldn't load), which keeps the min-width-only box.
  const [aspect, setAspect] = useState<{ pdf: PDFDocumentProxy; ratio: number | null } | null>(null);
  const aspectSettled = aspect?.pdf === pdf;
  const aspectRatio = aspectSettled ? aspect.ratio : null;

  useEffect(() => {
    let cancelled = false;
    pdf.getPage(1)
      .then((page) => {
        if (cancelled) return;
        const vp = page.getViewport({ scale: 1 });
        setAspect({ pdf, ratio: vp.width / vp.height });
      })
      .catch(() => {
        if (!cancelled) setAspect({ pdf, ratio: null });
      });
    return () => { cancelled = true; };
  }, [pdf]);

  useEffect(() => {
    // A swapped document (notes edit, deck replace) invalidates every rendered
    // thumbnail: drop the old canvases so the observer below re-renders them
    // from the new document instead of keeping whatever was on screen.
    thumbRefs.current.forEach((el) => {
      el.innerHTML = "";
    });
    // The aspect ratio decides a thumb's final width, so measuring one before
    // it settles would size the canvas off the bare 80px placeholder box.
    if (!aspectSettled) return;
    const dpr = window.devicePixelRatio || 1;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const el = entry.target as HTMLDivElement;
          const pageNum = Number(el.dataset.page);
          if (!pageNum) return;
          // Render at the thumb's own on-screen size rather than a fixed scale,
          // so a tall strip or a high-DPI screen gets a sharp thumbnail.
          const targetWidth = Math.round(el.clientWidth * dpr);
          renderPage(pdf, pageNum, { targetWidth, minScale: 0.5 }).then((canvas) => {
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
  }, [pdf, totalSlides, aspectSettled]);

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
