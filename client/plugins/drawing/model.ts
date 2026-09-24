// What's drawn, and how it travels.
//
// Points are fractions of the page (0–1, top-left origin), so a stroke means
// the same spot on every screen. Widths are pixels on a 960px-wide slide,
// scaled with the page.
//
// Every device keeps the same model, built from the same messages:
//
//  - "c<slide>.<k>" (retain: "deck"): chunk k of a slide's committed strokes,
//    { v, n, s }. A slide's strokes are its chunks 0..n-1 in order, with n
//    taken from the newest (highest v) chunk message seen for the slide. A
//    commit re-sends only the slide's last chunk (a new one when it's full),
//    so a busy slide never costs more than a chunk per stroke; undo and clear
//    re-send what changed and forget emptied chunks (a null payload). Retained,
//    they're the whole drawing for anyone joining late, and — the presenter's
//    retained messages being saved on their device — for the presenter after a
//    reload. Scoped to the deck: replacing it forgets them everywhere.
//  - "b" { i, s, t, c, w, d }: the presenter began stroke i on slide s.
//  - "p" { i, d }: its newest points, about 60 times a second.
//  - "x" { i }: it was abandoned (a pinch took over).
//  - "l" { x, y } | null: the laser, volatile.
//
// Any of the presenter's surfaces may change the drawing (the slide surface
// commits strokes, the background answers keyboard shortcuts): each applies
// the change to its own model and sends it, and the host hands it to the
// others on the page like to every other device.

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
/** A stroke longer than this goes on as a new one, so any stroke fits in a message. */
export const MAX_STROKE_POINTS = 2000;
/** A chunk fills up at about this many bytes of JSON, well under a message's 16 KB. */
const CHUNK_BYTES = 12_000;

// Each stroke's wire form, made once: a commit re-sends the whole last chunk.
const wireCache = new WeakMap<Stroke, WireStroke>();
const wire = (s: Stroke) => {
  let w = wireCache.get(s);
  if (!w) wireCache.set(s, (w = toWire(s)));
  return w;
};
const bytes = (strokes: Stroke[]) => strokes.reduce((n, s) => n + s.id.length + s.color.length + wire(s).d.length + 40, 0);

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

interface WireStroke {
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

interface Chunk {
  v: number;
  strokes: Stroke[];
}

interface SlideDrawing {
  /** The newest chunk message's version, and the chunk count it gave. */
  v: number;
  n: number;
  chunks: Map<number, Chunk>;
  /** Strokes in order, rebuilt when a chunk changes. */
  cache: Stroke[] | null;
}

const CHUNK_RE = /^c(\d{1,5})\.(\d{1,4})$/;

export class Drawing {
  private slides = new Map<number, SlideDrawing>();

  /**
   * Apply a chunk message ("c<slide>.<k>"). Returns the slide it changed, or
   * null when the type isn't a chunk.
   */
  apply(type: string, payload: unknown): number | null {
    const m = CHUNK_RE.exec(type);
    if (!m) return null;
    const slide = Number(m[1]);
    const k = Number(m[2]);
    const d = this.slide(slide);
    if (payload === null) {
      d.chunks.delete(k);
      d.cache = null;
      return slide;
    }
    if (!isRecord(payload) || typeof payload.v !== "number" || typeof payload.n !== "number" || !Array.isArray(payload.s)) return null;
    this.setChunk(slide, k, payload.v, payload.n, payload.s.map(fromWire).filter((s): s is Stroke => s !== null));
    return slide;
  }

  private setChunk(slide: number, k: number, v: number, n: number, strokes: Stroke[]) {
    const d = this.slide(slide);
    d.chunks.set(k, { v, strokes });
    if (v >= d.v) {
      d.v = v;
      d.n = n;
      // Chunks past the end are leftovers of an undo or clear this device
      // missed while away.
      for (const key of d.chunks.keys()) if (key >= d.n) d.chunks.delete(key);
    }
    d.cache = null;
  }

  strokes(slide: number): Stroke[] {
    const d = this.slides.get(slide);
    if (!d) return [];
    if (!d.cache) {
      d.cache = [];
      for (let k = 0; k < d.n; k++) d.cache.push(...(d.chunks.get(k)?.strokes ?? []));
    }
    return d.cache;
  }

