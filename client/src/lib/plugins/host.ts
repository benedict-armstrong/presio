// The app side of the plugin bridge. One PluginHost per open presentation owns
// every mounted plugin frame's MessagePort, keeps them up to date (slide,
// session, theme), answers their requests, and routes their messages: to the
// plugin's other frames on this page, and out through a transport (socket or
// BroadcastChannel, see usePluginHost) to its frames on other devices.

import type { PdfAttachment } from "@/lib/pdf";
import { lsGet, lsRemove, lsSet, pluginRetainedKey, pluginStateKey } from "@/lib/storage";
import { sanitizeSettingValue, setPluginSetting } from "@/lib/settings";
import { clockOffset } from "@/lib/clock";
import type { LoadedPlugin, PluginSurface } from "./manifest";

export type PluginRole = "presenter" | "audience";

export interface PluginContext {
  role: PluginRole;
  theme: "light" | "dark";
  session: { id: string; local: boolean; joinUrl: string | null };
  slide: { current: number; total: number };
}

export type Retain = boolean | "deck";

/** A plugin message as it travels between devices. */
export interface WireEvent {
  plugin: string;
  type: string;
  payload: unknown;
  /** Kept for devices that join later: for the session, or ("deck") only
   *  until the deck is replaced. */
  retain?: Retain;
  /** May be dropped rather than queued (a stream where only the latest counts). */
  volatile?: boolean;
  from?: PluginRole;
  sender?: string;
}

/** What a plugin has set on one of its contributed buttons. */
export interface ButtonState {
  active?: boolean;
  label?: string;
  disabled?: boolean;
  /** A small menu beside the button (a mic to use, a mode): picking an item
   *  goes to the plugin's presio.onMenu. */
  menu?: ButtonMenuEntry[];
}

/** One row of a button's menu: an item to pick, a heading, or a divider. */
export type ButtonMenuEntry =
  | { id: string; label: string; checked?: boolean; disabled?: boolean }
  | { heading: string }
  | { separator: true };

/** How many rows a button's menu may have. */
const MAX_MENU_ENTRIES = 32;

/** A file the presenter picked for a button that asks for one. */
export interface ButtonFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** A static layer item: an image at a position on the page (fractions). */
export interface LayerItem {
  x: number;
  y: number;
  w: number;
  h: number;
  image: string;
  fit: "cover" | "contain";
}

/** One plugin's static layer on one slide. */
export interface PluginLayer {
  pluginId: string;
  items: LayerItem[];
}

/** A page's size in PDF points (presio.deck.pages()). */
export interface PageSize {
  width: number;
  height: number;
}

/** Which download a plugin's export handler is transforming. */
export type ExportMode = "everything" | "no-attachments";

/** How the deck changed (presio.deck.onChange): the same pages edited in
 *  place, or a different document. */
export type DeckChange = "edit" | "replace";

/** The part of a "slide" surface on screen (fractions of it: page fractions
 *  for one sized to the page), and the zoom it's drawn at. */
