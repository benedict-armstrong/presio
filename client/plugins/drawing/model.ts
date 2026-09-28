// What's drawn, and how it travels.
//
// Points are fractions of the page (0–1, top-left origin), so a stroke means
// the same spot on every screen. Widths are pixels on a 960px-wide slide,
// scaled with the page.
//
// What's drawn is the deck's edit history (presio.history): ops that add a
// stroke, erase strokes or bring erased ones back, each naming strokes by id,
// so two devices' ops combine without conflict. Every device applies the same
// ops in the same order and gets the same drawing; the history lasts with the
// deck on the presenter's device, and a device joining late loads it.
//
// While a stroke is being drawn it travels live, outside the history:
//
//  - "b" { i, s, t, c, w, d }: the presenter began stroke i on slide s.
//  - "p" { i, d }: its newest points, about 60 times a second.
//  - "x" { i }: it was abandoned (a pinch took over).
//  - "l" { x, y } | null: the laser, volatile.
//
// Undo is this device's: the op that reverses its own latest change on the
// slide (see undoOps).

export type Tool = "none" | "laser" | "pen" | "highlighter";

export interface Stroke {
  id: string;
  tool: "pen" | "highlighter";
  color: string;
  /** Pixels on a 960px-wide slide. */
  width: number;
  /** Flat [x0, y0, x1, y1, …], page fractions. */
  points: number[];
}

export const REFERENCE_WIDTH = 960;
export const HIGHLIGHTER_OPACITY = 0.35;
/** A stroke longer than this goes on as a new one, so any stroke fits in an op. */
export const MAX_STROKE_POINTS = 2000;

export const opacityOf = (stroke: Pick<Stroke, "tool">) => (stroke.tool === "highlighter" ? HIGHLIGHTER_OPACITY : 1);

export const newId = () => Math.random().toString(36).slice(2, 10);

// --- Wire encoding ---
//
// Coordinates go as 16-bit fractions (1/65535 of the page: far finer than any
// screen), little-endian, base64: 5⅓ characters a point where JSON numbers
// took ~36.

const Q = 65535;

export function encodePoints(points: ArrayLike<number>, from = 0): string {
  let bin = "";
  for (let i = from; i < points.length; i++) {
    const q = Math.round(Math.min(1, Math.max(0, points[i])) * Q);
    bin += String.fromCharCode(q & 0xff, q >> 8);
  }
  return btoa(bin);
}

export function decodePoints(data: unknown): number[] | null {
  if (typeof data !== "string") return null;
  let bin: string;
  try {
    bin = atob(data);
  } catch {
    return null;
  }
  if (bin.length % 4 !== 0) return null;
  const out = new Array<number>(bin.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) / Q;
  return out;
}

export interface WireStroke {
  i: string;
  t: "p" | "h";
  c: string;
  w: number;
  d: string;
}

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function toWire(s: Stroke): WireStroke {
  return { i: s.id, t: s.tool === "highlighter" ? "h" : "p", c: s.color, w: s.width, d: encodePoints(s.points) };
}

export function fromWire(raw: unknown): Stroke | null {
  if (!isRecord(raw) || typeof raw.i !== "string" || (raw.t !== "p" && raw.t !== "h")) return null;
  if (typeof raw.c !== "string" || !COLOR_RE.test(raw.c)) return null;
  if (typeof raw.w !== "number" || !Number.isFinite(raw.w) || raw.w <= 0) return null;
  const points = decodePoints(raw.d);
  if (!points || !points.length) return null;
  return { id: raw.i, tool: raw.t === "h" ? "highlighter" : "pen", color: raw.c, width: Math.min(raw.w, 96), points };
}

/** The live messages' header for a stroke being drawn ("b"). */
export interface Begin {
  i: string;
  s: number;
  t: "p" | "h";
  c: string;
  w: number;
  d: string;
}

export function parseBegin(raw: unknown): (Stroke & { slide: number }) | null {
  if (!isRecord(raw) || typeof raw.s !== "number" || !Number.isInteger(raw.s)) return null;
  const stroke = fromWire(raw);
  return stroke && { ...stroke, slide: raw.s };
}

// --- The model ---

/** One slide: every stroke it has had, in order, and which are erased. */
export interface SlideState {
  all: readonly Stroke[];
  gone: ReadonlySet<string>;
}

/** What's drawn, per slide. Never changed in place: each op makes a new one. */
export interface DrawingState {
  slides: ReadonlyMap<number, SlideState>;
}

interface OpBase {
  /** The slide. */
  s: number;
  /** Ops made together (a loaded file, a long stroke) are undone together. */
  g?: string;
  /** This op undoes that one (the id of an op of this device's). */
  u?: string;
}
export type Op =
  | (OpBase & { t: "add"; k: WireStroke })
  | (OpBase & { t: "erase"; ids: string[] })
  | (OpBase & { t: "restore"; ids: string[] });

/** At most this many ids in one op: well under a message's 16 KB. */
const MAX_IDS = 1000;

const EMPTY: DrawingState = { slides: new Map() };

