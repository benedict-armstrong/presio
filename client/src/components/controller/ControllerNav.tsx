import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Previous / [count] / Next cluster, shared by both controller footers. Desktop
// uses the inline default size with the slide count between the buttons; mobile
// uses the large, full-width variant and renders the count separately above.
export function ControllerNav({
  currentSlide,
  totalSlides,
  onGoTo,
  size = "default",
  showCount = true,
  className,
}: {
  currentSlide: number;
  totalSlides: number;
  onGoTo: (slide: number) => void;
  size?: "default" | "lg";
  showCount?: boolean;
  className?: string;
}) {
  const big = size === "lg";
  const buttonClass = big ? "flex-1 h-12 text-base" : undefined;
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Button
        variant="outline"
        className={buttonClass}
        onClick={() => onGoTo(currentSlide - 1)}
        disabled={currentSlide <= 1}
      >
        Previous
      </Button>
      {showCount && (
        <span className="text-sm font-medium tabular-nums">
          {currentSlide} / {totalSlides}
        </span>
      )}
      <Button
        variant="outline"
        className={buttonClass}
        onClick={() => onGoTo(currentSlide + 1)}
        disabled={currentSlide >= totalSlides}
      >
        Next
      </Button>
    </div>
  );
}
