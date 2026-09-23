import { useEffect, useRef, useState } from "react";
import { MousePointer2, Target, PenLine, Highlighter, Undo2, Redo2, Trash2, Hand, Eraser, Lasso, ImagePlus, Circle, Spline, PenTool, GripHorizontal, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PEN_COLORS,
  HIGHLIGHTER_COLORS,
  PEN_REFERENCE_WIDTH,
  LASER_SIZES,
  type LaserStyle,
  type PenStyle,
  type Tool,
} from "@/lib/annotations";

const TOOLS: { key: Tool; icon: React.ComponentType<{ size?: number }>; label: string }[] = [
  { key: "none", icon: MousePointer2, label: "Pointer (no tool)" },
  { key: "laser", icon: Target, label: "Laser pointer" },
  { key: "pen", icon: PenLine, label: "Draw" },
  { key: "highlighter", icon: Highlighter, label: "Highlight" },
  { key: "eraser", icon: Eraser, label: "Erase" },
  { key: "lasso", icon: Lasso, label: "Select — drag to move, corner to resize" },
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
  canUndo: boolean;
  canRedo: boolean;
  /** Whether the current slide has strokes (enables clear). */
  canClear: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  /** Fade the palette out — the mouse has left the slide, so there is nothing
   *  to point at and the slide should be seen unobstructed. Never set on
   *  touch, where there is no such thing as a pointer that has left. */
  dimmed?: boolean;
  /** Pencil mode: only a stylus draws, fingers pan and zoom. */
  pencilMode?: boolean;
  onPencilModeChange?: (on: boolean) => void;
  /** Insert an image (clipboard, or a picker). */
  onInsertImage?: () => void;
  laserStyle?: LaserStyle;
  onLaserStyleChange?: (style: LaserStyle) => void;
}

