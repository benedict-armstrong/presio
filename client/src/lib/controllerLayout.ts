// Controller dashboard card layout: configuration + persistence.
//
// The controller is a tiling window manager (react-mosaic) of cards: current
// slide, next slide, timer, notes, thumbnails. Cards always tile to fill the
// screen, so removing or resizing one makes its neighbours grow rather than
// leaving a hole. The layout is a tree (`MosaicNode`); a card is visible iff it
// appears as a leaf in that tree. This module owns the card catalog, the
// default tree, and the localStorage load/sanitize/save logic so the view
// component only deals with React state.
//
// react-mosaic v7 replaced the binary tree with an n-ary one: a parent is now
// `{ type: "split", direction, children[], splitPercentages[] }` rather than
// `{ direction, first, second, splitPercentage }`, paths are numeric indices
// instead of "first"/"second", and a parent can also be a tabs node. Layouts
// persisted by earlier versions are still in the binary shape, so sanitize()
// converts them on read — see legacy handling there.

import {
  getLeaves,
  createRemoveUpdate,
  updateTree,
  convertLegacyToNary,
  isSplitNode,
  isTabsNode,
} from "react-mosaic-component";
import type { MosaicNode, MosaicPath } from "react-mosaic-component";
import { lsGet, lsSet, STORAGE_KEYS } from "./storage";

interface CardConfig {
  key: string;
  label: string;
}

const CARD_CONFIGS: CardConfig[] = [
  { key: "currentSlide", label: "Current Slide" },
  { key: "nextSlide", label: "Next Slide" },
  { key: "timer", label: "Timer" },
  { key: "notes", label: "Speaker Notes" },
  { key: "thumbnails", label: "Thumbnails" },
];

export const CARD_KEYS = CARD_CONFIGS.map((c) => c.key);
export const CARD_LABELS: Record<string, string> = Object.fromEntries(
  CARD_CONFIGS.map((c) => [c.key, c.label]),
);

/** Default arrangement, mirroring the previous grid: current slide on the left,
 *  next slide + timer stacked over speaker notes on the right, thumbnails as a
 *  full-width strip along the bottom. `splitPercentages` gives each child's
 *  share in order, and must sum to 100. */
export const DEFAULT_LAYOUT: MosaicNode<string> = {
  type: "split",
  direction: "column",
  children: [
    {
      type: "split",
      direction: "row",
      children: [
        "currentSlide",
        {
          type: "split",
          direction: "column",
          children: [
            {
              type: "split",
              direction: "row",
              children: ["nextSlide", "timer"],
              splitPercentages: [65, 35],
            },
            "notes",
          ],
          splitPercentages: [62, 38],
        },
      ],
      splitPercentages: [52, 48],
    },
    "thumbnails",
  ],
  splitPercentages: [68, 32],
};

/**
 * A layout persisted by react-mosaic v6 or earlier: a binary parent with
 * `first`/`second` rather than `children`.
 *
 * These are still sitting in users' localStorage, so they have to be recognised
 * and converted rather than discarded — dropping them would silently reset
 * every existing user's dashboard to the default.
 */
function isLegacyParent(node: unknown): boolean {
  return (
    typeof node === "object" &&
    node !== null &&
    "direction" in node &&
    "first" in node &&
    "second" in node
  );
}

/** Project an untrusted parsed value onto the known cards. Unknown leaves are
 *  dropped, containers left with too few children collapse into what survives,
 *  and anything unrecognisable (e.g. the much older array format) yields null
 *  so the caller can fall back to the default. */
function sanitize(node: unknown): MosaicNode<string> | null {
  // Migrate a v6 tree before validating it, so the rest of this function only
  // ever deals with the n-ary shape.
  const value = isLegacyParent(node)
    ? convertLegacyToNary(node as MosaicNode<string>)
    : (node as MosaicNode<string> | null);

  return prune(value);
}

/**
 * Drop everything that isn't a known card, collapsing containers that no longer
 * hold enough children to be worth keeping.
 *
 * Bottom-up, so a split whose children all collapse away collapses in turn.
 * (v7 ships normalizeMosaicTree for this, but does not re-export it from the
 * package index.)
 */
