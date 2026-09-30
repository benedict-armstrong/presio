// The lasso: drawing a loop selects the strokes mostly inside it; the
// selection's box then moves them (dragged inside), scales them (by a corner)
// or deletes them. A move shows as it's dragged and is committed once, on
// release.

import { commitAll, eraseOps, moveOps, strokes, transformStroke, type DrawingHistory, type Transform } from "./model";
import { lassoContains, strokesBounds, type Bounds } from "./geometry";
import { toPage, type Layers, type PageBox } from "./layers";

export class Lasso {
  private history: DrawingHistory;
  private page: PageBox;
  private layers: Layers;
  private slide: () => number;
  /** Whether the selection is shown (the lasso is the tool). */
  private shown: () => boolean;
  private loop: number[] | null = null;
  selected: Set<string> | null = null;
  private dragging: { corner: string | null; from: [number, number]; box: Bounds } | null = null;
  /** The selection while it's dragged: drawn moved, not yet committed. */
  preview: { ids: Set<string>; m: Transform } | null = null;

  constructor(history: DrawingHistory, page: PageBox, layers: Layers, slide: () => number, shown: () => boolean) {
    this.history = history;
    this.page = page;
    this.layers = layers;
    this.slide = slide;
    this.shown = shown;
    layers.deleteBtn.onclick = () => {
      if (this.selected) commitAll(history, eraseOps(slide(), [...this.selected]));
      this.clear();
    };
  }

  get looping() {
    return !!this.loop;
  }

  get dragged() {
    return !!this.dragging;
  }

  private selectedStrokes() {
    return strokes(this.history.state, this.slide()).filter((st) => this.selected!.has(st.id));
  }

  /** The selection's box, over the strokes it holds. */
  place() {
    const { selectionEl } = this.layers;
    if (!this.selected || !this.shown()) {
      selectionEl.hidden = true;
      return;
    }
    let list = this.selectedStrokes();
    if (!list.length) {
      this.selected = null;
      selectionEl.hidden = true;
      return;
    }
    if (this.preview) list = list.map((st) => transformStroke(st, this.preview!.m));
    const b = strokesBounds(list, this.page.w / this.page.h)!;
    selectionEl.hidden = false;
    Object.assign(selectionEl.style, {
      left: `${b.minX * 100}%`,
      top: `${b.minY * 100}%`,
      width: `${(b.maxX - b.minX) * 100}%`,
      height: `${(b.maxY - b.minY) * 100}%`,
    });
  }

  clear() {
    this.selected = null;
    this.dragging = null;
    this.preview = null;
    this.place();
  }

  private drawLoop() {
    const loop = this.loop;
    this.layers.lassoPath.setAttribute("d", loop && loop.length >= 2 ? `M${loop.map((n, i) => (i % 2 ? `${n}` : `${i ? "L" : ""}${n}`)).join(" ")}Z` : "");
  }

  startLoop(e: PointerEvent) {
    this.clear();
    this.loop = toPage(this.page, e);
    this.drawLoop();
  }

  extendLoop(samples: PointerEvent[]) {
    for (const c of samples) this.loop!.push(...toPage(this.page, c));
    this.drawLoop();
  }

  cancelLoop() {
    this.loop = null;
    this.drawLoop();
  }

  /** The loop closed: select what's inside it. */
  closeLoop() {
    const poly = this.loop!;
    this.cancelLoop();
    const hit = strokes(this.history.state, this.slide()).filter((st) => lassoContains(poly, st));
    this.selected = hit.length ? new Set(hit.map((st) => st.id)) : null;
    this.place();
  }

  startDrag(e: PointerEvent) {
    const corner = (e.target as HTMLElement).dataset?.corner ?? null;
    const box = strokesBounds(this.selectedStrokes(), this.page.w / this.page.h)!;
    this.dragging = { corner, from: toPage(this.page, e) as [number, number], box };
  }

  drag(e: PointerEvent) {
    this.preview = { ids: this.selected!, m: this.transform(e) };
  }

  /**
   * The drag over: committed where it was let go (`commit`), else dropped.
   * Whether the selection's strokes need drawing again where they were.
   */
  endDrag(commit: boolean) {
    const m = this.preview?.m;
    this.dragging = null;
    this.preview = null;
    const moved = m && (m[0] !== 1 || m[1] !== 0 || m[2] !== 0);
    if (moved && commit) {
      commitAll(this.history, moveOps(this.slide(), [...this.selected!], m));
      return false;
    }
    return true;
  }

  private transform(e: PointerEvent): Transform {
    const d = this.dragging!;
    const { w, h } = this.page;
    const [x, y] = toPage(this.page, e);
    if (!d.corner) return [1, x - d.from[0], y - d.from[1], 0, 0];
    // Scaled about the opposite corner, as far as the pointer is along the diagonal.
    const { minX, minY, maxX, maxY } = d.box;
    const ax = d.corner.includes("w") ? maxX : minX;
    const ay = d.corner.includes("n") ? maxY : minY;
    const cx = (d.corner.includes("w") ? minX : maxX) - ax;
    const cy = (d.corner.includes("n") ? minY : maxY) - ay;
    const px = (x - ax) * w;
    const py = (y - ay) * h;
    const len2 = (cx * w) ** 2 + (cy * h) ** 2 || 1;
    const k = Math.min(20, Math.max(0.1, (px * cx * w + py * cy * h) / len2));
    return [k, 0, 0, ax, ay];
  }
}
