// The shapes that cross the plugin bridge: what the app tells a plugin frame
// about its context and view, and what plugins send between devices.

import type { Retain } from "@shared/pluginProtocol";
import type { HistoryFrameMessage } from "./history";
import type { PluginSurface } from "./manifest";

export type PluginRole = "presenter" | "audience";

export interface PluginContext {
  role: PluginRole;
  theme: "light" | "dark";
  session: { id: string; local: boolean; joinUrl: string | null };
  slide: { current: number; total: number };
}

export type { Retain };

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

/** Where a slide surface takes pointer input: none, all, some areas, or
 *  "pen": a pen's and a mouse's, while fingers stay Presio's (pan, pinch, tap
 *  to turn the page) — the plugin still sees them. */
export type Interactive = boolean | "pen" | { x: number; y: number; w: number; h: number }[];

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

/** What a frame is told about itself at boot and on a "context" message. */
export interface FrameContext extends PluginContext {
  pluginId: string;
  surface: PluginSurface;
  settings: Record<string, unknown>;
  storage: Record<string, unknown>;
  clockOffset: number;
  /** Each command's key, as the presenter sees it ("E", "⌘Z"). */
  shortcuts: Record<string, string>;
  baseUrl: string;
  view: SlideView;
  page: SlidePage;
  hovered: boolean;
}

/** Everything the app sends a frame over its port (plugin-frame.html reads these). */
export type HostToFrame =
  | { type: "context"; context: FrameContext }
  | { type: "slide"; slide: PluginContext["slide"] }
  | { type: "deck"; kind: DeckChange }
  | { type: "shortcuts"; shortcuts: Record<string, string> }
  | { type: "clock"; offset: number }
  | { type: "storage"; storage: Record<string, unknown> }
  | { type: "settings"; settings: Record<string, unknown> }
  | { type: "view"; view: SlideView }
  | { type: "page"; page: SlidePage }
  | { type: "hover"; hovered: boolean }
  | { type: "button"; id: string; file?: ButtonFile }
  | { type: "menu"; id: string; item: string }
  | { type: "command"; id: string }
  | { type: "export"; id: number; mode: ExportMode; bytes: Uint8Array }
  | ({ type: "history" } & (HistoryFrameMessage | { kind: "snapshot"; id: number }))
  | { type: "message"; message: { type: string; payload: unknown; from: PluginRole; sender?: string } }
  | { type: "reply"; id: unknown; result: unknown; error?: string };

/**
 * Everything a frame sends the app. Frames are plugin code, so every field is
 * unknown until the handler for its type has checked it.
 */
export type FrameToHost =
  | { type: "send"; msgType?: unknown; payload?: unknown; retain?: unknown; volatile?: unknown }
  | { type: "storage"; key?: unknown; value?: unknown }
  | { type: "visible"; visible?: unknown }
  | { type: "interactive"; value?: unknown }
  | { type: "layers"; slide?: unknown; items?: unknown; clear?: unknown }
  | { type: "ready" }
  | { type: "button"; id?: unknown; state?: unknown }
  | { type: "exporter"; on?: unknown }
  | { type: "exported"; id?: unknown; bytes?: unknown; error?: unknown }
  | { type: "history"; kind?: unknown; id?: unknown; op?: unknown; snapshots?: unknown; seq?: unknown; data?: unknown }
  | { type: "request"; id?: unknown; kind?: unknown; args?: unknown };
