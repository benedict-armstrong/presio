// Who may send what: the controller-only guard, and the token buckets that
// throttle the events anyone may send.

import type { SocketState } from "./state.js";
import type { PresioSocket, SocketData } from "./types.js";

// --- join_session throttling ---
//
// Only join_session is throttled, and deliberately so. Every other event is
// wrapped in controllerOnly(), meaning the socket already proved the controller
// token to reach it — and those are exactly the events that are legitimately
// high-frequency: slide_change and the presenter's plugin_event (a drawing's
// strokes and laser at pointer rate, the media plugin's time sync). Presenting
// a long deck, or scrubbing back and forth through hundreds of slides, must
// never be rate limited, so it isn't.
//
// join_session is the exception because it is unauthenticated, queries the DB
// on every call, and its reply reveals whether a 6-character code exists —
// an enumeration oracle. Unthrottled, a single socket sustained ~133 probes/sec.
//
// A token bucket rather than a fixed window: the burst absorbs the legitimate
// bunching (initial connect, reconnect storms after a network blip, a viewer
// flipping browser tabs) while the slow refill caps sustained scanning. Normal
// clients re-join about twice a minute on the reconcile watchdog, so they never
// approach this. Buckets live on socket.data and die with the connection.
const JOIN_BURST = 20;
const JOIN_REFILL_PER_SEC = 1;

/** Take a token from the socket's bucket under `key`, refilled at `refillPerSec` up to `burst`. */
function takeToken(socket: PresioSocket, key: keyof Pick<SocketData, "joinBucket" | "pluginBucket">, burst: number, refillPerSec: number): boolean {
  const now = Date.now();
  const bucket = socket.data[key] ?? { tokens: burst, last: now };
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.last) / 1000) * refillPerSec);
  bucket.last = now;
  socket.data[key] = bucket;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

export const allowJoin = (socket: PresioSocket) => takeToken(socket, "joinBucket", JOIN_BURST, JOIN_REFILL_PER_SEC);

// Viewers may message the presenter's plugins (a vote, a question), which makes
// plugin_event the one audience-writable event. It carries no DB cost, but an
// unthrottled phone could still flood the presenter, so it gets a bucket like
// join_session's — generous enough for any human tapping buttons.
const AUDIENCE_PLUGIN_BURST = 20;
const AUDIENCE_PLUGIN_REFILL_PER_SEC = 5;

export const allowAudiencePluginEvent = (socket: PresioSocket) =>
  takeToken(socket, "pluginBucket", AUDIENCE_PLUGIN_BURST, AUDIENCE_PLUGIN_REFILL_PER_SEC);

/**
 * Wrap an event handler so it only runs for the session's registered
 * controller, passing the resolved sessionId through. Mutating events
 * (slide/blank/sync, plugin state, history writes) all share this guard.
 */
export const controllerOnly =
  <A extends unknown[]>(state: SocketState, socket: PresioSocket, handler: (sessionId: string, ...args: A) => void) =>
  (...args: A) => {
    const { sessionId } = socket.data;
    if (!sessionId || state.controllers.get(sessionId) !== socket.id) return;
    handler(sessionId, ...args);
  };

/** An event's acknowledgement callback, or a no-op when the client sent none. */
export const ackOrNoop = (ack: unknown): ((reply: unknown) => void) =>
  typeof ack === "function" ? (ack as (reply: unknown) => void) : () => {};
