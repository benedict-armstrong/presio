// The socket protocol's shapes: the events each side sends, and what a
// connection keeps (socket.data). Payloads from clients are untrusted, so the
// handlers take them as unknown and check them.

import type { Server, Socket } from "socket.io";

type Ack = (reply: unknown) => void;

export interface ClientToServerEvents {
  join_session: (raw: unknown) => void;
  slide_change: (raw: unknown) => void;
  sync_all: () => void;
  total_slides_change: (raw: unknown) => void;
  blank_toggle: () => void;
  plugins_publish: (raw: unknown) => void;
  plugin_settings: (raw: unknown) => void;
  plugin_event: (raw: unknown) => void;
  plugin_load_failed: (raw: unknown) => void;
  history_sync: (raw: unknown, ack?: Ack) => void;
  history_commit: (raw: unknown, ack?: Ack) => void;
  history_seed: (raw: unknown, ack?: Ack) => void;
  history_snapshot: (raw: unknown, ack?: Ack) => void;
  history_reset: (raw: unknown) => void;
  time_ping: (clientT1: unknown, ack?: (data: { serverTime: number; clientT1: unknown }) => void) => void;
}

export interface ServerToClientEvents {
  error: (e: { message: string }) => void;
  session_state: (s: { currentSlide: number; totalSlides: number; role: "controller" | "viewer" }) => void;
  controller_replaced: () => void;
  slide_update: (s: { slideNumber: number }) => void;
  sync_all: () => void;
  total_slides_update: (s: { totalSlides: number }) => void;
  blank_update: (s: { blanked: boolean }) => void;
  deck_updated: (d: { filename: string; totalSlides: number }) => void;
  session_ended: () => void;
  plugins_state: (s: unknown) => void;
  plugin_settings: (s: { plugin: string; settings: Record<string, unknown> }) => void;
  plugin_event: (e: { plugin: string; type: string; payload: unknown; from: "presenter" | "audience"; sender?: string }) => void;
  plugin_load_failed: (f: { plugin: string; hash: string; reason: string; sender: string }) => void;
  history_entry: (e: { plugin: string; entry: unknown }) => void;
  history_reset: (r: { plugin: string }) => void;
}

interface TokenBucket {
  tokens: number;
  last: number;
}

/** What a connection keeps. */
export interface SocketData {
  sessionId?: string;
  role?: "controller" | "viewer";
  /** The session's page count, for validating slide numbers. */
  totalSlides?: number;
  joinBucket?: TokenBucket;
  pluginBucket?: TokenBucket;
}

export type PresioServer = Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;
export type PresioSocket = Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;

/** The typed view of a server created without the event maps (index.ts, tests). */
export const typed = (io: Server) => io as unknown as PresioServer;