export interface SlideView {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export const FULL_VIEW: SlideView = { x: 0, y: 0, w: 1, h: 1, scale: 1 };

/** Where the page is within a "slide" surface, as fractions of it: all of it,
 *  unless the surface covers the slide area around the page too. */
export interface SlidePage {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_PAGE: SlidePage = { x: 0, y: 0, w: 1, h: 1 };

/** Where a "slide" surface takes pointer input: nowhere, everywhere, or in
 *  these areas (fractions of it). */
export type Interactive = boolean | { x: number; y: number; w: number; h: number }[];

/** What a mounted frame wants told about it. */
export interface FrameHooks {
  /** Viewer surface: show or hide its layer. */
  onVisible?: (visible: boolean) => void;
  /** Slide surface: where it takes pointer input. */
  onInteractive?: (value: Interactive) => void;
  /** The plugin's document is in place (after boot). */
  onReady?: () => void;
}

/** What the page tells one mounted frame about how it's shown. */
export interface FrameLink {
  disconnect(): void;
  setView(view: SlideView): void;
  setPage(page: SlidePage): void;
  setHovered(hovered: boolean): void;
}

interface Conn extends FrameHooks {
  plugin: LoadedPlugin;
  surface: PluginSurface;
  port: MessagePort;
  /** It registered presio.deck.onExport. */
  exporter?: boolean;
}

const TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_LAYER_ITEMS = 32;
/** An image URL a layer may show: inline, a blob, or on the web. */
const LAYER_IMAGE_RE = /^(data:image\/|blob:|https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/;
const NO_LAYERS: PluginLayer[] = [];
/** What one plugin may keep in presio.storage for one session, as JSON. */
const STORAGE_LIMIT = 16 * 1024;
/**
 * What one plugin may keep retained: this many message types, this many bytes
 * of payload (as JSON) — the server's caps (server/validation.ts). A drawing
 * keeps its strokes this way, a slide's worth per message; 2 MB is several
 * hundred thousand compactly encoded points.
 */
const MAX_RETAINED_PER_PLUGIN = 1024;
const MAX_RETAINED_BYTES_PER_PLUGIN = 2 * 1024 * 1024;
/** How long retained changes wait before the presenter's copy is saved. */
const PERSIST_DELAY_MS = 300;
const NO_BUTTONS: Record<string, ButtonState> = {};
const retainKey = (plugin: string, type: string) => `${plugin}\u0000${type}`;
/** How long one plugin may take over its part of a download. */
const EXPORT_TIMEOUT_MS = 60_000;

export class PluginHost {
  private conns = new Set<Conn>();
  private retained = new Map<string, WireEvent>();
  // Each retained payload's size (JSON), for the per-plugin budget.
  private retainedSize = new Map<string, number>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private nextDeckChange: DeckChange = "replace";
  private ctx: PluginContext;
  private outbound: (event: WireEvent) => void = () => {};
  private attachments: () => Promise<PdfAttachment[]> = async () => [];
  private deckBytes: () => Promise<Uint8Array | null> = async () => null;
  private pageSizes: () => Promise<PageSize[]> = async () => [];
  private saveDeck: ((bytes: Uint8Array) => Promise<void>) | null = null;
  private settings = new Map<string, Record<string, unknown>>();
  private buttons = new Map<string, Record<string, ButtonState>>();
  private buttonListeners = new Set<() => void>();
  // Static layers: plugin id -> slide -> items, and a cache of each slide's
  // list so reads hand back a stable identity until something changes.
  private layers = new Map<string, Map<number, LayerItem[]>>();
  private layerCache = new Map<number, PluginLayer[]>();
  private layerListeners = new Set<() => void>();
  private clock = clockOffset();
  // Running plugins in the presenter's order: the order exports apply in.
  private running: readonly string[] = [];
  private exports = new Map<number, (result: { bytes?: unknown; error?: unknown }) => void>();
  private nextExport = 1;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    // The presenter's retained messages outlive a reload of their page: they
    // are the plugins' shared state (what's drawn, what's showing), and after
    // a server restart they're what the session is re-seeded from.
    if (ctx.role === "presenter") {
      const saved = lsGet<unknown>(pluginRetainedKey(ctx.session.id), []);
      for (const event of Array.isArray(saved) ? saved : []) {
        const e = event as Partial<WireEvent>;
        if (typeof e?.plugin === "string" && typeof e.type === "string" && e.payload !== undefined) {
          this.keepRetained({ plugin: e.plugin, type: e.type, payload: e.payload, retain: e.retain === "deck" ? "deck" : true, from: "presenter" });
        }
      }
      // Restoring isn't a change to save.
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    // Changes not yet saved when the page goes: save them now. Only this
    // host's own changes — a host that never changed anything (React may
    // build one it then discards) mustn't overwrite what another saved.
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => {
        if (this.persistTimer) this.persistRetained();
      });
    }
  }

  /** Where this device's outgoing messages go (the transport). */
  setOutbound(send: (event: WireEvent) => void) {
    this.outbound = send;
  }

