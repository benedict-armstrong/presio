// What the socket layer keeps per session, beside the database: who
// controls it, the plugins' shared state, and their histories.

import type { Server } from "socket.io";
import type { PublishedPlugin, Retain } from "../../shared/pluginProtocol.js";
import { HistoryStore, type HistoryBucket } from "../history.js";
import { typed } from "./types.js";

// A presenter plugin message kept for viewers who join later (the plugin's
// current "state of the world": which poll is open, whether the join code is
// up, the media showing).
export interface RetainedPluginEvent {
  plugin: string;
  type: string;
  payload: unknown;
  /** true for the session, "deck" until the deck is replaced. */
  retain: Exclude<Retain, false>;
  /** The payload's size as JSON, for the per-plugin budget. */
  size: number;
}

export interface SocketState {
  // Which socket is the controller for each session.
  controllers: Map<string, string>;
  // Blanked state per session (transient, no DB persistence).
  blankedSessions: Set<string>;
  // The plugins the controller published for viewers to run (where to load
  // each and its hash), per session.
  publishedPlugins: Map<string, Map<string, PublishedPlugin>>;
  // Retained presenter plugin messages per session, keyed plugin + type.
  pluginRetained: Map<string, Map<string, RetainedPluginEvent>>;
  // The presenter's settings for each plugin, which viewers run with.
  pluginSettings: Map<string, Map<string, Record<string, unknown>>>;
  // Plugins' edit histories (presio.history) and their blobs, per session.
  history: HistoryStore;
}

/** Fresh state; `bucket` is where plugin histories are kept (history.ts). */
export function createSocketState(bucket?: HistoryBucket): SocketState {
  const history = new HistoryStore();
  if (bucket) history.setBucket(bucket);
  return {
    controllers: new Map(),
    blankedSessions: new Set(),
    publishedPlugins: new Map(),
    pluginRetained: new Map(),
    pluginSettings: new Map(),
    history,
  };
}

// Drop a session's transient socket state (on end / expiry).
export function clearSessionState(state: SocketState, sessionId: string) {
  state.controllers.delete(sessionId);
  state.blankedSessions.delete(sessionId);
  state.publishedPlugins.delete(sessionId);
  state.pluginRetained.delete(sessionId);
  state.pluginSettings.delete(sessionId);
  void state.history.drop(sessionId).catch((err) => console.warn(`Couldn't drop the history of session ${sessionId}:`, err));
}

// The session's deck was replaced: its sockets check slide numbers against
// the new page count (a controller's slide_change is refused past it).
export async function setRoomTotalSlides(io: Server, sessionId: string, totalSlides: number) {
  for (const socket of await typed(io).in(sessionId).fetchSockets()) socket.data.totalSlides = totalSlides;
}

// The session's deck was replaced: forget what plugins retained for the old
// one (retain: "deck" — e.g. drawings, keyed by slide number). The presenter's
// page does the same when it swaps the deck in.
export function forgetDeckRetained(state: SocketState, sessionId: string) {
  const retained = state.pluginRetained.get(sessionId);
  if (!retained) return;
  for (const [key, event] of retained) {
    if (event.retain === "deck") retained.delete(key);
  }
}
