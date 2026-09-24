// Types for `window.presio`, the API public/plugin-frame.html installs in the
// each plugin frame. Keep in step with that file and /plugins.md.

type Unsubscribe = () => void;

/** A still image on a slide, at page fractions (presio.layers). */
interface PresioLayerItem {
  x: number;
  y: number;
  w: number;
  h: number;
  /** data:image/…, blob: or https: URL. */
  image: string;
  fit?: "cover" | "contain";
}

interface PresioView {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

interface PresioMessage {
  type: string;
  payload: unknown;
  from: "presenter" | "audience";
  sender?: string;
}

interface Presio {
  readonly pluginId: string;
  /** The plugin's own folder, absolute: relative URLs resolve against it. */
  readonly baseUrl: string;
  readonly surface: "background" | "tile" | "viewer" | "slide";
  readonly role: "presenter" | "audience";
  readonly theme: "light" | "dark";
  readonly session: { id: string; local: boolean; joinUrl: string | null };
  readonly slide: {
    readonly current: number;
    readonly total: number;
    onChange(cb: (slide: { current: number; total: number }) => void): Unsubscribe;
  };
  onContextChange(cb: (presio: Presio) => void): Unsubscribe;
  /** retain: true for the session, "deck" until the deck is replaced; a
   *  retained null forgets the type. volatile: may be dropped, not queued. */
  send(type: string, payload?: unknown, opts?: { retain?: boolean | "deck"; volatile?: boolean }): void;
  onMessage(cb: (message: PresioMessage) => void): Unsubscribe;
  readonly settings: {
    get(name: string): unknown;
    readonly all: Record<string, unknown>;
    set(name: string, value: unknown): Promise<void>;
    onChange(cb: (settings: Record<string, unknown>) => void): Unsubscribe;
  };
  readonly storage: {
    get(key: string): unknown;
    readonly all: Record<string, unknown>;
    set(key: string, value?: unknown): void;
    onChange(cb: (storage: Record<string, unknown>) => void): Unsubscribe;
  };
  onButton(id: string, cb: (id: string) => void): Unsubscribe;
  /** A contributed keybinding's command (contributes.keybindings). */
  onCommand(command: string, cb: (command: string) => void): Unsubscribe;
  readonly deck: {
    attachments(): Promise<{ filename: string; bytes: Uint8Array }[]>;
    bytes(): Promise<Uint8Array>;
    /** Each page's size in PDF points, in page order. */
    pages(): Promise<{ width: number; height: number }[]>;
    save(bytes: Uint8Array): Promise<void>;
    /** "edit": the same pages edited in place; "replace": a different document. */
    onChange(cb: (kind: "edit" | "replace") => void): Unsubscribe;
    /** Transform the PDF this device downloads. */
    onExport(
      handler: (bytes: Uint8Array, info: { mode: "everything" | "no-attachments" }) => Uint8Array | Promise<Uint8Array>
    ): Unsubscribe;
  };
  readonly layers: {
    set(slide: number, items: PresioLayerItem[]): void;
    clear(): void;
  };
  readonly clock: { now(): number };
  readonly ui: {
    setVisible(visible: boolean): void;
    setInteractive(value: boolean | { x: number; y: number; w: number; h: number }[]): void;
    setButton(id: string, state: { active?: boolean; label?: string; disabled?: boolean }): void;
    /** Slide surface: the part of the page on screen (page fractions) and its zoom. */
    readonly view: PresioView;
    onViewChange(cb: (view: PresioView) => void): Unsubscribe;
    /** Slide surface: whether a mouse is over the slide. */
    readonly hovered: boolean;
    onHover(cb: (hovered: boolean) => void): Unsubscribe;
  };
}

declare const presio: Presio;
