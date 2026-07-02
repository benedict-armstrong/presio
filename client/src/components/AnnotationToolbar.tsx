import { MousePointer2, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tool } from "@/lib/annotations";

const TOOLS: { key: Tool; icon: React.ComponentType<{ size?: number }>; label: string }[] = [
  { key: "none", icon: MousePointer2, label: "Pointer (no tool)" },
  { key: "laser", icon: Target, label: "Laser pointer" },
];

// Floating tool picker shown over the controller's current slide.
export function AnnotationToolbar({
  tool,
  onToolChange,
}: {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
}) {
  return (
    <div className="absolute left-2 top-2 z-10 flex flex-col gap-0.5 rounded-md border bg-background/85 backdrop-blur p-0.5 shadow-sm">
      {TOOLS.map(({ key, icon: Icon, label }) => (
        <button
          key={key}
          type="button"
          title={label}
          aria-pressed={tool === key}
          data-testid={`tool-${key}`}
          onClick={() => onToolChange(key)}
          className={cn(
            "inline-flex items-center justify-center size-7 rounded transition-colors",
            tool === key
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-accent"
          )}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}
