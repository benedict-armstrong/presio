// The app side of the plugin bridge. One PluginHost per open presentation owns
// every mounted plugin frame's MessagePort, keeps them up to date (slide,
// session, theme), answers their requests, and routes their messages: to the
// plugin's other frames on this page, and out through a transport (socket or
// BroadcastChannel, see usePluginHost) to its frames on other devices.

import type { PdfAttachment } from "@/lib/pdf";
import { lsGet, lsSet, pluginStateKey } from "@/lib/storage";
import type { LoadedPlugin, PluginSurface } from "./manifest";

export type PluginRole = "presenter" | "audience";

export interface PluginContext {
  role: PluginRole;
  theme: "light" | "dark";
  session: { id: string; local: boolean; joinUrl: string | null };
  slide: { current: number; total: number };
}

/** A plugin message as it travels between devices. */
export interface WireEvent {
  plugin: string;
  type: string;
  payload: unknown;
  retain?: boolean;
  from?: PluginRole;
  sender?: string;
}

/** What a plugin has set on one of its contributed buttons. */
export interface ButtonState {
  active?: boolean;
  label?: string;
  disabled?: boolean;
}

interface Conn {
  plugin: LoadedPlugin;
  surface: PluginSurface;
  port: MessagePort;
  onVisible?: (visible: boolean) => void;
}

const TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** What one plugin may keep in presio.storage for one session, as JSON. */
const STORAGE_LIMIT = 16 * 1024;
const NO_BUTTONS: Record<string, ButtonState> = {};
const retainKey = (plugin: string, type: string) => `${plugin}\u0000${type}`;

export class PluginHost {
  private conns = new Set<Conn>();
  private retained = new Map<string, WireEvent>();
  private ctx: PluginContext;
  private outbound: (event: WireEvent) => void = () => {};
  private attachments: () => Promise<PdfAttachment[]> = async () => [];
  private settings = new Map<string, Record<string, unknown>>();
  private buttons = new Map<string, Record<string, ButtonState>>();
  private buttonListeners = new Set<() => void>();

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  /** Where this device's outgoing messages go (the transport). */
  setOutbound(send: (event: WireEvent) => void) {
    this.outbound = send;
  }

  setAttachmentSource(read: () => Promise<PdfAttachment[]>) {
    this.attachments = read;
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
    };
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
   * plugin running both doesn't act twice.
   */
  pressButton(pluginId: string, buttonId: string) {
    const mine = [...this.conns].filter((c) => c.plugin.manifest.id === pluginId);
    const target = mine.filter((c) => c.surface === "background");
    for (const conn of target.length ? target : mine.filter((c) => c.surface === "tile")) {
      conn.port.postMessage({ type: "button", id: buttonId });
    }
  }

  /**
   * Attach a mounted frame. The caller transfers the other end of `port` to
   * the frame in its boot message. Retained messages are replayed so a frame
   * that mounts late (a phone joining mid-talk) starts from the current state.
   */
  connect(
    plugin: LoadedPlugin,
    surface: PluginSurface,
    port: MessagePort,
    onVisible?: (visible: boolean) => void
  ): () => void {
    const conn: Conn = { plugin, surface, port, onVisible };
    this.conns.add(conn);
    port.onmessage = (e) => this.onFrameMessage(conn, e.data);
    for (const event of this.retained.values()) {
      if (event.plugin === plugin.manifest.id) this.deliver(conn, event);
    }
    return () => {
      this.conns.delete(conn);
      port.close();
    };
  }

  /** A message from another device. */
  receive(event: WireEvent) {
    if (event.retain && event.from === "presenter") {
      this.retained.set(retainKey(event.plugin, event.type), event);
    }
    for (const conn of this.conns) {
      if (conn.plugin.manifest.id === event.plugin) this.deliver(conn, event);
    }
  }

  /** Retained messages from the server's snapshot, for a device (re)joining. */
  seedRetained(events: WireEvent[]) {
    for (const event of events) this.receive({ ...event, retain: true, from: "presenter" });
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
        retain: this.ctx.role === "presenter" && m.retain === true,
        from: this.ctx.role,
      };
      if (event.retain) this.retained.set(retainKey(event.plugin, event.type), event);
      // The plugin's other frames on this page, then everyone else.
      for (const other of this.conns) {
        if (other !== conn && other.plugin.manifest.id === event.plugin) this.deliver(other, event);
      }
      this.outbound(event);
    } else if (m?.type === "storage") {
      this.onStorageSet(conn, m.key, m.value);
    } else if (m?.type === "visible") {
      conn.onVisible?.(m.visible === true);
    } else if (m?.type === "button") {
      this.onButtonState(conn, m.id, m.state);
    } else if (m?.type === "request") {
      void this.answer(conn, m.id, m.kind);
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
    };
    const current = this.buttons.get(manifest.id) ?? {};
    this.buttons.set(manifest.id, { ...current, [id as string]: next });
    this.buttonListeners.forEach((l) => l());
  }

  private async answer(conn: Conn, id: unknown, kind: unknown) {
    const reply = (result: unknown, error?: string) => conn.port.postMessage({ type: "reply", id, result, error });
    if (kind !== "attachments") return reply(null, `Unknown request "${String(kind)}"`);
    if (!conn.plugin.manifest.permissions.includes("deck")) {
      return reply(null, 'Reading the deck needs the "deck" permission in presio-plugin.json');
    }
    try {
      // Copies, so a plugin can't mutate the bytes the app itself renders from.
      const list = await this.attachments();
      reply(list.map(({ filename, content }) => ({ filename, bytes: content.slice() })));
    } catch {
      reply(null, "Couldn't read the deck's attachments");
    }
  }
}
