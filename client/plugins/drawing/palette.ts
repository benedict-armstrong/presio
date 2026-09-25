// The presenter's tool palette, drawn on their current slide.
//
// Movable by its grip, and turned on its side by double-clicking it. With a
// drawing tool active a second panel offers that tool's colors and widths,
// and undo and clear; clicking the active tool
// again tucks that panel away. While a tool is in use and the pointer is away
// from the palette, it collapses to the grip and the active tool, so it stays
// out of the slide; and with the mouse off the slide altogether it fades out.
// It keeps its size and place on screen when the presenter pinches in.

import { icon } from "./icons";
import type { Tool } from "./model";

export const PEN_COLORS = ["#111111", "#e11d48", "#2563eb", "#16a34a", "#f59e0b", "#9333ea"];
export const HIGHLIGHTER_COLORS = ["#facc15", "#a3e635", "#22d3ee", "#f472b6", "#fb923c", "#c084fc"];
const PEN_SIZES = [2, 3, 5, 8];
const HIGHLIGHTER_SIZES = [8, 14, 20, 28];

const TOOLS: { key: Tool; icon: string; label: string }[] = [
  { key: "none", icon: "pointer", label: "Pointer (no tool)" },
  { key: "laser", icon: "laser", label: "Laser pointer" },
  { key: "pen", icon: "pen", label: "Draw" },
  { key: "highlighter", icon: "highlighter", label: "Highlight" },
];

export interface PenStyle {
  color: string;
  size: number;
}

export interface PaletteActions {
  tool(): Tool;
  setTool(tool: Tool): void;
  style(tool: "pen" | "highlighter"): PenStyle;
  setStyle(tool: "pen" | "highlighter", style: Partial<PenStyle>): void;
  /** Whether the current slide has anything to undo or clear. */
  canUndo(): boolean;
  undo(): void;
  clear(): void;
  /** The palette moved or changed shape: where it takes input changed. */
  changed(): void;
}

export class Palette {
  readonly el = document.createElement("div");
  private tools = document.createElement("div");
  private options: HTMLElement | null = null;
  private optionsOpen = true;
  // Expanded while the mouse is on it, or "pinned" open: the touch path,
  // where there's no hover. Picking a tool pins it so it survives the finger
  // lifting; touching anywhere else (starting to draw) unpins it.
  private hovered = false;
  private pinned = false;
  private horizontal = false;
  /** Offset from the visible area's top-left, in screen pixels. */
  private pos = { x: 8, y: 8 };
  private view = { x: 0, y: 0, w: 1, h: 1, scale: 1 };
  private drag: { x: number; y: number; px: number; py: number } | null = null;

  private actions: PaletteActions;

