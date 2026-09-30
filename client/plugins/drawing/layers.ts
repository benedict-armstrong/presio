// The slide surface's elements: the canvases strokes are drawn on, the laser,
// the eraser's ring, the lasso's loop and selection, all inside the page.

import { icon } from "./icons";

export interface CanvasLayer {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export type Layers = ReturnType<typeof createLayers>;

export function createLayers(root: HTMLElement, presenter: boolean) {
  const canvas = (fast: boolean): CanvasLayer => {
    const c = document.createElement("canvas");
    // A low-latency canvas for what's drawn under the pen: it can reach the
    // screen without waiting on the rest of the page.
    const ctx = c.getContext("2d", fast && presenter ? { desynchronized: true } : undefined)!;
    return { c, ctx };
  };
  const committed = canvas(false);
  const liveLayer = document.createElement("div");
  liveLayer.className = "live";
  const stable = canvas(true);
  const tip = canvas(true);
  liveLayer.append(stable.c, tip.c);
  const laserDot = document.createElement("div");
  laserDot.className = "laser";
  laserDot.dataset.testid = "laser-dot";
  laserDot.dataset.laser = presenter ? "local" : "remote";
  laserDot.hidden = true;
  const trailCanvas = document.createElement("canvas");
  trailCanvas.className = "laser-trail";
  const eraserRing = document.createElement("div");
  eraserRing.className = "eraser-ring";
  eraserRing.hidden = true;
  const lassoLoop = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  lassoLoop.classList.add("lasso-loop");
  lassoLoop.setAttribute("viewBox", "0 0 1 1");
  lassoLoop.setAttribute("preserveAspectRatio", "none");
  const lassoPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  lassoLoop.append(lassoPath);
  const selectionEl = document.createElement("div");
  selectionEl.className = "selection";
  selectionEl.dataset.testid = "lasso-selection";
  // A finger moves it even in pencil mode.
  selectionEl.dataset.control = "";
  selectionEl.hidden = true;
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const h = document.createElement("div");
    h.className = `handle ${corner}`;
    h.dataset.corner = corner;
    selectionEl.append(h);
  }
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn delete";
  deleteBtn.title = "Delete the selection";
  deleteBtn.dataset.testid = "lasso-delete";
  deleteBtn.innerHTML = icon("trash");
  selectionEl.append(deleteBtn);
  // The surface covers the whole slide area (the current slide card, a
  // viewer's screen), so the palette can sit anywhere on it; what's drawn
  // lives on the page within it, in page fractions.
  const pageEl = document.createElement("div");
  pageEl.className = "page";
  pageEl.append(committed.c, liveLayer, trailCanvas, lassoLoop, selectionEl, eraserRing, laserDot);
  root.append(pageEl);
  return { committed, liveLayer, stable, tip, laserDot, trailCanvas, eraserRing, lassoPath, selectionEl, deleteBtn, pageEl };
}

/** The page's box in the surface, in CSS pixels. */
export interface PageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a pointer is on the page, as fractions of it (clamped to it). */
export const toPage = (page: PageBox, e: PointerEvent) => [
  Math.min(1, Math.max(0, (e.clientX - page.x) / page.w)),
  Math.min(1, Math.max(0, (e.clientY - page.y) / page.h)),
];
