// The app side of the plugin bridge. One PluginHost per open presentation owns
// every mounted plugin frame's MessagePort, keeps them up to date (slide,
// session, theme), answers their requests, and routes their messages: to the
// plugin's other frames on this page, and out through a transport (socket or
// BroadcastChannel, see usePluginHost) to its frames on other devices.

import type { PdfAttachment } from "@/lib/pdf";
import { lsGet, lsSet, pluginStateKey } from "@/lib/storage";
import { clockOffset } from "@/lib/clock";
import { DEFAULT_KEYMAP, formatBinding, pluginBindings, type Keymap } from "@/lib/keymap";
import type { LoadedPlugin, PluginSurface } from "./manifest";
import { HistoryHub, type HistoryFrameMessage } from "./history";
import { jsonBytes, MAX_PLUGIN_MESSAGE_BYTES, MAX_PLUGIN_STORAGE_BYTES, PLUGIN_TYPE_RE } from "@shared/pluginProtocol";
import {
  FULL_PAGE,
  FULL_VIEW,
  type ButtonFile,
  type ButtonState,
  type DeckChange,
  type ExportMode,
  type FrameContext,
  type FrameHooks,
  type FrameToHost,
  type HostToFrame,
  type FrameLink,
  type LayerItem,
  type PageSize,
  type PluginContext,
  type PluginLayer,
  type WireEvent,
} from "./protocol";
import { RetainedStore } from "./retained";
import { PendingCalls } from "./pendingCalls";
import { answerRequest, type RequestEnv } from "./requests";
import { sanitizeButtonState, sanitizeInteractive, sanitizeLayerItems } from "./sanitize";

interface Conn extends FrameHooks {
  plugin: LoadedPlugin;
  surface: PluginSurface;
  port: MessagePort;
  /** It registered presio.deck.onExport. */
  exporter?: boolean;
  /** It opened presio.history (and can take snapshots of it). */
  history?: boolean;
  snapshots?: boolean;
}

const NO_LAYERS: PluginLayer[] = [];
const NO_BUTTONS: Record<string, ButtonState> = {};
/** How long one plugin may take over its part of a download. */
const EXPORT_TIMEOUT_MS = 60_000;
/** How long a frame may take to hand over a snapshot of its history. */
const SNAPSHOT_TIMEOUT_MS = 10_000;
/** An op's id, as a frame makes it. */
const OP_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