  /** Slides with anything drawn on them. */
  drawnSlides(): number[] {
    return [...this.slides.keys()].filter((s) => this.strokes(s).length > 0).sort((a, b) => a - b);
  }

  /** Forget everything (the deck was replaced; its retained chunks go with it). */
  reset() {
    this.slides.clear();
  }

  private slide(n: number): SlideDrawing {
    let d = this.slides.get(n);
    if (!d) this.slides.set(n, (d = { v: 0, n: 0, chunks: new Map(), cache: null }));
    return d;
  }

  // --- Changes (presenter). Each returns the messages that make it, already
  // applied here; the caller sends them. ---

  commit(slide: number, stroke: Stroke): Message[] {
    const d = this.slide(slide);
    const last = d.n > 0 ? d.chunks.get(d.n - 1) : undefined;
    if (last && bytes(last.strokes) + bytes([stroke]) <= CHUNK_BYTES) {
      return this.put(slide, d.n - 1, [...last.strokes, stroke], d.n);
    }
    return this.put(slide, d.n, [stroke], d.n + 1);
  }

  undo(slide: number): Message[] {
    const strokes = this.strokes(slide);
    const d = this.slides.get(slide);
    if (!d || !strokes.length) return [];
    // Only the last chunk changes, unless it empties: then it's forgotten and
    // the one before re-sent, as it was, with the new count.
    const last = d.chunks.get(d.n - 1)?.strokes ?? [];
    if (last.length > 1 || d.n === 1) return this.put(slide, d.n - 1, last.slice(0, -1), last.length > 1 ? d.n : 0);
    const drop = this.drop(slide, d.n - 1);
    return [drop, ...this.put(slide, d.n - 2, d.chunks.get(d.n - 2)?.strokes ?? [], d.n - 1)];
  }

  clear(slide: number): Message[] {
    if (!this.strokes(slide).length) return [];
    return this.setSlide(slide, []);
  }

  /** Replace the whole drawing (a loaded file). */
  replaceAll(bySlide: Map<number, Stroke[]>): Message[] {
    const out: Message[] = [];
    for (const slide of this.drawnSlides()) if (!bySlide.has(slide)) out.push(...this.clear(slide));
    for (const [slide, strokes] of bySlide) out.push(...this.setSlide(slide, strokes));
    return out;
  }

  /**
   * Re-send a slide as these strokes, packed into chunks, forgetting chunks
   * it no longer needs. An empty slide keeps chunk 0, empty, to carry the
   * count to devices that missed the change.
   */
  private setSlide(slide: number, strokes: Stroke[]): Message[] {
    const packed: Stroke[][] = [];
    for (const stroke of strokes) {
      const last = packed[packed.length - 1];
      if (last && bytes(last) + bytes([stroke]) <= CHUNK_BYTES) last.push(stroke);
      else packed.push([stroke]);
    }
    const d = this.slide(slide);
    const out: Message[] = [];
    for (let k = d.n - 1; k >= Math.max(1, packed.length); k--) out.push(this.drop(slide, k));
    if (!packed.length) return [...out, ...this.put(slide, 0, [], 0)];
    packed.forEach((chunk, k) => out.push(...this.put(slide, k, chunk, packed.length)));
    return out;
  }

  private put(slide: number, k: number, strokes: Stroke[], n: number): Message[] {
    const v = Math.max(Date.now(), this.slide(slide).v + 1);
    this.setChunk(slide, k, v, n, strokes);
    return [{ type: `c${slide}.${k}`, payload: { v, n, s: strokes.map(wire) } }];
  }

  private drop(slide: number, k: number): Message {
    const type = `c${slide}.${k}`;
    this.apply(type, null);
    return { type, payload: null };
  }
}

export interface Message {
  type: string;
  payload: unknown;
}

/** Send a change's messages: retained for this deck, for everyone. */
export function publish(messages: Message[]) {
  for (const { type, payload } of messages) presio.send(type, payload, { retain: "deck" });
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

export function serializeFile(drawing: Drawing): string {
  const annotations: Record<number, FileStroke[]> = {};
  for (const slide of drawing.drawnSlides()) {
    annotations[slide] = drawing.strokes(slide).map((s) => ({
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
