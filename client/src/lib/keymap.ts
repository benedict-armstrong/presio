// Controller keyboard shortcuts: types, defaults, and matching. The user's
// bindings are the "keybindings" setting (lib/settings.ts).

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
  jumpToSlide: KeyBinding[];
}

export const KEYMAP_ACTIONS = ["nextSlide", "prevSlide", "firstSlide", "lastSlide", "toggleBlank", "toggleCode", "jumpToSlide"] as const;
export type KeymapAction = (typeof KEYMAP_ACTIONS)[number];

export const KEYMAP_LABELS: Record<KeymapAction, string> = {
  nextSlide: "Next slide",
  prevSlide: "Previous slide",
  firstSlide: "First slide",
  lastSlide: "Last slide",
  toggleBlank: "Blank screen",
  toggleCode: "Show join code",
  jumpToSlide: "Jump to slide (then digits)",
};

export const DEFAULT_KEYMAP: Keymap = {
  // PageDown/PageUp are what presenter remotes (clickers) send for next/prev.
  nextSlide: [{ key: "ArrowRight" }, { key: " " }, { key: "PageDown" }],
  prevSlide: [{ key: "ArrowLeft" }, { key: "PageUp" }],
  firstSlide: [{ key: "ArrowLeft", meta: true }],
  lastSlide: [{ key: "ArrowRight", meta: true }],
  toggleBlank: [{ key: "b" }],
  toggleCode: [{ key: "c" }],
  // A prefix, not a one-shot action: it arms digit capture (see ControllerView).
  jumpToSlide: [{ key: "j" }],
};

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
    PageDown: "PgDn", PageUp: "PgUp",
  };
  parts.push(display[b.key] || b.key.toUpperCase());
  return parts.join("");
}