// Strokes decoded once: the frame applies pending ops again every time the
// ordered state moves, and the canvas only draws what's new when the strokes
// it already has are the same objects.
const decoded = new Map<string, { d: string; stroke: Stroke }>();
function strokeOf(k: WireStroke): Stroke | null {
  const hit = decoded.get(k.i);
  if (hit && hit.d === k.d) return hit.stroke;
  const stroke = fromWire(k);
  if (stroke) decoded.set(k.i, { d: k.d, stroke });
  return stroke;
}

// A slide's visible strokes, worked out once per SlideState.
const liveCache = new WeakMap<SlideState, Stroke[]>();
export function strokes(state: DrawingState, slide: number): Stroke[] {
  const d = state.slides.get(slide);
  if (!d) return [];
  let live = liveCache.get(d);
  if (!live) liveCache.set(d, (live = d.gone.size ? d.all.filter((s) => !d.gone.has(s.id)) : (d.all as Stroke[])));
  return live;
}

/** Slides with anything drawn on them. */
export function drawnSlides(state: DrawingState): number[] {
  return [...state.slides.keys()].filter((s) => strokes(state, s).length > 0).sort((a, b) => a - b);
}

const validSlide = (s: unknown): s is number => typeof s === "number" && Number.isInteger(s) && s >= 1 && s <= 100_000;
const idList = (ids: unknown): string[] | null =>
  Array.isArray(ids) && ids.every((i) => typeof i === "string") ? (ids as string[]) : null;

function withSlide(state: DrawingState, slide: number, d: SlideState): DrawingState {
  const slides = new Map(state.slides);
  slides.set(slide, d);
  return { slides };
}

/** The history's apply: the drawing after one more op. */
export function apply(state: DrawingState, op: Op): DrawingState {
  if (!isRecord(op) || !validSlide(op.s)) return state;
  const d = state.slides.get(op.s) ?? { all: [], gone: new Set<string>() };
  if (op.t === "add") {
    const stroke = strokeOf(op.k);
    if (!stroke || d.all.some((s) => s.id === stroke.id)) return state;
    return withSlide(state, op.s, { all: [...d.all, stroke], gone: d.gone });
  }
  const ids = idList(op.ids);
  if (!ids) return state;
  if (op.t === "erase") {
    const has = new Set(d.all.map((s) => s.id));
    const hit = ids.filter((id) => has.has(id) && !d.gone.has(id));
    if (!hit.length) return state;
    return withSlide(state, op.s, { all: d.all, gone: new Set([...d.gone, ...hit]) });
  }
  if (op.t === "restore") {
    const hit = ids.filter((id) => d.gone.has(id));
    if (!hit.length) return state;
    const gone = new Set(d.gone);
    for (const id of hit) gone.delete(id);
    return withSlide(state, op.s, { all: d.all, gone });
  }
  return state;
}

// A snapshot keeps what's visible: what was erased before it can't be undone
// any more (this device's undo reaches back to the latest snapshot).
export function snapshot(state: DrawingState): unknown {
  const slides: Record<number, WireStroke[]> = {};
  for (const slide of drawnSlides(state)) slides[slide] = strokes(state, slide).map(toWire);
  return { v: 1, slides };
}

export function restore(snap: unknown): DrawingState {
  if (!isRecord(snap) || snap.v !== 1 || !isRecord(snap.slides)) return EMPTY;
  const slides = new Map<number, SlideState>();
  for (const [key, list] of Object.entries(snap.slides)) {
    const slide = Number(key);
    if (!validSlide(slide) || !Array.isArray(list)) continue;
    const all = list.map((k) => (isRecord(k) ? strokeOf(k as unknown as WireStroke) : null)).filter((s): s is Stroke => s !== null);
    if (all.length) slides.set(slide, { all, gone: new Set() });
  }
  return { slides };
}

export type DrawingHistory = PresioHistory<DrawingState, Op>;

/** Open the deck's drawing history (once per frame). */
export function openDrawing(): DrawingHistory {
  return presio.history.open<DrawingState, Op>({ init: () => EMPTY, apply, snapshot, restore });
}

/** The deck was replaced by another document: decoded strokes can go. */
export function forgetDecoded() {
  decoded.clear();
}

// --- Changes (presenter): the ops that make them, for the caller to commit ---

const groupId = () => `g${newId()}`;

/** Draw a stroke: one op, or several for a very long one (undone together). */
export function addOps(slide: number, stroke: Stroke): Op[] {
  const pieces = splitLong(stroke);
  const g = pieces.length > 1 ? groupId() : undefined;
  return pieces.map((p) => ({ t: "add", s: slide, k: toWire(p), ...(g && { g }) }));
}

function idOps(t: "erase" | "restore", slide: number, ids: string[], extra: { g?: string; u?: string }): Op[] {
  const out: Op[] = [];
  const g = extra.g ?? (ids.length > MAX_IDS ? groupId() : undefined);
  for (let i = 0; i < ids.length; i += MAX_IDS) out.push({ t, s: slide, ids: ids.slice(i, i + MAX_IDS), ...(g && { g }), ...(extra.u && { u: extra.u }) });
  return out;
}

