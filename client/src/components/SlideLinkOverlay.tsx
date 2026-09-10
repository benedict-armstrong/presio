import type { SlideLink } from "@/lib/pdfLinks";
import { useContainedCanvasRect } from "@/hooks/useContainedCanvasRect";

/**
 * Clickable regions for the PDF's link annotations, laid over the rendered
 * slide canvas. The canvas is `object-fit: contain`, so the page can letterbox
 * inside its container — the hook gives us where it actually landed.
 *
 * Deliberately invisible: the link's appearance is already painted into the
 * page by the deck itself, so this only restores the hit area. A focus ring is
 * kept for keyboard users, who otherwise have no way to see where they are.
 */
export function SlideLinkOverlay({
  canvasContainerRef,
  links,
  onGoTo,
  enabled = true,
}: {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  links: SlideLink[];
  onGoTo: (slide: number) => void;
  /** False while a drawing tool is active, so a stroke is never eaten by a link. */
  enabled?: boolean;
}) {
  const rect = useContainedCanvasRect(canvasContainerRef, links);

  if (!enabled || !links.length || rect.width === 0) return null;

  return (
    <div
      data-testid="slide-link-overlay"
      className="absolute z-[4]"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {links.map((link) => {
        const style = {
          left: `${link.xPct * 100}%`,
          top: `${link.yPct * 100}%`,
          width: `${link.wPct * 100}%`,
          height: `${link.hPct * 100}%`,
        };
        const className =
          "absolute rounded-[2px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500";

        if (link.url) {
          return (
            <a
              key={link.id}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className={className}
              style={style}
              title={link.url}
            />
          );
        }
        return (
          <button
            key={link.id}
            type="button"
            onClick={() => onGoTo(link.slide!)}
            className={className}
            style={style}
            title={`Go to slide ${link.slide}`}
            aria-label={`Go to slide ${link.slide}`}
          />
        );
      })}
    </div>
  );
}