  /**
   * The deck plugins with the "deck" permission read: its attachments, its
   * bytes and its page sizes. A new source means a new document, which frames
   * hear about.
   */
  setDeckSource(
    attachments: () => Promise<PdfAttachment[]>,
    bytes: () => Promise<Uint8Array | null>,
    pages: () => Promise<PageSize[]>
  ) {
    const changed = this.deckBytes !== bytes;
    this.attachments = attachments;
    this.deckBytes = bytes;
    this.pageSizes = pages;
    if (!changed) return;
    const kind = this.nextDeckChange;
    this.nextDeckChange = "replace";
    for (const conn of this.conns) conn.port.postMessage({ type: "deck", kind });
  }

  /** The next deck swap is an edit of the same pages (a notes save), not a
   *  different document — plugins keep what they hang off its slides. */
  expectDeckEdit() {
    this.nextDeckChange = "edit";
  }

  /** How an edited deck is saved; null where this device can't. */
  setDeckWriter(save: ((bytes: Uint8Array) => Promise<void>) | null) {
    this.saveDeck = save;
  }

  get context(): PluginContext {
    return this.ctx;
  }

  updateContext(next: PluginContext) {
    const prev = this.ctx;
    this.ctx = next;
    const slideChanged = prev.slide.current !== next.slide.current || prev.slide.total !== next.slide.total;
    const otherChanged =
      prev.role !== next.role ||
      prev.theme !== next.theme ||
      prev.session.id !== next.session.id ||
      prev.session.local !== next.session.local ||
      prev.session.joinUrl !== next.session.joinUrl;
    for (const conn of this.conns) {
      if (otherChanged) conn.port.postMessage({ type: "context", context: this.frameContext(conn.plugin, conn.surface) });
      else if (slideChanged) conn.port.postMessage({ type: "slide", slide: next.slide });
    }
  }

  frameContext(plugin: LoadedPlugin, surface: PluginSurface) {
    const pluginId = plugin.manifest.id;
    return {
      pluginId,
      surface,
      ...this.ctx,
      settings: this.settings.get(pluginId) ?? {},
      storage: this.readStorage(pluginId),
      clockOffset: this.clock,
      baseUrl: plugin.baseUrl,
      view: FULL_VIEW,
      page: FULL_PAGE,
      hovered: false,
    };
  }

  /** The server clock moved (lib/clock.ts); frames keep their own copy. */
  setClockOffset(offset: number) {
    if (Math.abs(offset - this.clock) < 1) return;
    this.clock = offset;
    for (const conn of this.conns) conn.port.postMessage({ type: "clock", offset });
  }

  // --- Static layers (presio.layers) ---

  /** Every plugin's static layer on a slide; a stable array until it changes. */
  slideLayers(slide: number): PluginLayer[] {
    let cached = this.layerCache.get(slide);
    if (!cached) {
      cached = [];
      for (const [pluginId, bySlide] of this.layers) {
        const items = bySlide.get(slide);
        if (items?.length) cached.push({ pluginId, items });
      }
      if (!cached.length) cached = NO_LAYERS;
      this.layerCache.set(slide, cached);
    }
    return cached;
  }

  subscribeLayers = (listener: () => void) => {
    this.layerListeners.add(listener);
    return () => { this.layerListeners.delete(listener); };
  };

  /** The plugins running now, in order; forgets the layers of any others. */
  setRunning(pluginIds: readonly string[]) {
    this.running = pluginIds;
    let changed = false;
    for (const id of [...this.layers.keys()]) {
      if (!pluginIds.includes(id)) {
        this.layers.delete(id);
        changed = true;
      }
    }
    if (changed) this.layersChanged();
  }

  private layersChanged() {
    this.layerCache.clear();
    this.layerListeners.forEach((l) => l());
  }

