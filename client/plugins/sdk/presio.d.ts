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

/** A row of a button's menu (presio.ui.setButton's `menu`). */
type PresioMenuEntry =
  | { id: string; label: string; checked?: boolean; disabled?: boolean }
  | { heading: string }
  | { separator: true };

/** A file the presenter picked for a button with "accept". */
interface PresioFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

interface PresioMessage {
  type: string;
  payload: unknown;
  from: "presenter" | "audience";
  sender?: string;
}

/** An op's place in a history (presio.history), as apply() sees it. */
interface PresioHistoryEntryInfo {
  id: string;
  /** The device that committed it (compare with PresioHistory.device). */
  by: string | null;
  /** Server time it was ordered at; absent while pending. */
  at?: number;
  /** Its place in the order; absent while pending. */
  seq?: number;
  pending: boolean;
}

interface PresioHistorySpec<S, Op> {
  init(): S;
  /** The next state; must not change the one it's given. */
  apply(state: S, op: Op, entry: PresioHistoryEntryInfo): S;
  /** JSON the history can start from, for a history that grows. */
  snapshot?(state: S): unknown;
  restore?(snapshot: unknown): S;
}

interface PresioHistory<S, Op> {
  /** Ordered entries applied to init(), then this device's pending ops. */
  readonly state: S;
  /** The ordered entries only: what every device agrees on. */
  readonly confirmed: S;
  readonly ready: boolean;
  whenReady(): Promise<PresioHistory<S, Op>>;
  /** This browser's id: entries' `by`. */
  readonly device: string | null;
  /** Presenter: add an op (JSON, at most 16 KB). Returns its id. */
  commit(op: Op): string;
  /** This device's ops, newest first; seq is null while pending. */
  mine(): { id: string; op: Op; seq: number | null }[];
  onChange(cb: (state: S, change: { kind: "state" | "entry" | "pending"; entry?: unknown }) => void): Unsubscribe;
  onError(cb: (id: string, message: string) => void): Unsubscribe;
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
  /** A contributed button was pressed; one with "accept" brings the file picked. */
  onButton(id: string, cb: (id: string, file?: PresioFile) => void): Unsubscribe;
  /** An item was picked from a button's menu. */
  onMenu(id: string, cb: (item: string, id: string) => void): Unsubscribe;
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
  /** The deck's edit history ("history" permission): open once per frame. */
  readonly history: {
    open<S, Op = unknown>(spec: PresioHistorySpec<S, Op>): PresioHistory<S, Op>;
  };
  /** Content-addressed bytes ("history"): put resolves to the SHA-256. */
  readonly blobs: {
    put(data: Blob | Uint8Array | ArrayBuffer): Promise<string>;
    get(sha: string): Promise<Blob | null>;
  };
  readonly ui: {
    setVisible(visible: boolean): void;
    setInteractive(value: boolean | "pen" | { x: number; y: number; w: number; h: number }[]): void;
    setButton(id: string, state: { active?: boolean; label?: string; disabled?: boolean; menu?: PresioMenuEntry[] }): void;
    /** Slide surface: the part of it on screen (fractions of it) and its zoom. */
    readonly view: PresioView;
    onViewChange(cb: (view: PresioView) => void): Unsubscribe;
    /** Slide surface: where the page is within it (fractions of it) — all of
     *  it unless the manifest has "slideSurface": "area". */
    readonly page: { x: number; y: number; w: number; h: number };
    onPageChange(cb: (page: { x: number; y: number; w: number; h: number }) => void): Unsubscribe;
    /** Slide surface: whether a mouse is over the slide. */
    readonly hovered: boolean;
    onHover(cb: (hovered: boolean) => void): Unsubscribe;
  };
}

declare const presio: Presio;
