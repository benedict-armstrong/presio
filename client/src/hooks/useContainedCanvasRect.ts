import { useEffect, useState } from "react";
import { containedRect, EMPTY_RECT, type Rect } from "@/lib/containedRect";

/**
 * The content rect of the `<canvas>` inside `containerRef`. The canvas renders
 * with `object-fit: contain`, so it sits letterboxed whenever the container's
 * aspect ratio differs from the page's. Kept current as the container resizes
 * and as the canvas is swapped on slide change; `resetKey` forces a re-measure
 * when the caller's own inputs change.
 */
export function useContainedCanvasRect(
  containerRef: React.RefObject<HTMLElement | null>,
  resetKey?: unknown
): Rect {
  const [rect, setRect] = useState<Rect>(EMPTY_RECT);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const canvas = container.querySelector("canvas");
      if (!canvas) {
        setRect(EMPTY_RECT);
        return;
      }
      setRect(
        containedRect(
          container.clientWidth,
          container.clientHeight,
          canvas.width,
          canvas.height
        )
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    // The canvas element is swapped on slide change; watch for child mutations.
    const mo = new MutationObserver(measure);
    mo.observe(container, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [containerRef, resetKey]);

  return rect;
}
