import type { PdfLink } from "@/lib/pdfLinks";
import { useContainedCanvasRect } from "@/hooks/useContainedCanvasRect";

/** Clickable regions for the current slide's link annotations.
 *
 *  External links open in a new tab. Internal links call `onGoToSlide`, which
 *  the caller wires to whatever navigation that side is allowed: the
 *  controller drives the whole session, a viewer moves only itself. Pass no
 *  handler and internal links are skipped rather than rendered dead — that is
 *  the case for a local viewer, which always mirrors the controller.
 */
export function LinkOverlay({
  canvasContainerRef,
  links,
  onGoToSlide,
  enabled = true,
}: {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  links: PdfLink[];
  onGoToSlide?: (slide: number) => void;
  /** False while a drawing tool is active, so a stroke is never eaten by a
   *  link. Explicit rather than relying on the annotation layer's z-index,
   *  which would break silently if those values ever moved. */
  enabled?: boolean;
}) {
  const rect = useContainedCanvasRect(canvasContainerRef, links);

  const usable = links.filter((l) => l.url || (l.slide && onGoToSlide));
  if (!enabled || !usable.length || rect.width === 0) return null;

  return (
    // Below the annotation layer (z-5) as a second line of defence; `enabled`
    // is the one that actually decides.
    <div
      className="absolute z-[4] pointer-events-none"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {usable.map((link) => {
        const style = {
          left: `${link.xPct * 100}%`,
          top: `${link.yPct * 100}%`,
          width: `${link.wPct * 100}%`,
          height: `${link.hPct * 100}%`,
        };
        // Invisible until hovered: the PDF already draws whatever styling the
        // author gave the link, so a permanent box would double it up.
        const className =
          "absolute pointer-events-auto cursor-pointer rounded-[2px] transition-colors hover:bg-(--home2-accent)/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--home2-accent)";

        if (link.url) {
          return (
            <a
              key={link.id}
              data-testid="slide-link"
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title={link.url}
              className={className}
              style={style}
            />
          );
        }
        return (
          <button
            key={link.id}
            data-testid="slide-link"
            data-slide={link.slide}
            type="button"
            title={`Go to slide ${link.slide}`}
            aria-label={`Go to slide ${link.slide}`}
            className={className}
            style={style}
            onClick={() => onGoToSlide?.(link.slide!)}
          />
        );
      })}
    </div>
  );
}