/** Clear a slide: erase what's on it now (strokes drawn meanwhile elsewhere stay). */
export function clearOps(state: DrawingState, slide: number): Op[] {
  return idOps("erase", slide, strokes(state, slide).map((s) => s.id), {});
}

/** Replace the whole drawing with a loaded file's, as one change. */
export function loadOps(state: DrawingState, bySlide: Map<number, Stroke[]>): Op[] {
  const g = groupId();
  const out: Op[] = [];
  for (const slide of drawnSlides(state)) out.push(...idOps("erase", slide, strokes(state, slide).map((s) => s.id), { g }));
  for (const [slide, list] of bySlide) for (const stroke of list) out.push({ t: "add", s: slide, k: toWire(stroke), g });
  return out;
}

/**
 * The ops that undo this device's latest change on a slide (its ops in one
 * group, when it made several together), or none. Undoing is itself a change
 * that names what it undoes, so a later undo moves on to the change before.
 */
export function undoOps(h: DrawingHistory, slide: number): Op[] {
  const mine = h.mine();
  const undone = new Set(mine.map((m) => m.op?.u).filter((u): u is string => typeof u === "string"));
  const open = mine.filter((m) => isRecord(m.op) && !m.op.u && !undone.has(m.id));
  const last = open.find((m) => m.op.s === slide);
  if (!last) return [];
  const batch = last.op.g ? open.filter((m) => m.op.g === last.op.g) : [last];
  return batch.flatMap(({ id, op }) =>
    op.t === "add" ? idOps("erase", op.s, [op.k.i], { u: id }) : idOps(op.t === "erase" ? "restore" : "erase", op.s, op.ids, { u: id })
  );
}

/** Whether this device has a change on the slide to undo. */
export const canUndo = (h: DrawingHistory, slide: number) => undoOps(h, slide).length > 0;

/** Commit ops, in order. */
export function commitAll(h: DrawingHistory, ops: Op[]) {
  for (const op of ops) h.commit(op);
}

/** Split a stroke too long for one message into consecutive ones. */
export function splitLong(stroke: Stroke): Stroke[] {
  const max = MAX_STROKE_POINTS * 2;
  if (stroke.points.length <= max) return [stroke];
  const out: Stroke[] = [];
  // Each piece starts where the last ended, so the line is unbroken.
  for (let i = 0; i < stroke.points.length - 2; i += max - 2) {
    out.push({ ...stroke, id: out.length ? newId() : stroke.id, points: stroke.points.slice(i, i + max) });
  }
  return out;
}

// --- Drawing files ---
//
// "presio-drawing" v1: what Presio has always saved. Strokes there carry a
// width as a fraction of the slide's and an opacity (implied by the tool).

interface FileStroke {
  tool: "pen" | "highlighter";
  color: string;
  size: number;
  opacity: number;
  points: number[];
}

export function serializeFile(state: DrawingState): string {
  const annotations: Record<number, FileStroke[]> = {};
  for (const slide of drawnSlides(state)) {
    annotations[slide] = strokes(state, slide).map((s) => ({
      tool: s.tool,
      color: s.color,
      size: s.width / REFERENCE_WIDTH,
      opacity: opacityOf(s),
      points: s.points.map((n) => Math.round(n * 1e4) / 1e4),
    }));
  }
  return JSON.stringify({ format: "presio-drawing", version: 1, annotations }, null, 2);
}

/** Parse a saved drawing, or throw with a readable message. */
export function parseFile(text: string, totalSlides: number): Map<number, Stroke[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not a valid drawing file (invalid JSON)");
  }
  if (!isRecord(raw) || raw.format !== "presio-drawing" || !isRecord(raw.annotations)) {
    throw new Error("Not a Presio drawing file");
  }
  const out = new Map<number, Stroke[]>();
  for (const [key, list] of Object.entries(raw.annotations)) {
    const slide = parseInt(key, 10);
    if (!Number.isInteger(slide) || slide < 1 || slide > totalSlides || !Array.isArray(list)) continue;
    const strokes = list.flatMap((s: unknown): Stroke[] => {
      if (!isRecord(s) || (s.tool !== "pen" && s.tool !== "highlighter")) return [];
      if (typeof s.color !== "string" || !COLOR_RE.test(s.color) || typeof s.size !== "number" || !Number.isFinite(s.size)) return [];
      const points = s.points;
      if (!Array.isArray(points) || points.length < 2 || points.length % 2 !== 0) return [];
      if (!points.every((n) => typeof n === "number" && Number.isFinite(n))) return [];
      const width = Math.min(96, Math.max(0.2, s.size * REFERENCE_WIDTH));
      return splitLong({ id: newId(), tool: s.tool, color: s.color, width, points: points.map((n) => Math.min(1, Math.max(0, n))) });
    });
    if (strokes.length) out.set(slide, strokes);
  }
  return out;
}
