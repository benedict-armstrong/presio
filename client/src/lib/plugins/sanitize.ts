// Reading what a plugin frame sends: untrusted values reduced to the shapes
// Presio draws (boxes, input areas, layers, button state and menus).

import type { ButtonMenuEntry, ButtonState, Interactive, LayerItem, SlidePage } from "./protocol";

/** How many rows a button's menu may have. */
const MAX_MENU_ENTRIES = 32;
const MAX_LAYER_ITEMS = 32;
const MAX_INPUT_AREAS = 32;
/** An image URL a layer may show: inline, a blob, or on the web. */
const LAYER_IMAGE_RE = /^(data:image\/|blob:|https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/;

/** An untrusted value as an object to read fields from ({} when it isn't one). */
export function asRecord(value: unknown): Record<string, unknown> {
  return (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
}

/** A plugin-given box (fractions): finite, with a positive size; else null. */
export function parseRect(r: Record<string, unknown>): SlidePage | null {
  const { x, y, w, h } = r;
  if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const rect = { x, y, w, h } as SlidePage;
  return rect.w > 0 && rect.h > 0 ? rect : null;
}

export function sanitizeInteractive(value: unknown): Interactive {
  if (typeof value === "boolean" || value === "pen") return value;
  if (!Array.isArray(value)) return false;
  return value.slice(0, MAX_INPUT_AREAS).flatMap((raw) => parseRect(asRecord(raw)) ?? []);
}

/** A static layer's items as a plugin set them, reduced to ones Presio can draw. */
export function sanitizeLayerItems(raw: unknown): LayerItem[] {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_LAYER_ITEMS).flatMap((value): LayerItem[] => {
    const r = asRecord(value);
    const rect = parseRect(r);
    if (!rect || typeof r.image !== "string" || !LAYER_IMAGE_RE.test(r.image)) return [];
    return [{ ...rect, image: r.image, fit: r.fit === "contain" ? "contain" : "cover" }];
  });
}

/** A button's state as a plugin set it; null when it isn't an object. */
export function sanitizeButtonState(raw: unknown): ButtonState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  return {
    active: typeof s.active === "boolean" ? s.active : undefined,
    label: typeof s.label === "string" ? s.label.slice(0, 24) : undefined,
    disabled: typeof s.disabled === "boolean" ? s.disabled : undefined,
    menu: sanitizeMenu(s.menu),
  };
}

/** A button menu as a plugin set it, reduced to rows Presio can draw. */
function sanitizeMenu(raw: unknown): ButtonMenuEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const entries: ButtonMenuEntry[] = [];
  for (const r of raw.slice(0, MAX_MENU_ENTRIES)) {
    if (typeof r !== "object" || r === null) continue;
    const e = r as Record<string, unknown>;
    if (e.separator === true) entries.push({ separator: true });
    else if (typeof e.heading === "string" && e.heading) entries.push({ heading: e.heading.slice(0, 64) });
    else if (typeof e.id === "string" && e.id && e.id.length <= 256 && typeof e.label === "string" && e.label) {
      entries.push({
        id: e.id,
        label: e.label.slice(0, 64),
        checked: typeof e.checked === "boolean" ? e.checked : undefined,
        disabled: typeof e.disabled === "boolean" ? e.disabled : undefined,
      });
    }
  }
  return entries.length ? entries : undefined;
}
