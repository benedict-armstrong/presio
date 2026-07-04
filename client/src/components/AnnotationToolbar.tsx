import { MousePointer2, Target, PenLine, Highlighter, Undo2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PEN_COLORS, HIGHLIGHTER_COLORS, PEN_REFERENCE_WIDTH, type PenStyle, type Tool } from "@/lib/annotations";

const TOOLS: { key: Tool; icon: React.ComponentType<{ size?: number }>; label: string }[] = [
  { key: "none", icon: MousePointer2, label: "Pointer (no tool)" },
  { key: "laser", icon: Target, label: "Laser pointer" },
  { key: "pen", icon: PenLine, label: "Draw" },
  { key: "highlighter", icon: Highlighter, label: "Highlight" },
];

const PEN_SIZES = [2, 3, 5, 8];
const HIGHLIGHTER_SIZES = [8, 14, 20, 28];

function IconButton({
  title,
  active,
  disabled,
  onClick,
  children,
  testId,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center size-7 rounded transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent",
        disabled && "opacity-40 pointer-events-none"
      )}
    >
      {children}
    </button>
  );
}

interface Props {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  penStyle: PenStyle;
  onPenStyleChange: (style: PenStyle) => void;
  /** Whether the current slide has strokes (enables undo/clear). */
  canUndo: boolean;
  onUndo: () => void;
  onClear: () => void;
}

// Floating tool picker shown over the controller's current slide. When a
// drawing tool is active, a second panel offers that tool's colors/widths plus
// the undo/clear actions. Saving/loading drawings lives in Settings.
export function AnnotationToolbar({
  tool,
  onToolChange,
  penStyle,
  onPenStyleChange,
  canUndo,
  onUndo,
  onClear,
}: Props) {
  const drawing = tool === "pen" || tool === "highlighter";
  const colors = tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const sizes = tool === "highlighter" ? HIGHLIGHTER_SIZES : PEN_SIZES;

  return (
    <div className="absolute left-2 top-2 z-10 flex items-start gap-1">
      <div className="flex flex-col gap-0.5 rounded-md border bg-background/85 backdrop-blur p-0.5 shadow-sm">
        {TOOLS.map(({ key, icon: Icon, label }) => (
          <IconButton
            key={key}
            title={label}
            active={tool === key}
            testId={`tool-${key}`}
            onClick={() => onToolChange(key)}
          >
            <Icon size={15} />
          </IconButton>
        ))}
      </div>

      {drawing && (
        <div
          data-testid="pen-options"
          className="flex flex-col gap-1.5 rounded-md border bg-background/85 backdrop-blur p-1.5 shadow-sm"
        >
          <div className="grid grid-cols-3 gap-1">
            {colors.map((color) => (
              <button
                key={color}
                type="button"
                title={color}
                data-testid={`pen-color-${color.slice(1)}`}
                onClick={() => onPenStyleChange({ ...penStyle, color })}
                className={cn(
                  "size-5 rounded-full border border-black/10 transition-transform",
                  penStyle.color === color && "ring-2 ring-ring scale-110"
                )}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-1">
            {sizes.map((px) => {
              const size = px / PEN_REFERENCE_WIDTH;
              const active = Math.abs(penStyle.size - size) < 0.0005;
              return (
                <button
                  key={px}
                  type="button"
                  title={`${px}px line`}
                  data-testid={`pen-size-${px}`}
                  aria-pressed={active}
                  onClick={() => onPenStyleChange({ ...penStyle, size })}
                  className={cn(
                    "inline-flex items-center justify-center size-6 rounded transition-colors hover:bg-accent",
                    active && "bg-accent ring-1 ring-ring"
                  )}
                >
                  <span
                    className="rounded-full bg-foreground"
                    style={{
                      width: Math.min(18, Math.max(3, px * 1.2)),
                      height: Math.min(18, Math.max(3, px * 1.2)),
                    }}
                  />
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-0.5 border-t pt-1">
            <IconButton title="Undo last stroke" disabled={!canUndo} onClick={onUndo} testId="pen-undo">
              <Undo2 size={14} />
            </IconButton>
            <IconButton title="Clear drawings on this slide" disabled={!canUndo} onClick={onClear} testId="pen-clear">
              <Trash2 size={14} />
            </IconButton>
          </div>
        </div>
      )}
    </div>
  );
}
