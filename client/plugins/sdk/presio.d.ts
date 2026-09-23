// Types for `window.presio`, the API public/plugin-frame.html installs in the
// sandbox. Keep in step with that file and /plugins.md.

type Unsubscribe = () => void;

interface PresioMessage {
  type: string;
  payload: unknown;
  from: "presenter" | "audience";
  sender?: string;
}

interface Presio {
  readonly pluginId: string;
  readonly surface: "background" | "tile" | "viewer";
  readonly role: "presenter" | "audience";
  readonly theme: "light" | "dark";
  readonly session: { id: string; local: boolean; joinUrl: string | null };
  readonly slide: {
    readonly current: number;
    readonly total: number;
    onChange(cb: (slide: { current: number; total: number }) => void): Unsubscribe;
  };
  onContextChange(cb: (presio: Presio) => void): Unsubscribe;
  send(type: string, payload?: unknown, opts?: { retain?: boolean }): void;
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
  readonly deck: {
    attachments(): Promise<{ filename: string; bytes: Uint8Array }[]>;
    bytes(): Promise<Uint8Array>;
    save(bytes: Uint8Array): Promise<void>;
    onChange(cb: () => void): Unsubscribe;
  };
  readonly ui: {
    setVisible(visible: boolean): void;
    setButton(id: string, state: { active?: boolean; label?: string; disabled?: boolean }): void;
  };
}

declare const presio: Presio;