  constructor(parent: HTMLElement, actions: PaletteActions) {
    this.actions = actions;
    this.el.className = "palette";
    this.tools.className = "panel tools";
    this.el.append(this.tools);
    this.el.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") this.setHovered(true);
    });
    this.el.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      this.pinned = false;
      this.setHovered(false);
    });
    // A click that reached the palette while the frame wasn't taking input
    // (Presio forwards those) leaves no pointerleave behind: a mouse seen
    // anywhere else on the slide has left it all the same.
    document.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse" || this.el.contains(e.target as Node) || (!this.pinned && !this.hovered)) return;
      this.pinned = false;
      this.setHovered(false);
      this.render();
    });
    document.addEventListener("pointerdown", (e) => {
      if (this.pinned && !this.el.contains(e.target as Node)) {
        this.pinned = false;
        this.render();
      }
    });
    parent.append(this.el);
    this.render();
  }

  private setHovered(hovered: boolean) {
    if (this.hovered === hovered) return;
    this.hovered = hovered;
    this.render();
  }

  setDimmed(dimmed: boolean) {
    this.el.classList.toggle("dimmed", dimmed);
  }

  setView(view: { x: number; y: number; w: number; h: number; scale: number }) {
    this.view = view;
    this.place();
  }

  /** The palette's box, as page fractions. */
  region() {
    const r = this.el.getBoundingClientRect();
    return { x: r.left / innerWidth, y: r.top / innerHeight, w: r.width / innerWidth, h: r.height / innerHeight };
  }

  private place() {
    const { x, y, w, h, scale } = this.view;
    // Kept inside what's on screen, at screen size.
    const maxX = Math.max(0, w * innerWidth * scale - this.el.offsetWidth);
    const maxY = Math.max(0, h * innerHeight * scale - this.el.offsetHeight);
    const px = Math.min(Math.max(0, this.pos.x), maxX);
    const py = Math.min(Math.max(0, this.pos.y), maxY);
    this.el.style.transform = `translate(${x * innerWidth + px / scale}px, ${y * innerHeight + py / scale}px) scale(${1 / scale})`;
    this.actions.changed();
  }

  render() {
    const tool = this.actions.tool();
    const drawing = tool === "pen" || tool === "highlighter";
    const expanded = tool === "none" || this.hovered || this.pinned;
    this.el.classList.toggle("horizontal", this.horizontal);

    const grip = document.createElement("div");
    grip.className = "grip";
    grip.title = "Drag to move — double-click to turn the palette on its side";
    grip.dataset.testid = "toolbar-drag";
    grip.innerHTML = icon(this.horizontal ? "gripV" : "gripH");
    grip.onpointerdown = (e) => {
      if (!e.isPrimary) return;
      grip.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, px: this.pos.x, py: this.pos.y };
    };
    grip.onpointermove = (e) => {
      if (!this.drag) return;
      const s = this.view.scale;
      this.pos = { x: this.drag.px + (e.clientX - this.drag.x) * s, y: this.drag.py + (e.clientY - this.drag.y) * s };
      this.place();
    };
    grip.onpointerup = grip.onpointercancel = () => {
      if (!this.drag) return;
      this.drag = null;
      // Remember where it was actually drawn, not where the pointer strayed to.
      const maxX = Math.max(0, this.view.w * innerWidth * this.view.scale - this.el.offsetWidth);
      const maxY = Math.max(0, this.view.h * innerHeight * this.view.scale - this.el.offsetHeight);
      this.pos = { x: Math.min(Math.max(0, this.pos.x), maxX), y: Math.min(Math.max(0, this.pos.y), maxY) };
    };
    grip.ondblclick = () => {
      this.horizontal = !this.horizontal;
      this.render();
    };

    const buttons = expanded
      ? TOOLS.map((t) => this.button(t.icon, t.label, `tool-${t.key}`, () => this.select(t.key), tool === t.key))
      : [
          this.button(
            TOOLS.find((t) => t.key === tool)!.icon,
            `${TOOLS.find((t) => t.key === tool)!.label} — tap to show all tools`,
            "tool-collapsed",
            () => {
              this.pinned = true;
              this.render();
            },
            true
          ),
        ];
    this.tools.replaceChildren(grip, ...buttons);

    this.options?.remove();
    this.options = null;
    if (drawing && expanded && this.optionsOpen) {
      this.options = this.renderOptions(tool);
      this.el.append(this.options);
    }
    this.place();
  }

  private select(key: Tool) {
    const tool = this.actions.tool();
    if (key === tool) {
      // Re-clicking the active drawing tool tucks its options away, or back.
      if (tool === "pen" || tool === "highlighter") {
        this.optionsOpen = !this.optionsOpen;
        this.render();
      }
      return;
    }
    this.optionsOpen = true;
    // Kept open so a color or width can be picked next; it collapses once the
    // slide (or anything else) is touched.
    this.pinned = true;
    this.actions.setTool(key);
  }

  private button(name: string, title: string, testid: string, onClick: () => void, on = false, disabled = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = on ? "btn on" : "btn";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.setAttribute("aria-pressed", String(on));
    b.dataset.testid = testid;
    b.disabled = disabled;
    b.innerHTML = icon(name);
    b.onclick = onClick;
    return b;
  }

  private renderOptions(tool: "pen" | "highlighter") {
    const style = this.actions.style(tool);
    const panel = document.createElement("div");
    panel.className = "panel options";
    panel.dataset.testid = "pen-options";

    const colors = document.createElement("div");
    colors.className = "colors";
    for (const color of tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = style.color === color ? "color on" : "color";
      b.title = color;
      b.dataset.testid = `pen-color-${color.slice(1)}`;
      b.style.backgroundColor = color;
      b.onclick = () => this.actions.setStyle(tool, { color });
      colors.append(b);
    }

    const sizes = document.createElement("div");
    sizes.className = "sizes";
    for (const px of tool === "highlighter" ? HIGHLIGHTER_SIZES : PEN_SIZES) {
      const b = document.createElement("button");
      b.type = "button";
      const on = Math.abs(style.size - px) < 0.05;
      b.className = on ? "size on" : "size";
      b.title = `${px}px line`;
      b.dataset.testid = `pen-size-${px}`;
      b.setAttribute("aria-pressed", String(on));
      const dot = document.createElement("span");
      const d = Math.min(18, Math.max(3, px * 1.2));
      dot.style.width = dot.style.height = `${d}px`;
      b.append(dot);
      b.onclick = () => this.actions.setStyle(tool, { size: px });
      sizes.append(b);
    }

    const canUndo = this.actions.canUndo();
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      this.button("undo", "Undo last stroke", "pen-undo", () => this.actions.undo(), false, !canUndo),
      this.button("trash", "Clear drawings on this slide", "pen-clear", () => this.actions.clear(), false, !canUndo)
    );

    panel.append(colors, sizes, actions);
    return panel;
  }
}
