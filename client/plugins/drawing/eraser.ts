// The eraser: a drag takes out every stroke it touches, as one change (one
// undo). A mouse sees its reach as a ring.

import { commitAll, eraseOps, newGroup, strokes, type DrawingHistory } from "./model";
import { strokeHit } from "./geometry";
import { toPage, type PageBox } from "./layers";

// The eraser's reach (CSS pixels).
const ERASER_RADIUS_PX = 10;

export class Eraser {
  private history: DrawingHistory;
  private page: PageBox;
  private ring: HTMLElement;
  private slide: () => number;
  private erasing: { group: string; hit: Set<string> } | null = null;

  constructor(history: DrawingHistory, page: PageBox, ring: HTMLElement, slide: () => number) {
    this.history = history;
    this.page = page;
    this.ring = ring;
    this.slide = slide;
  }

  get active() {
    return !!this.erasing;
  }

  start(e: PointerEvent) {
    this.erasing = { group: newGroup(), hit: new Set() };
    this.at(e);
  }

  stop() {
    this.erasing = null;
  }

  at(e: PointerEvent) {
    const erasing = this.erasing;
    if (!erasing) return;
    const [x, y] = toPage(this.page, e);
    const slide = this.slide();
    const ids = strokes(this.history.state, slide)
      .filter((st) => !erasing.hit.has(st.id) && strokeHit(st, x, y, ERASER_RADIUS_PX, this.page.w, this.page.h))
      .map((st) => st.id);
    if (!ids.length) return;
    for (const id of ids) erasing.hit.add(id);
    commitAll(this.history, eraseOps(slide, ids, erasing.group));
  }

  /** The ring around the pointer, or none. */
  showRing(e: PointerEvent | null) {
    this.ring.hidden = !e;
    if (!e) return;
    const d = ERASER_RADIUS_PX * 2;
    Object.assign(this.ring.style, {
      width: `${d}px`,
      height: `${d}px`,
      transform: `translate(${e.clientX - this.page.x - d / 2}px, ${e.clientY - this.page.y - d / 2}px)`,
    });
  }
}