export class PluginHost {
  private conns = new Set<Conn>();
  private readonly retained: RetainedStore;
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
  private keymap: Keymap = DEFAULT_KEYMAP;
  // Running plugins in the presenter's order: the order exports apply in.
  private running: readonly string[] = [];
  private exports = new PendingCalls<{ bytes?: unknown; error?: unknown }>(EXPORT_TIMEOUT_MS);
  private snapshots = new PendingCalls<{ seq?: unknown; data?: unknown }>(SNAPSHOT_TIMEOUT_MS);
  /** Plugins' edit histories (presio.history), and the way to other devices'. */
  readonly history: HistoryHub;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.history = new HistoryHub({
      deck: ctx.session.id,
      presenter: ctx.role === "presenter",
      deliver: (plugin, message) => this.deliverHistory(plugin, message),
      requestSnapshot: (plugin) => this.requestSnapshot(plugin),
    });
    this.retained = new RetainedStore(() => ({ presenter: this.ctx.role === "presenter", sessionId: this.ctx.session.id }));
  }

  // Changes not yet saved when the page goes: save them now.
  private readonly onPageHide = () => this.retained.flush();

  /** Start listening to the page. Pair with dispose() (an effect's mount and cleanup). */
  attach() {
    window.addEventListener("pagehide", this.onPageHide);
    this.history.attach();
  }

  /** Stop listening, saving what's pending first. attach() may follow (StrictMode). */
  dispose() {
    window.removeEventListener("pagehide", this.onPageHide);
    this.onPageHide();
    this.history.dispose();
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
    for (const conn of this.conns) post(conn.port, { type: "deck", kind });
    // Histories are the deck's: one with a different page count is a
    // different document (see HistoryHub.setPages).
    void pages().then(
      (sizes) => { if (sizes.length && this.deckBytes === bytes) this.history.setPages(sizes.length); },
      () => {}
    );
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
    this.history.setDeck(next.session.id);
    this.history.setPresenter(next.role === "presenter");
    const slideChanged = prev.slide.current !== next.slide.current || prev.slide.total !== next.slide.total;
    const otherChanged =
      prev.role !== next.role ||
      prev.theme !== next.theme ||
      prev.session.id !== next.session.id ||
      prev.session.local !== next.session.local ||
      prev.session.joinUrl !== next.session.joinUrl;
    for (const conn of this.conns) {
      if (otherChanged) post(conn.port, { type: "context", context: this.frameContext(conn.plugin, conn.surface) });
      else if (slideChanged) post(conn.port, { type: "slide", slide: next.slide });
    }
  }

  frameContext(plugin: LoadedPlugin, surface: PluginSurface): FrameContext {
    const pluginId = plugin.manifest.id;
    return {
      pluginId,
      surface,
      ...this.ctx,
      settings: this.settings.get(pluginId) ?? {},
      storage: this.readStorage(pluginId),
      clockOffset: this.clock,
      shortcuts: this.shortcuts(plugin),
      baseUrl: plugin.baseUrl,
      view: FULL_VIEW,
      page: FULL_PAGE,
      hovered: false,
    };
  }

  /** Each of a plugin's commands' key, as the presenter sees it ("E", "⌘Z"). */
  private shortcuts(plugin: LoadedPlugin): Record<string, string> {
    const out: Record<string, string> = {};
    for (const kb of plugin.manifest.contributes.keybindings) {
      const first = pluginBindings(this.keymap, plugin.manifest.id, kb)[0];
      if (first) out[kb.command] = formatBinding(first);
    }
    return out;
  }

  /** The presenter's keyboard shortcuts changed (presio.shortcut). */
  setKeymap(keymap: Keymap) {
    if (keymap === this.keymap) return;
    this.keymap = keymap;
    for (const conn of this.conns) post(conn.port, { type: "shortcuts", shortcuts: this.shortcuts(conn.plugin) });
  }

  /** The server clock moved (lib/clock.ts); frames keep their own copy. */
  setClockOffset(offset: number) {
    if (Math.abs(offset - this.clock) < 1) return;
    this.clock = offset;
    for (const conn of this.conns) post(conn.port, { type: "clock", offset });
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

  private onLayers(conn: Conn, m: Extract<FrameToHost, { type: "layers" }>) {
    const pluginId = conn.plugin.manifest.id;
    if (m.clear === true) {
      if (this.layers.delete(pluginId)) this.layersChanged();
      return;
    }
    const slide = m.slide;
    if (typeof slide !== "number" || !Number.isInteger(slide) || slide < 1 || slide > 10_000) return;
    const items: LayerItem[] = sanitizeLayerItems(m.items);
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
    const pluginId = conn.plugin.manifest.id;
    // The frame already applied the write to its own copy; when it's refused,
    // hand back what is actually stored so the two don't disagree.
    const refuse = () => post(conn.port, { type: "storage", storage: this.readStorage(pluginId) });
    // A local deck's viewer window shares this browser's storage; only the
    // presenter's frames write it.
    if (this.ctx.role !== "presenter" || typeof key !== "string" || !PLUGIN_TYPE_RE.test(key)) return refuse();
    const next = { ...this.readStorage(pluginId) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    if (jsonBytes(next) > MAX_PLUGIN_STORAGE_BYTES) {
      console.warn(`Plugin "${pluginId}" is over its storage limit; "${key}" wasn't saved`);
      return refuse();
    }
    const storeKey = pluginStateKey(this.ctx.session.id);
    const all = lsGet<Record<string, unknown>>(storeKey, {});
    lsSet(storeKey, { ...all, [pluginId]: next });
    for (const other of this.conns) {
      if (other !== conn && other.plugin.manifest.id === pluginId) post(other.port, { type: "storage", storage: next });
    }
  }

  /** A plugin's resolved settings changed (or arrived from the presenter). */
  setPluginSettings(pluginId: string, values: Record<string, unknown>) {
    const prev = this.settings.get(pluginId);
    if (prev && JSON.stringify(prev) === JSON.stringify(values)) return;
    this.settings.set(pluginId, values);
    for (const conn of this.conns) {
      if (conn.plugin.manifest.id === pluginId) post(conn.port, { type: "settings", settings: values });
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
    for (const conn of this.handlerFrames(pluginId)) post(conn.port, { type: "button", id: buttonId, file });
  }

  /** The presenter picked an item from a button's menu; delivered like a press. */
  pickMenuItem(pluginId: string, buttonId: string, itemId: string) {
    for (const conn of this.handlerFrames(pluginId)) post(conn.port, { type: "menu", id: buttonId, item: itemId });
  }

  /** The presenter pressed one of a plugin's keybindings; delivered like a button. */
  runCommand(pluginId: string, command: string) {
    for (const conn of this.handlerFrames(pluginId)) post(conn.port, { type: "command", id: command });
  }

  private handlerFrames(pluginId: string): Conn[] {
    const mine = [...this.conns].filter((c) => c.plugin.manifest.id === pluginId);
    const background = mine.filter((c) => c.surface === "background");
    return background.length ? background : mine.filter((c) => c.surface === "tile");
  }

  // --- Histories (presio.history) ---

  private deliverHistory(plugin: string, message: HistoryFrameMessage) {
    for (const conn of this.conns) {
      if (conn.history && conn.plugin.manifest.id === plugin) post(conn.port, { type: "history", ...message });
    }
  }

  /** Ask one of a plugin's frames (its background, if open) for a snapshot. */
  private async requestSnapshot(plugin: string): Promise<{ seq: number; data: unknown } | null> {
    const frames = [...this.conns].filter((c) => c.plugin.manifest.id === plugin && c.history && c.snapshots);
    const conn = frames.find((c) => c.surface === "background") ?? frames[0];
    if (!conn) return null;
    // No answer in time is no snapshot: the history goes on without one.
    const reply = await this.snapshots.start((id) => post(conn.port, { type: "history", kind: "snapshot", id })).catch(() => null);
    if (!reply) return null;
    const { seq, data } = reply;
    return typeof seq === "number" && Number.isInteger(seq) && data !== undefined ? { seq, data } : null;
  }

  private onHistoryMessage(conn: Conn, m: Extract<FrameToHost, { type: "history" }>) {
    const plugin = conn.plugin.manifest.id;
    if (!conn.plugin.manifest.permissions.includes("history")) {
      console.warn(`Plugin "${plugin}" needs the "history" permission for presio.history`);
      return;
    }
    if (m.kind === "open") {
      conn.history = true;
      conn.snapshots = m.snapshots === true;
      this.history.open(plugin);
    } else if (m.kind === "commit") {
      if (typeof m.id !== "string" || !OP_ID_RE.test(m.id)) return;
      const result = this.history.commit(plugin, m.id, m.op);
      if (result) post(conn.port, { type: "history", kind: "error", id: m.id, error: result });
    } else if (m.kind === "snapshot") {
      this.snapshots.settle(m.id, { seq: m.seq, data: m.data });
    }
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

  private async exportThrough(conn: Conn, bytes: Uint8Array, mode: ExportMode): Promise<Uint8Array> {
    // A copy: the caller's bytes stay intact whatever the plugin does.
    const result = await this.exports.start((id) => post(conn.port, { type: "export", id, mode, bytes: bytes.slice() }));
    if (result.bytes instanceof Uint8Array) return result.bytes;
    throw new Error(typeof result.error === "string" ? result.error : "no PDF returned");
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
    for (const event of this.retained.all()) {
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
        post(port, { type: "view", view });
      },
      setPage: (next) => {
        if (next.x === page.x && next.y === page.y && next.w === page.w && next.h === page.h) return;
        page = next;
        post(port, { type: "page", page });
      },
      setHovered: (next) => {
        if (next === hovered) return;
        hovered = next;
        post(port, { type: "hover", hovered });
      },
    };
  }

  /** A message from another device. */
  receive(event: WireEvent) {
    if (event.retain && event.from === "presenter") this.retained.keep(event);
    for (const conn of this.conns) {
      if (conn.plugin.manifest.id === event.plugin) this.deliver(conn, event);
    }
  }


  /** Retained messages from the server's snapshot, for a device (re)joining. */
  seedRetained(events: WireEvent[]) {
    for (const event of events) this.receive({ ...event, retain: event.retain === "deck" ? "deck" : true, from: "presenter" });
  }

  /** The deck was replaced: forget what was retained for it (retain: "deck"). */
  forgetDeckRetained() {
    this.retained.forgetDeck();
  }

  retainedEvents(): WireEvent[] {
    return this.retained.all();
  }

  private deliver(conn: Conn, event: WireEvent) {
    post(conn.port, {
      type: "message",
      message: { type: event.type, payload: event.payload, from: event.from ?? "presenter", sender: event.sender },
    });
  }

  private onFrameMessage(conn: Conn, m: FrameToHost) {
    const handle = this.frameHandlers[m?.type] as ((conn: Conn, m: FrameToHost) => void) | undefined;
    handle?.(conn, m);
  }

  /** What each frame message does, by type. */
  private readonly frameHandlers: { [T in FrameToHost["type"]]: (conn: Conn, m: Extract<FrameToHost, { type: T }>) => void } = {
    send: (conn, m) => this.onSend(conn, m),
    storage: (conn, m) => this.onStorageSet(conn, m.key, m.value),
    visible: (conn, m) => conn.onVisible?.(m.visible === true),
    interactive: (conn, m) => conn.onInteractive?.(sanitizeInteractive(m.value)),
    layers: (conn, m) => this.onLayers(conn, m),
    ready: (conn) => conn.onReady?.(),
    button: (conn, m) => this.onButtonState(conn, m.id, m.state),
    exporter: (conn, m) => { conn.exporter = m.on === true; },
    exported: (_conn, m) => this.exports.settle(m.id, { bytes: m.bytes, error: m.error }),
    history: (conn, m) => this.onHistoryMessage(conn, m),
    request: (conn, m) => void this.answer(conn, m.id, m.kind, m.args),
  };

  /** presio.send: to the plugin's other frames here, then out to other devices. */
  private onSend(conn: Conn, m: Extract<FrameToHost, { type: "send" }>) {
    if (typeof m.msgType !== "string" || !PLUGIN_TYPE_RE.test(m.msgType)) return;
    // The server drops what's over the cap, so this device's other frames
    // mustn't see it either (nor keep it, to be re-sent on every join).
    if (jsonBytes(m.payload ?? null) > MAX_PLUGIN_MESSAGE_BYTES) {
      console.warn(`Plugin "${conn.plugin.manifest.id}": "${m.msgType}" is over ${MAX_PLUGIN_MESSAGE_BYTES / 1024} KB of JSON and wasn't sent`);
      return;
    }
    const event: WireEvent = {
      plugin: conn.plugin.manifest.id,
      type: m.msgType,
      payload: m.payload ?? null,
      retain: this.ctx.role === "presenter" && (m.retain === true || m.retain === "deck") ? m.retain : false,
      volatile: m.volatile === true,
      from: this.ctx.role,
    };
    if (event.retain) this.retained.keep(event);
    for (const other of this.conns) {
      if (other !== conn && other.plugin.manifest.id === event.plugin) this.deliver(other, event);
    }
    this.outbound(event);
  }

  private onButtonState(conn: Conn, id: unknown, state: unknown) {
    // Only the presenter's buttons exist, and only declared ones.
    const next = sanitizeButtonState(state);
    if (this.ctx.role !== "presenter" || !next) return;
    const { manifest } = conn.plugin;
    if (!manifest.contributes.buttons.some((b) => b.id === id)) return;
    const current = this.buttons.get(manifest.id) ?? {};
    this.buttons.set(manifest.id, { ...current, [id as string]: next });
    this.buttonListeners.forEach((l) => l());
  }

  private async answer(conn: Conn, id: unknown, kind: unknown, args: unknown) {
    const { result, error } = await answerRequest(this.requestEnv(), conn.plugin.manifest, kind, args);
    post(conn.port, { type: "reply", id, result, error });
  }

  private requestEnv(): RequestEnv {
    return {
      role: this.ctx.role,
      attachments: this.attachments,
      deckBytes: this.deckBytes,
      pageSizes: this.pageSizes,
      saveDeck: this.saveDeck,
      history: this.history,
    };
  }
}

/** Send a frame one of the messages it understands. */
function post(port: MessagePort, m: HostToFrame) {
  port.postMessage(m);
}
