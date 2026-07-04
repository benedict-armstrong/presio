import { useRef, useState } from "react";
import { MousePointer2, Target, PenLine, Highlighter, Undo2, Trash2, GripHorizontal } from "lucide-react";
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

// Floating tool palette shown over the controller's current slide, movable by
// its grip handle. When a drawing tool is active, a second panel offers that
// tool's colors/widths plus the undo/clear actions; clicking the active tool
// again minimizes that panel. While a tool is in use and the pointer is away
// from the toolbar, the whole palette collapses to just the grip and the
// active tool so it stays out of the slide. Saving/loading drawings lives in
// Settings.
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

  // Options panel minimized state (toggled by re-clicking the active tool).
  const [optionsOpen, setOptionsOpen] = useState(true);
  // Hover expands the collapsed palette; `pinnedOpen` does the same for touch,
  // where there is no hover — tapping the collapsed palette expands it until a
  // tool is chosen.
  const [hovered, setHovered] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);

  const expanded = tool === "none" || hovered || pinnedOpen;
  const activeTool = TOOLS.find((t) => t.key === tool) ?? TOOLS[0];
  const ActiveIcon = activeTool.icon;

  const selectTool = (key: Tool) => {
    if (key === tool) {
      // Re-clicking the active drawing tool tucks its options away / back.
      if (drawing) setOptionsOpen((open) => !open);
      return;
    }
    onToolChange(key);
    setOptionsOpen(true);
    setPinnedOpen(false);
  };

  // Position within the slide card (the offset parent), draggable by the grip.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: 8, y: 8 });
  // clientX/Y minus the palette position at drag start, so moves are relative.
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  };
  const onGripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = rootRef.current;
    const parent = el?.parentElement;
    if (!drag || !el || !parent) return;
    const clamp = (n: number, max: number) => Math.min(Math.max(0, n), Math.max(0, max));
    setPos({
      x: clamp(e.clientX - drag.dx, parent.clientWidth - el.offsetWidth),
      y: clamp(e.clientY - drag.dy, parent.clientHeight - el.offsetHeight),
    });
  };
  const onGripUp = () => {
    dragRef.current = null;
  };

  return (
    <div
      ref={rootRef}
      className="absolute z-10 flex items-start gap-1"
      style={{ left: pos.x, top: pos.y }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div className="flex flex-col gap-0.5 rounded-md border bg-background/85 backdrop-blur p-0.5 shadow-sm">
        <div
          title="Move toolbar"
          data-testid="toolbar-drag"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          className="flex items-center justify-center h-4 -mb-0.5 cursor-grab active:cursor-grabbing touch-none text-muted-foreground"
        >
          <GripHorizontal size={12} />
        </div>
        {expanded ? (
          TOOLS.map(({ key, icon: Icon, label }) => (
            <IconButton
              key={key}
              title={label}
              active={tool === key}
              testId={`tool-${key}`}
              onClick={() => selectTool(key)}
            >
              <Icon size={15} />
            </IconButton>
          ))
        ) : (
          <IconButton
            title={`${activeTool.label} — tap to show all tools`}
            active
            testId="tool-collapsed"
            onClick={() => setPinnedOpen(true)}
          >
            <ActiveIcon size={15} />
          </IconButton>
        )}
      </div>

      {drawing && expanded && optionsOpen && (
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