// Floating tool palette shown over the controller's current slide, movable by
// its grip handle and turned on its side by double-clicking that handle. When a drawing tool is active, a second panel offers that
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
  canRedo,
  canClear,
  onUndo,
  onRedo,
  onClear,
  dimmed = false,
  pencilMode = false,
  onPencilModeChange,
  onInsertImage,
  laserStyle,
  onLaserStyleChange,
}: Props) {
  // Tools with an options panel; the eraser's only has the actions row.
  const drawing = tool === "pen" || tool === "highlighter" || tool === "eraser" || tool === "laser";
  const styled = tool === "pen" || tool === "highlighter";
  const colors = tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const sizes = tool === "highlighter" ? HIGHLIGHTER_SIZES : PEN_SIZES;

  // Options panel minimized state (toggled by re-clicking the active tool).
  const [optionsOpen, setOptionsOpen] = useState(true);
  // The palette expands while the mouse hovers it, or while "pinned" open —
  // the touch path, where there is no hover: picking a tool pins the palette
  // so it survives the finger lifting, touching anywhere else (e.g. starting
  // to draw) unpins it, and tapping the collapsed palette pins it again.
  // Hover state is mouse-only: on touch, pointerenter/leave fire on every tap
  // and would collapse the palette the moment the finger lifts.
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
    // Keep the palette open so a color/width can be picked next; it collapses
    // once the slide (or anything else outside) is touched.
    setPinnedOpen(true);
  };

  // Unpin when the user starts interacting anywhere outside the palette.
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPinnedOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, []);

  // Which way the palette runs. Double-clicking the grip lays it on its side,
  // which is what a wide, short slide card wants — the tools then sit along
  // the top edge instead of down the left.
  const [horizontal, setHorizontal] = useState(false);

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
      className={cn(
        // Only the panels take input: the wrapper spans the tallest panel, and
        // the empty space beside a shorter one must stay drawable.
        "absolute z-10 flex items-start gap-1 transition-opacity pointer-events-none [&>*]:pointer-events-auto",
        horizontal && "flex-col",
        // Faded, but still live: the mouse can only reach it by coming back
        // over the slide, which un-fades it on the way in. Leaving fades
        // gently — a palette that vanished the instant the mouse crossed the
        // edge would read as a glitch — while coming back is immediate.
        dimmed ? "opacity-0 duration-700 ease-out" : "duration-150"
      )}
      style={{ left: pos.x, top: pos.y }}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") {
          setHovered(false);
          setPinnedOpen(false);
        }
      }}
    >
      <div
        className={cn(
          "flex gap-0.5 rounded-md border bg-background/85 backdrop-blur p-0.5 shadow-sm",
          horizontal ? "flex-row items-center" : "flex-col"
        )}
      >
        <div
          title="Drag to move — double-click to turn the palette on its side"
          data-testid="toolbar-drag"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          onDoubleClick={() => setHorizontal((h) => !h)}
          className={cn(
            "flex items-center justify-center cursor-grab active:cursor-grabbing touch-none text-muted-foreground",
            horizontal ? "w-4 -mr-0.5 self-stretch" : "h-4 -mb-0.5"
          )}
        >
          {horizontal ? <GripVertical size={12} /> : <GripHorizontal size={12} />}
        </div>
        {expanded ? (
          <>
          {TOOLS.map(({ key, icon: Icon, label }) => (
            <IconButton
              key={key}
              title={label}
              active={tool === key}
              testId={`tool-${key}`}
              onClick={() => selectTool(key)}
            >
              <Icon size={15} />
            </IconButton>
          ))}
          {onPencilModeChange && (
            <IconButton
              title={
                pencilMode
                  ? "Pencil only: fingers pan and zoom. Tap to draw with pencil and finger"
                  : "Pencil and finger draw. Tap for pencil only"
              }
              onClick={() => onPencilModeChange(!pencilMode)}
              testId="pencil-mode"
            >
              {pencilMode ? <PenTool size={15} /> : <Hand size={15} />}
            </IconButton>
          )}
          <IconButton title="Undo (or double-tap with two fingers)" disabled={!canUndo} onClick={onUndo} testId="pen-undo">
            <Undo2 size={15} />
          </IconButton>
          <IconButton title="Redo" disabled={!canRedo} onClick={onRedo} testId="pen-redo">
            <Redo2 size={15} />
          </IconButton>
          {onInsertImage && (
            <IconButton title="Insert image (or paste with ⌘V)" onClick={onInsertImage} testId="tool-image">
              <ImagePlus size={15} />
            </IconButton>
          )}
          </>
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

      {tool === "laser" && expanded && optionsOpen && laserStyle && onLaserStyleChange && (
        <div
          data-testid="laser-options"
          className="flex flex-col gap-1.5 rounded-md border bg-background/85 backdrop-blur p-1.5 shadow-sm"
        >
          <div className="flex items-center gap-0.5">
            <IconButton
              title="Point"
              active={!laserStyle.trail}
              onClick={() => onLaserStyleChange({ ...laserStyle, trail: false })}
              testId="laser-mode-dot"
            >
              <Circle size={14} />
            </IconButton>
            <IconButton
              title="Fading line"
              active={laserStyle.trail}
              onClick={() => onLaserStyleChange({ ...laserStyle, trail: true })}
              testId="laser-mode-trail"
            >
              <Spline size={14} />
            </IconButton>
          </div>
          <div className="flex items-center justify-between gap-1 border-t pt-1">
            {LASER_SIZES.map((px) => {
              const size = px / PEN_REFERENCE_WIDTH;
              const active = Math.abs(laserStyle.size - size) < 0.0005;
              return (
                <button
                  key={px}
                  type="button"
                  title={`${px}px`}
                  data-testid={`laser-size-${px}`}
                  aria-pressed={active}
                  onClick={() => onLaserStyleChange({ ...laserStyle, size })}
                  className={cn(
                    "inline-flex items-center justify-center size-6 rounded transition-colors hover:bg-accent",
                    active && "bg-accent ring-1 ring-ring"
                  )}
                >
                  <span className="rounded-full bg-red-500" style={{ width: 3 + px / 2.5, height: 3 + px / 2.5 }} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {drawing && tool !== "laser" && expanded && optionsOpen && (
        <div
          data-testid="pen-options"
          className="flex flex-col gap-1.5 rounded-md border bg-background/85 backdrop-blur p-1.5 shadow-sm"
        >
          {styled && (<>
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
          </>)}
          <div className={cn("flex items-center gap-0.5", styled && "border-t pt-1")}>
            <IconButton title="Clear drawings on this slide" disabled={!canClear} onClick={onClear} testId="pen-clear">
              <Trash2 size={14} />
            </IconButton>

          </div>
        </div>
      )}
    </div>
  );
}
