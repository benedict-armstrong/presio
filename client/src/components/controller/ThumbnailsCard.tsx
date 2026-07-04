import { useEffect, useRef, useState } from "react";
import { renderPage, type MediaPlacement } from "@/lib/pdf";
import type { Deck } from "@/lib/deck";
import { drawStrokes, type Stroke } from "@/lib/annotations";
import { getMediaPoster } from "@/lib/mediaPoster";

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

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const pageNum = Number((entry.target as HTMLElement).dataset.page);
          if (!pageNum) return;
          renderPage(pdf, pageNum, 0.5).then((canvas) => {
            const el = entry.target as HTMLDivElement;
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
  }, [pdf, totalSlides]);

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
            ref={(el) => { if (el) thumbRefs.current.set(num, el); }}
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

// Overlays a static preview image for media that has no frame baked into the
// PDF page (YouTube/Vimeo embeds, gifs), positioned to match the live overlay.
function MediaPoster({ placement }: { placement: MediaPlacement }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMediaPoster(placement).then((url) => { if (!cancelled) setSrc(url); });
    return () => { cancelled = true; };
  }, [placement]);

  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      className="absolute object-cover pointer-events-none"
      style={{
        left: `${placement.xPct * 100}%`,
        top: `${placement.yPct * 100}%`,
        width: `${placement.wPct * 100}%`,
        height: `${placement.hPct * 100}%`,
      }}
    />
  );
}
