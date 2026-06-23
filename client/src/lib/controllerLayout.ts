// Controller dashboard card layout: configuration + persistence.
//
// The controller is a draggable/resizable grid of cards (current slide, next
// slide, timer, notes, thumbnails). This module owns the card catalog, the
// grid constants, and the localStorage load/merge/save logic so the view
// component only deals with React state.

import { lsGet, lsSet, STORAGE_KEYS } from "./storage";

export interface CardLayout {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

interface CardConfig {
  key: string;
  label: string;
  preferredLayout: CardLayout;
}

export const GRID_ROWS = 12;
export const GRID_MARGIN = 12;

const CARD_CONFIGS: CardConfig[] = [
  { key: "currentSlide", label: "Current Slide", preferredLayout: { i: "currentSlide", x: 0, y: 0, w: 6, h: 8, minW: 4, minH: 3 } },
  { key: "nextSlide", label: "Next Slide", preferredLayout: { i: "nextSlide", x: 6, y: 0, w: 4, h: 5, minW: 3, minH: 3 } },
  { key: "timer", label: "Timer", preferredLayout: { i: "timer", x: 10, y: 0, w: 2, h: 5, minW: 2, minH: 2 } },
  { key: "notes", label: "Speaker Notes", preferredLayout: { i: "notes", x: 6, y: 5, w: 6, h: 3, minW: 3, minH: 2 } },
  { key: "thumbnails", label: "Thumbnails", preferredLayout: { i: "thumbnails", x: 0, y: 8, w: 12, h: 4, minW: 4, minH: 2 } },
];

export const CARD_KEYS = CARD_CONFIGS.map((c) => c.key);
export const CARD_LABELS = Object.fromEntries(CARD_CONFIGS.map((c) => [c.key, c.label]));
export const PREFERRED_LAYOUTS: Record<string, CardLayout> =
  Object.fromEntries(CARD_CONFIGS.map((c) => [c.key, c.preferredLayout])) as Record<string, CardLayout>;
export const DEFAULT_LAYOUTS: CardLayout[] = CARD_CONFIGS.map((c) => c.preferredLayout);

/** Project a saved layout onto the known cards, in canonical order, re-applying
 *  the (non-persisted) min size constraints from the preferred layout. Unknown
 *  or missing cards fall back to their preferred placement. */
export function mergeLayout(saved: CardLayout[]): CardLayout[] {
  return CARD_KEYS.map((key) => {
    const s = saved.find((l) => l.i === key);
    const pref = PREFERRED_LAYOUTS[key];
    return s ? { ...s, minW: pref.minW, minH: pref.minH } : pref;
  });
}

export function defaultVisibility(): Record<string, boolean> {
  return Object.fromEntries(CARD_KEYS.map((k) => [k, true]));
}

export function loadLayout(): CardLayout[] {
  const saved = lsGet<CardLayout[] | null>(STORAGE_KEYS.controllerLayout, null);
  return saved ? mergeLayout(saved) : DEFAULT_LAYOUTS;
}

export function loadVisibility(): Record<string, boolean> {
  return lsGet<Record<string, boolean>>(STORAGE_KEYS.controllerCards, defaultVisibility());
}

export function saveLayout(layouts: CardLayout[]) {
  lsSet(STORAGE_KEYS.controllerLayout, layouts);
}

export function saveVisibility(vis: Record<string, boolean>) {
  lsSet(STORAGE_KEYS.controllerCards, vis);
}

export function savePreferred(layouts: CardLayout[], vis: Record<string, boolean>) {
  lsSet(STORAGE_KEYS.preferredLayout, layouts);
  lsSet(STORAGE_KEYS.preferredCards, vis);
}

export function hasPreferredLayout(): boolean {
  return lsGet<CardLayout[] | null>(STORAGE_KEYS.preferredLayout, null) !== null;
}

/** Load the user's saved "preferred" layout, or null if none is stored. */
export function loadPreferred(): { layouts: CardLayout[]; visibility: Record<string, boolean> } | null {
  const savedLayout = lsGet<CardLayout[] | null>(STORAGE_KEYS.preferredLayout, null);
  const savedCards = lsGet<Record<string, boolean> | null>(STORAGE_KEYS.preferredCards, null);
  if (!savedLayout || !savedCards) return null;
  return { layouts: mergeLayout(savedLayout), visibility: savedCards };
}
