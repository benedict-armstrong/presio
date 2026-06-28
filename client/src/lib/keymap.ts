// Controller keyboard shortcuts: types, defaults, persistence, and matching.

import { lsGet, lsSet, STORAGE_KEYS } from "./storage";

export interface KeyBinding {
  key: string;
  meta?: boolean;
}

export interface Keymap {
  nextSlide: KeyBinding[];
  prevSlide: KeyBinding[];
  firstSlide: KeyBinding[];
  lastSlide: KeyBinding[];
  toggleBlank: KeyBinding[];
  toggleCode: KeyBinding[];
}

export const KEYMAP_ACTIONS = ["nextSlide", "prevSlide", "firstSlide", "lastSlide", "toggleBlank", "toggleCode"] as const;
export type KeymapAction = (typeof KEYMAP_ACTIONS)[number];

export const KEYMAP_LABELS: Record<KeymapAction, string> = {
  nextSlide: "Next slide",
  prevSlide: "Previous slide",
  firstSlide: "First slide",
  lastSlide: "Last slide",
  toggleBlank: "Blank screen",
  toggleCode: "Show join code",
};

export const DEFAULT_KEYMAP: Keymap = {
  nextSlide: [{ key: "ArrowRight" }, { key: " " }],
  prevSlide: [{ key: "ArrowLeft" }],
  firstSlide: [{ key: "ArrowLeft", meta: true }],
  lastSlide: [{ key: "ArrowRight", meta: true }],
  toggleBlank: [{ key: "b" }],
  toggleCode: [{ key: "c" }],
};

export function loadKeymap(): Keymap {
  // Merge over defaults so a stored map missing a newer action still binds it.
  const saved = lsGet<Partial<Keymap> | null>(STORAGE_KEYS.keymap, null);
  return saved ? { ...DEFAULT_KEYMAP, ...saved } : DEFAULT_KEYMAP;
}

export function saveKeymap(km: Keymap) {
  lsSet(STORAGE_KEYS.keymap, km);
}

export function matchesBinding(e: KeyboardEvent, bindings: KeyBinding[]): boolean {
  return bindings.some((b) => {
    const keyMatch = e.key.toLowerCase() === b.key.toLowerCase();
    const metaMatch = b.meta ? e.metaKey : !e.metaKey;
    return keyMatch && metaMatch;
  });
}

export function formatBinding(b: KeyBinding): string {
  const parts: string[] = [];
  if (b.meta) parts.push("⌘");
  const display: Record<string, string> = {
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
    " ": "Space", Escape: "Esc", Enter: "Enter",
  };
  parts.push(display[b.key] || b.key.toUpperCase());
  return parts.join("");
}