  private onLayers(conn: Conn, m: { slide?: unknown; items?: unknown; clear?: unknown }) {
    const pluginId = conn.plugin.manifest.id;
    if (m.clear === true) {
      if (this.layers.delete(pluginId)) this.layersChanged();
      return;
    }
    const slide = m.slide;
    if (typeof slide !== "number" || !Number.isInteger(slide) || slide < 1 || slide > 10_000) return;
    const items = (Array.isArray(m.items) ? m.items : []).slice(0, MAX_LAYER_ITEMS).flatMap((raw): LayerItem[] => {
      const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
      const [x, y, w, h] = [num(r.x), num(r.y), num(r.w), num(r.h)];
      if ([x, y, w, h].some(Number.isNaN) || w <= 0 || h <= 0) return [];
      if (typeof r.image !== "string" || !LAYER_IMAGE_RE.test(r.image)) return [];
      return [{ x, y, w, h, image: r.image, fit: r.fit === "contain" ? "contain" : "cover" }];
    });
    let bySlide = this.layers.get(pluginId);
    if (!bySlide) this.layers.set(pluginId, (bySlide = new Map()));
    if (items.length) bySlide.set(slide, items);
    else bySlide.delete(slide);
    this.layersChanged();
  }

  // --- presio.storage: the presenter's per-session plugin state ---

  private readStorage(pluginId: string): Record<string, unknown> {
    if (this.ctx.role !== "presenter") return {};
    const all = lsGet<Record<string, Record<string, unknown>>>(pluginStateKey(this.ctx.session.id), {});
    const mine = all?.[pluginId];
    return typeof mine === "object" && mine !== null && !Array.isArray(mine) ? mine : {};
  }

