import { useEffect, useState } from "react";
import type { MediaPlacement } from "@/lib/pdf";
import { getMediaPoster } from "@/lib/mediaPoster";
import { useContainedCanvasRect } from "@/hooks/useContainedCanvasRect";

// A static preview image for media that has no frame baked into the PDF page
// (YouTube/Vimeo embeds, gifs) — without it those boxes show whatever the PDF
// baked in, which for an embed is the raw watch URL. Positioned in page
// fractions, so it only lines up inside a box matching the page exactly.
export function MediaPoster({ placement }: { placement: MediaPlacement }) {
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

// Posters for a whole slide, aligned to a `contain`-fitted canvas. Use this
// where the container can letterbox the page (the Next Slide card); the
// thumbnail strip sizes each box to the page aspect and uses MediaPoster
// directly.
export function MediaPosterOverlay({
  canvasContainerRef,
  placements,
}: {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  placements: MediaPlacement[];
}) {
  const rect = useContainedCanvasRect(canvasContainerRef, placements);

  if (!placements.length || rect.width === 0) return null;
  return (
    <div
      className="absolute pointer-events-none"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {placements.map((p) => (
        <MediaPoster key={p.id} placement={p} />
      ))}
    </div>
  );
}