function prune(node: MosaicNode<string> | null | undefined): MosaicNode<string> | null {
  if (typeof node === "string") return CARD_KEYS.includes(node) ? node : null;
  if (node == null) return null;

  if (isSplitNode(node)) {
    // Keep each surviving child's share by pruning both arrays in step;
    // normalizeMosaicTree collapses a split left with a single child.
    const kept: MosaicNode<string>[] = [];
    const shares: number[] = [];
    node.children.forEach((child, i) => {
      const pruned = prune(child);
      if (pruned == null) return;
      kept.push(pruned);
      shares.push(node.splitPercentages?.[i] ?? 100 / node.children.length);
    });
    if (kept.length === 0) return null;
    // A split with one child is just that child.
    if (kept.length === 1) return kept[0];
    return {
      type: "split",
      direction: node.direction === "column" ? "column" : "row",
      children: kept,
      splitPercentages: rescale(shares),
    };
  }

  if (isTabsNode(node)) {
    const tabs = node.tabs.filter((t) => CARD_KEYS.includes(t));
    if (tabs.length === 0) return null;
    // A tab strip needs at least two tabs; one is just the card itself.
    if (tabs.length === 1) return tabs[0];
    return {
      type: "tabs",
      tabs,
      // The active tab may have been one of the dropped ones.
      activeTabIndex: Math.min(Math.max(node.activeTabIndex ?? 0, 0), tabs.length - 1),
    };
  }

  return null;
}

/** Split shares must sum to 100, which pruning a child breaks. */
function rescale(shares: number[]): number[] {
  const total = shares.reduce((a, b) => a + b, 0);
  if (total <= 0) return shares.map(() => 100 / shares.length);
  return shares.map((s) => (s / total) * 100);
}

/** Keys currently shown as tiles, in the tree's canonical order. */
export function visibleKeys(node: MosaicNode<string> | null): string[] {
  return getLeaves(node).filter((k) => CARD_KEYS.includes(k));
}

/** Path to a card, as the numeric child indices v7 addresses nodes by. */
function findPath(
  node: MosaicNode<string> | null,
  key: string,
  path: MosaicPath = [],
): MosaicPath | null {
  if (node == null) return null;
  if (typeof node === "string") return node === key ? path : null;

  if (isSplitNode(node)) {
    for (let i = 0; i < node.children.length; i++) {
      const found = findPath(node.children[i], key, [...path, i]);
      if (found) return found;
    }
    return null;
  }

  if (isTabsNode(node)) {
    const i = node.tabs.indexOf(key);
    return i === -1 ? null : [...path, i];
  }

  return null;
}

/** Add a card as a new full-height column on the right edge. No-op if already
 *  present or the key is unknown. */
export function addLeaf(node: MosaicNode<string> | null, key: string): MosaicNode<string> {
  if (!CARD_KEYS.includes(key)) return node ?? key;
  if (node == null) return key;
  if (findPath(node, key)) return node;
  return {
    type: "split",
    direction: "row",
    children: [node, key],
    splitPercentages: [75, 25],
  };
}

/** Remove a card from the tree; neighbours expand to fill the space. Returns
 *  null if the removed card was the last one. */
export function removeLeaf(
  node: MosaicNode<string> | null,
  key: string,
): MosaicNode<string> | null {
  const path = findPath(node, key);
  if (node == null || path == null) return node;
  if (path.length === 0) return null; // removing the sole remaining tile
  return updateTree(node, [createRemoveUpdate(node, path)]);
}

export function loadLayout(): MosaicNode<string> {
  return sanitize(lsGet(STORAGE_KEYS.controllerMosaic, null)) ?? DEFAULT_LAYOUT;
}

export function saveLayout(node: MosaicNode<string> | null) {
  lsSet(STORAGE_KEYS.controllerMosaic, node);
}

export function savePreferred(node: MosaicNode<string> | null) {
  lsSet(STORAGE_KEYS.preferredMosaic, node);
}

export function hasPreferredLayout(): boolean {
  return sanitize(lsGet(STORAGE_KEYS.preferredMosaic, null)) !== null;
}

/** Load the user's saved "preferred" layout, or null if none is stored. */
export function loadPreferred(): MosaicNode<string> | null {
  return sanitize(lsGet(STORAGE_KEYS.preferredMosaic, null));
}