  private onStorageSet(conn: Conn, key: unknown, value: unknown) {
    // A local deck's viewer window shares this browser's storage; only the
    // presenter's frames write it.
    if (this.ctx.role !== "presenter" || typeof key !== "string" || !TYPE_RE.test(key)) return;
    const pluginId = conn.plugin.manifest.id;
    const next = { ...this.readStorage(pluginId) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    if (JSON.stringify(next).length > STORAGE_LIMIT) return;
    const storeKey = pluginStateKey(this.ctx.session.id);
    const all = lsGet<Record<string, unknown>>(storeKey, {});
    lsSet(storeKey, { ...all, [pluginId]: next });
    for (const other of this.conns) {
      if (other !== conn && other.plugin.manifest.id === pluginId) other.port.postMessage({ type: "storage", storage: next });
    }
  }

  /** A plugin's resolved settings changed (or arrived from the presenter). */
  setPluginSettings(pluginId: string, values: Record<string, unknown>) {
    const prev = this.settings.get(pluginId);
    if (prev && JSON.stringify(prev) === JSON.stringify(values)) return;
    this.settings.set(pluginId, values);
    for (const conn of this.conns) {
      if (conn.plugin.manifest.id === pluginId) conn.port.postMessage({ type: "settings", settings: values });
    }
  }

  // --- Contributed buttons ---

  /** State the plugin gave its buttons; a stable object until it changes. */
  buttonStates(pluginId: string): Record<string, ButtonState> {
    return this.buttons.get(pluginId) ?? NO_BUTTONS;
  }

  subscribeButtons = (listener: () => void) => {
    this.buttonListeners.add(listener);
    return () => { this.buttonListeners.delete(listener); };
  };

  /**
   * The presenter pressed one of a plugin's buttons. It goes to the plugin's
   * background frame when it has one, else to its tile — one handler, so a
   * plugin running both doesn't act twice. A button that asks for a file
   * (`accept`) arrives with the one picked.
   */
  pressButton(pluginId: string, buttonId: string, file?: ButtonFile) {
    for (const conn of this.handlerFrames(pluginId)) conn.port.postMessage({ type: "button", id: buttonId, file });
  }

  /** The presenter picked an item from a button's menu; delivered like a press. */
  pickMenuItem(pluginId: string, buttonId: string, itemId: string) {
    for (const conn of this.handlerFrames(pluginId)) conn.port.postMessage({ type: "menu", id: buttonId, item: itemId });
  }

  /** The presenter pressed one of a plugin's keybindings; delivered like a button. */
  runCommand(pluginId: string, command: string) {
    for (const conn of this.handlerFrames(pluginId)) conn.port.postMessage({ type: "command", id: command });
  }

  private handlerFrames(pluginId: string): Conn[] {
    const mine = [...this.conns].filter((c) => c.plugin.manifest.id === pluginId);
    const background = mine.filter((c) => c.surface === "background");
    return background.length ? background : mine.filter((c) => c.surface === "tile");
  }

  // --- Downloads (presio.deck.onExport) ---

  /**
   * Pass a PDF this device is downloading through each running plugin's
   * export handler, in plugin order. A plugin that fails or takes too long is
   * skipped, so one broken plugin never blocks a download.
   */
  async exportDeck(bytes: Uint8Array, mode: ExportMode): Promise<Uint8Array> {
    let out = bytes;
    for (const pluginId of this.running) {
      const frames = [...this.conns].filter((c) => c.plugin.manifest.id === pluginId && c.exporter);
      const conn = frames.find((c) => c.surface === "background") ?? frames[0];
      if (!conn) continue;
      try {
        out = await this.exportThrough(conn, out, mode);
      } catch (e) {
        console.warn(`Plugin "${pluginId}" couldn't transform the download:`, e);
      }
    }
    return out;
  }

  private exportThrough(conn: Conn, bytes: Uint8Array, mode: ExportMode): Promise<Uint8Array> {
    const id = this.nextExport++;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.exports.delete(id);
        reject(new Error("timed out"));
      }, EXPORT_TIMEOUT_MS);
      this.exports.set(id, (result) => {
        clearTimeout(timer);
        this.exports.delete(id);
        if (result.bytes instanceof Uint8Array) resolve(result.bytes);
        else reject(new Error(typeof result.error === "string" ? result.error : "no PDF returned"));
      });
      // A copy: the caller's bytes stay intact whatever the plugin does.
      conn.port.postMessage({ type: "export", id, mode, bytes: bytes.slice() });
    });
  }

  /**
   * Attach a mounted frame. The caller transfers the other end of `port` to
   * the frame in its boot message. Retained messages are replayed so a frame
   * that mounts late (a phone joining mid-talk) starts from the current state.
   */
  connect(plugin: LoadedPlugin, surface: PluginSurface, port: MessagePort, hooks: FrameHooks = {}): FrameLink {
    const conn: Conn = { plugin, surface, port, ...hooks };
    this.conns.add(conn);
    port.onmessage = (e) => this.onFrameMessage(conn, e.data);
    for (const event of this.retained.values()) {
      if (event.plugin === plugin.manifest.id) this.deliver(conn, event);
    }
    let view = FULL_VIEW;
    let page = FULL_PAGE;
    let hovered = false;
    return {
      disconnect: () => {
        this.conns.delete(conn);
        port.close();
      },
      setView: (next) => {
        if (next.x === view.x && next.y === view.y && next.w === view.w && next.h === view.h && next.scale === view.scale) return;
        view = next;
        port.postMessage({ type: "view", view });
      },
      setPage: (next) => {
        if (next.x === page.x && next.y === page.y && next.w === page.w && next.h === page.h) return;
        page = next;
        port.postMessage({ type: "page", page });
      },
      setHovered: (next) => {
        if (next === hovered) return;
        hovered = next;
        port.postMessage({ type: "hover", hovered });
      },
    };
  }

  /** A message from another device. */
  receive(event: WireEvent) {
    if (event.retain && event.from === "presenter") this.keepRetained(event);
    for (const conn of this.conns) {
      if (conn.plugin.manifest.id === event.plugin) this.deliver(conn, event);
    }
  }

  /**
   * Keep (or, for a null payload, forget) a retained message, within the
   * plugin's budget. Returns whether it's kept. Over budget, the message still
   * goes out live; it just isn't there for devices that join later.
   */
  private keepRetained(event: WireEvent): boolean {
    const key = retainKey(event.plugin, event.type);
    if (event.payload === null) {
      this.retained.delete(key);
      this.retainedSize.delete(key);
      this.schedulePersist();
      return false;
    }
    let size: number;
    try {
      size = JSON.stringify(event.payload).length;
    } catch {
      return false;
    }
    let count = 0;
    let bytes = 0;
    for (const [k, e] of this.retained) {
      if (e.plugin !== event.plugin || k === key) continue;
      count++;
      bytes += this.retainedSize.get(k) ?? 0;
    }
    if (count >= MAX_RETAINED_PER_PLUGIN || bytes + size > MAX_RETAINED_BYTES_PER_PLUGIN) {
      console.warn(`Plugin "${event.plugin}" is over its retained budget; "${event.type}" won't reach late joiners`);
      return false;
    }
    this.retained.set(key, { plugin: event.plugin, type: event.type, payload: event.payload, retain: event.retain || true, from: "presenter" });
    this.retainedSize.set(key, size);
    this.schedulePersist();
    return true;
  }

  private schedulePersist() {
    if (this.ctx.role !== "presenter" || this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.persistRetained(), PERSIST_DELAY_MS);
  }

  /** Save the presenter's retained messages for this session (see the constructor). */
  private persistRetained() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.ctx.role !== "presenter") return;
    const key = pluginRetainedKey(this.ctx.session.id);
    const events = [...this.retained.values()].map(({ plugin, type, payload, retain }) => ({ plugin, type, payload, retain }));
    if (events.length) lsSet(key, events);
    else lsRemove(key);
  }

  /** Retained messages from the server's snapshot, for a device (re)joining. */
  seedRetained(events: WireEvent[]) {
    for (const event of events) this.receive({ ...event, retain: event.retain === "deck" ? "deck" : true, from: "presenter" });
  }

  /** The deck was replaced: forget what was retained for it (retain: "deck"). */
  forgetDeckRetained() {
    for (const [key, event] of this.retained) {
      if (event.retain !== "deck") continue;
      this.retained.delete(key);
      this.retainedSize.delete(key);
    }
    this.schedulePersist();
  }

  retainedEvents(): WireEvent[] {
    return [...this.retained.values()];
  }

  private deliver(conn: Conn, event: WireEvent) {
    conn.port.postMessage({
      type: "message",
      message: { type: event.type, payload: event.payload, from: event.from ?? "presenter", sender: event.sender },
    });
  }

  private onFrameMessage(conn: Conn, m: { type?: string; [key: string]: unknown }) {
    if (m?.type === "send") {
      if (typeof m.msgType !== "string" || !TYPE_RE.test(m.msgType)) return;
      const event: WireEvent = {
        plugin: conn.plugin.manifest.id,
        type: m.msgType,
        payload: m.payload ?? null,
        retain: this.ctx.role === "presenter" && (m.retain === true || m.retain === "deck") ? m.retain : false,
        volatile: m.volatile === true,
        from: this.ctx.role,
      };
      if (event.retain) this.keepRetained(event);
      // The plugin's other frames on this page, then everyone else.
      for (const other of this.conns) {
        if (other !== conn && other.plugin.manifest.id === event.plugin) this.deliver(other, event);
      }
      this.outbound(event);
    } else if (m?.type === "storage") {
      this.onStorageSet(conn, m.key, m.value);
    } else if (m?.type === "visible") {
      conn.onVisible?.(m.visible === true);
    } else if (m?.type === "interactive") {
      conn.onInteractive?.(sanitizeInteractive(m.value));
    } else if (m?.type === "layers") {
      this.onLayers(conn, m as { slide?: unknown; items?: unknown; clear?: unknown });
    } else if (m?.type === "ready") {
      conn.onReady?.();
    } else if (m?.type === "button") {
      this.onButtonState(conn, m.id, m.state);
    } else if (m?.type === "exporter") {
      conn.exporter = m.on === true;
    } else if (m?.type === "exported") {
      if (typeof m.id === "number") this.exports.get(m.id)?.({ bytes: m.bytes, error: m.error });
    } else if (m?.type === "request") {
      void this.answer(conn, m.id, m.kind, m.args);
    }
  }

  private onButtonState(conn: Conn, id: unknown, state: unknown) {
    // Only the presenter's buttons exist, and only declared ones.
    if (this.ctx.role !== "presenter" || typeof state !== "object" || state === null) return;
    const { manifest } = conn.plugin;
    if (!manifest.contributes.buttons.some((b) => b.id === id)) return;
    const s = state as Record<string, unknown>;
    const next: ButtonState = {
      active: typeof s.active === "boolean" ? s.active : undefined,
      label: typeof s.label === "string" ? s.label.slice(0, 24) : undefined,
      disabled: typeof s.disabled === "boolean" ? s.disabled : undefined,
      menu: sanitizeMenu(s.menu),
    };
    const current = this.buttons.get(manifest.id) ?? {};
    this.buttons.set(manifest.id, { ...current, [id as string]: next });
    this.buttonListeners.forEach((l) => l());
  }

  private async answer(conn: Conn, id: unknown, kind: unknown, args: unknown) {
    const reply = (result: unknown, error?: string) => conn.port.postMessage({ type: "reply", id, result, error });
    const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
    const { manifest } = conn.plugin;
    switch (kind) {
      case "attachments": {
        if (!manifest.permissions.includes("deck")) {
          return reply(null, 'Reading the deck needs the "deck" permission in presio-plugin.json');
        }
        try {
          // Copies, so a plugin can't mutate the bytes the app itself renders from.
          const list = await this.attachments();
          return reply(list.map(({ filename, content }) => ({ filename, bytes: content.slice() })));
        } catch {
          return reply(null, "Couldn't read the deck's attachments");
        }
      }
      case "deckBytes": {
        if (!manifest.permissions.includes("deck")) {
          return reply(null, 'Reading the deck needs the "deck" permission in presio-plugin.json');
        }
        try {
          const bytes = await this.deckBytes();
          if (!bytes) return reply(null, "The deck hasn't loaded yet");
          return reply(bytes.slice());
        } catch {
          return reply(null, "Couldn't read the deck");
        }
      }
      case "pages": {
        if (!manifest.permissions.includes("deck")) {
          return reply(null, 'Reading the deck needs the "deck" permission in presio-plugin.json');
        }
        try {
          return reply(await this.pageSizes());
        } catch {
          return reply(null, "Couldn't read the deck's pages");
        }
      }
      case "saveDeck": {
        if (!manifest.permissions.includes("editDeck")) {
          return reply(null, 'Saving the deck needs the "editDeck" permission in presio-plugin.json');
        }
        if (this.ctx.role !== "presenter" || !this.saveDeck) return reply(null, "The deck can't be edited from here");
        if (!(a.bytes instanceof Uint8Array)) return reply(null, "save() takes the PDF as a Uint8Array");
        try {
          await this.saveDeck(a.bytes);
          return reply(null);
        } catch (e) {
          return reply(null, e instanceof Error ? e.message : "Couldn't save the deck");
        }
      }
      case "setSetting": {
        const spec = typeof a.name === "string" ? manifest.contributes.settings[a.name] : undefined;
        if (this.ctx.role !== "presenter") return reply(null, "Only the presenter can change settings");
        if (!spec) return reply(null, `No setting "${String(a.name)}" in presio-plugin.json`);
        if (sanitizeSettingValue(spec, a.value) === undefined) return reply(null, `Invalid value for "${a.name as string}"`);
        setPluginSetting(manifest.id, a.name as string, spec, a.value);
        return reply(null);
      }
      default:
        return reply(null, `Unknown request "${String(kind)}"`);
    }
  }
}

function sanitizeInteractive(value: unknown): Interactive {
  if (typeof value === "boolean") return value;
  if (!Array.isArray(value)) return false;
  return value.slice(0, 32).flatMap((raw) => {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const [x, y, w, h] = [r.x, r.y, r.w, r.h];
    return [x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v)) && (w as number) > 0 && (h as number) > 0
      ? [{ x: x as number, y: y as number, w: w as number, h: h as number }]
      : [];
  });
}

/** A deck replaced while its presenter's page wasn't open (from Home): forget
 *  the retained messages saved for it that belonged to the old deck. */
export function forgetDeckRetained(sessionId: string) {
  const key = pluginRetainedKey(sessionId);
  const saved = lsGet<unknown>(key, []);
  if (!Array.isArray(saved)) return;
  const kept = saved.filter((e) => (e as Partial<WireEvent>)?.retain !== "deck");
  if (kept.length) lsSet(key, kept);
  else lsRemove(key);
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
