import type { Server, Socket } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeEqual } from "./auth.js";
import {
  isValidSlideNumber,
  isValidTotalSlides,
  jsonSize,
  sanitizePluginEvent,
  sanitizePublishedPlugin,
  sanitizePluginSettings,
  sanitizePluginLoadFailure,
  MAX_PLUGINS_PER_SESSION,
  MAX_RETAINED_PER_PLUGIN,
  MAX_RETAINED_BYTES_PER_PLUGIN,
  type PublishedPlugin,
  type Retain,
} from "./validation.js";

// A presenter plugin message kept for viewers who join later (the plugin's
// current "state of the world": which poll is open, whether the join code is
// up, what's drawn on each slide).
interface RetainedPluginEvent {
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
  // Sessions currently showing the join code / QR on all viewers (transient).
  codeSessions: Set<string>;
  // The plugins the controller published for viewers to run (where to load
  // each and its hash), per session.
  publishedPlugins: Map<string, Map<string, PublishedPlugin>>;
  // Retained presenter plugin messages per session, keyed plugin + type.
  pluginRetained: Map<string, Map<string, RetainedPluginEvent>>;
  // The presenter's settings for each plugin, which viewers run with.
  pluginSettings: Map<string, Map<string, Record<string, unknown>>>;
}

export function createSocketState(): SocketState {
  return {
    controllers: new Map(),
    blankedSessions: new Set(),
    codeSessions: new Set(),
    publishedPlugins: new Map(),
    pluginRetained: new Map(),
    pluginSettings: new Map(),
  };
}

// Drop a session's transient socket state (on end / expiry).
export function clearSessionState(state: SocketState, sessionId: string) {
  state.controllers.delete(sessionId);
  state.blankedSessions.delete(sessionId);
  state.codeSessions.delete(sessionId);
  state.publishedPlugins.delete(sessionId);
  state.pluginRetained.delete(sessionId);
  state.pluginSettings.delete(sessionId);
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

// Shape of a join code, used as a free pre-filter before touching the DB.
// Deliberately looser than the generator's alphabet (which omits I/O/0/1):
// this is a cheap "could this possibly be a code?" guard, not an auth boundary,
// and it must keep accepting ids minted by older builds and fixtures.
const SESSION_ID_RE = /^[A-Z0-9]{6}$/;

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

interface JoinBucket { tokens: number; last: number }

function allowJoin(socket: Socket): boolean {
  const now = Date.now();
  const bucket: JoinBucket = socket.data.joinBucket ?? { tokens: JOIN_BURST, last: now };
  bucket.tokens = Math.min(JOIN_BURST, bucket.tokens + ((now - bucket.last) / 1000) * JOIN_REFILL_PER_SEC);
  bucket.last = now;
  socket.data.joinBucket = bucket;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// Viewers may message the presenter's plugins (a vote, a question), which makes
// plugin_event the one audience-writable event. It carries no DB cost, but an
// unthrottled phone could still flood the presenter, so it gets a bucket like
// join_session's — generous enough for any human tapping buttons.
const AUDIENCE_PLUGIN_BURST = 20;
const AUDIENCE_PLUGIN_REFILL_PER_SEC = 5;

function allowAudiencePluginEvent(socket: Socket): boolean {
  const now = Date.now();
  const bucket: JoinBucket = socket.data.pluginBucket ?? { tokens: AUDIENCE_PLUGIN_BURST, last: now };
  bucket.tokens = Math.min(
    AUDIENCE_PLUGIN_BURST,
    bucket.tokens + ((now - bucket.last) / 1000) * AUDIENCE_PLUGIN_REFILL_PER_SEC
  );
  bucket.last = now;
  socket.data.pluginBucket = bucket;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

export function registerSocketHandlers(
  io: Server,
  supabase: SupabaseClient,
  state: SocketState
) {
  const { controllers, blankedSessions, codeSessions, publishedPlugins, pluginRetained, pluginSettings } = state;

  // What a joining (or re-joining) socket needs to mount the session's
  // plugins: which ones run and where each loads from (by URL and hash; the
  // viewer fetches them itself), the presenter's settings for each, and the
  // retained messages.
  const pluginsState = (sessionId: string) => ({
    plugins: [...(publishedPlugins.get(sessionId)?.values() ?? [])],
    settings: Object.fromEntries(pluginSettings.get(sessionId) ?? []),
    retained: [...(pluginRetained.get(sessionId)?.values() ?? [])].map(({ plugin, type, payload, retain }) => ({ plugin, type, payload, retain })),
  });

  // Tail of each session's in-flight current_slide write, so overlapping
  // updates land in emit order (see slide_change).
  const pendingSlideWrites = new Map<string, Promise<void>>();

  // Keep (or, for a null payload, forget) a presenter's retained message,
  // within its plugin's budget: MAX_RETAINED_PER_PLUGIN types, and
  // MAX_RETAINED_BYTES_PER_PLUGIN of payload. Over budget it's still relayed
  // live, just not kept for late joiners.
  const retain = (sessionId: string, event: RetainedPluginEvent) => {
    const retained = pluginRetained.get(sessionId) ?? new Map<string, RetainedPluginEvent>();
    const key = `${event.plugin}\u0000${event.type}`;
    if (event.payload === null) {
      retained.delete(key);
      return;
    }
    const plugins = new Set<string>();
    let count = 0;
    let bytes = 0;
    for (const [k, e] of retained) {
      plugins.add(e.plugin);
      if (e.plugin !== event.plugin || k === key) continue;
      count++;
      bytes += e.size;
    }
    if (!plugins.has(event.plugin) && plugins.size >= MAX_PLUGINS_PER_SESSION) return;
    if (count >= MAX_RETAINED_PER_PLUGIN || bytes + event.size > MAX_RETAINED_BYTES_PER_PLUGIN) return;
    retained.set(key, event);
    pluginRetained.set(sessionId, retained);
  };

  // Wrap an event handler so it only runs for the session's registered
  // controller, passing the resolved sessionId through. Mutating events
  // (slide/blank/sync) all share this guard.
  const controllerOnly = <A extends unknown[]>(
    socket: Socket,
    handler: (sessionId: string, ...args: A) => void
  ) => (...args: A) => {
    const { sessionId } = socket.data;
    if (!sessionId || controllers.get(sessionId) !== socket.id) return;
    handler(sessionId, ...args);
  };

  io.on("connection", (socket) => {
    socket.on("join_session", async ({ sessionId, role, token }: { sessionId: string; role: string; token?: string }) => {
      // Over budget: drop silently. Answering would hand a scanner the timing
      // signal the throttle exists to deny, and a real client simply retries on
      // its next watchdog tick, by which point the bucket has refilled.
      if (!allowJoin(socket)) return;

      // Reject anything that isn't code-shaped without a round trip to the DB.
      if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
        socket.emit("error", { message: "Session not found" });
        return;
      }

      const { data } = await supabase
        .from("sessions")
        .select("current_slide, total_slides, controller_token")
        .eq("id", sessionId)
        .neq("status", "expired")
        .single();

      if (!data) {
        socket.emit("error", { message: "Session not found" });
        return;
      }

      let grantedRole = role;
      if (role === "controller") {
        if (typeof token !== "string" || !safeEqual(token, data.controller_token)) {
          grantedRole = "viewer";
        } else {
          // Last join wins controllership. Tell the socket being displaced
          // (e.g. the controller opened in a second tab) so it can demote
          // itself — otherwise its controls just silently stop working.
          const prev = controllers.get(sessionId);
          if (prev && prev !== socket.id) {
            io.sockets.sockets.get(prev)?.emit("controller_replaced");
          }
          controllers.set(sessionId, socket.id);
        }
      }

      socket.join(sessionId);
      socket.data.sessionId = sessionId;
      socket.data.role = grantedRole;
      socket.data.totalSlides = data.total_slides;

      socket.emit("session_state", {
        currentSlide: data.current_slide,
        totalSlides: data.total_slides,
        role: grantedRole,
      });
      socket.emit("plugins_state", pluginsState(sessionId));
    });

    socket.on("slide_change", controllerOnly(socket, async (sessionId, { slideNumber }: { slideNumber: number }) => {
      // Reject non-finite/out-of-range values rather than persisting garbage.
      if (!isValidSlideNumber(slideNumber, socket.data.totalSlides)) return;

      // Broadcast before persisting: awaiting the DB first let two rapid
      // changes resolve out of order, leaving viewers (and the stored
      // current_slide) on the older slide until the next navigation.
      io.to(sessionId).emit("slide_update", { slideNumber });

      // Serialize writes per session so the row always ends on the newest
      // slide even when update round-trips overlap.
      const pending = pendingSlideWrites.get(sessionId) ?? Promise.resolve();
      const write = pending
        .then(async () => {
          await supabase
            .from("sessions")
            .update({ current_slide: slideNumber })
            .eq("id", sessionId);
        })
        .catch(() => { /* keep the chain alive */ })
        .then(() => {
          // Drop the entry once this chain has drained so the map doesn't
          // accumulate one promise per session for the process lifetime.
          if (pendingSlideWrites.get(sessionId) === write) pendingSlideWrites.delete(sessionId);
        });
      pendingSlideWrites.set(sessionId, write);
    }));

    socket.on("sync_all", controllerOnly(socket, (sessionId) => {
      io.to(sessionId).emit("sync_all");
    }));

    // The controller derives the deck's page count from the PDF it actually
    // loaded. A URL-backed deck is re-fetched on every load, so republishing
    // the file with a different page count leaves the stored row stale —
    // correct it here so slide validation and later joins match the document
    // on screen.
    socket.on("total_slides_change", controllerOnly(socket, async (sessionId, { totalSlides }: { totalSlides: number }) => {
      if (!isValidTotalSlides(totalSlides)) return;
      socket.data.totalSlides = totalSlides;
      io.to(sessionId).emit("total_slides_update", { totalSlides });
      await supabase.from("sessions").update({ total_slides: totalSlides }).eq("id", sessionId);
    }));

    socket.on("blank_toggle", controllerOnly(socket, (sessionId) => {
      if (blankedSessions.has(sessionId)) {
        blankedSessions.delete(sessionId);
      } else {
        blankedSessions.add(sessionId);
      }
      io.to(sessionId).emit("blank_update", { blanked: blankedSessions.has(sessionId) });
    }));

    socket.on("code_toggle", controllerOnly(socket, (sessionId) => {
      if (codeSessions.has(sessionId)) {
        codeSessions.delete(sessionId);
      } else {
        codeSessions.add(sessionId);
      }
      io.to(sessionId).emit("code_update", { showCode: codeSessions.has(sessionId) });
    }));

    // --- Plugins ---

    // The controller publishes the plugins that have to run on viewers —
    // where each loads from and its hash, never the plugin itself (viewers
    // fetch that directly) — replacing whatever it published before.
    socket.on("plugins_publish", controllerOnly(socket, (sessionId, payload: { plugins?: unknown }) => {
      if (!Array.isArray(payload?.plugins)) return;
      const next = new Map<string, PublishedPlugin>();
      for (const raw of payload.plugins.slice(0, MAX_PLUGINS_PER_SESSION)) {
        const plugin = sanitizePublishedPlugin(raw);
        if (plugin) next.set(plugin.manifest.id, plugin);
      }
      publishedPlugins.set(sessionId, next);
      io.to(sessionId).emit("plugins_state", pluginsState(sessionId));
    }));

    // The presenter changed a plugin's settings: keep them for joiners and
    // pass them on to the plugin's viewer instances.
    socket.on("plugin_settings", controllerOnly(socket, (sessionId, raw: unknown) => {
      const update = sanitizePluginSettings(raw);
      if (!update) return;
      const bySession = pluginSettings.get(sessionId) ?? new Map<string, Record<string, unknown>>();
      if (!bySession.has(update.plugin) && bySession.size >= MAX_PLUGINS_PER_SESSION) return;
      bySession.set(update.plugin, update.settings);
      pluginSettings.set(sessionId, bySession);
      socket.to(sessionId).emit("plugin_settings", update);
    }));

    // Plugin messages. The presenter's go to everyone else in the room (and
    // are kept for late joiners when retained); the audience's go to the
    // presenter only, so one phone can't broadcast to the whole room.
    socket.on("plugin_event", (raw: unknown) => {
      const { sessionId } = socket.data;
      if (!sessionId) return;
      const event = sanitizePluginEvent(raw);
      if (!event) return;
      const { plugin, type, payload } = event;

      if (controllers.get(sessionId) === socket.id) {
        if (event.retain) retain(sessionId, { plugin, type, payload, retain: event.retain, size: jsonSize(payload) });
        // Volatile ones (a laser position) may be dropped for a viewer whose
        // connection is backed up, rather than queued behind newer ones.
        const room = event.volatile ? socket.to(sessionId).volatile : socket.to(sessionId);
        room.emit("plugin_event", { plugin, type, payload, from: "presenter" });
        return;
      }

      // Audience: only to a plugin the presenter actually published.
      if (!publishedPlugins.get(sessionId)?.has(plugin)) return;
      if (!allowAudiencePluginEvent(socket)) return;
      const controller = controllers.get(sessionId);
      if (!controller) return;
      io.to(controller).emit("plugin_event", { plugin, type, payload, from: "audience", sender: socket.id });
    });

    // A viewer couldn't load one of the published plugins (a presenter's
    // localhost dev server, a version that changed under its URL): tell the
    // presenter, who otherwise can't see it. Throttled like the audience's
    // plugin messages, and only for the version actually published.
    socket.on("plugin_load_failed", (raw: unknown) => {
      const { sessionId } = socket.data;
      if (!sessionId || controllers.get(sessionId) === socket.id) return;
      const failure = sanitizePluginLoadFailure(raw);
      if (!failure) return;
      if (publishedPlugins.get(sessionId)?.get(failure.plugin)?.hash !== failure.hash) return;
      if (!allowAudiencePluginEvent(socket)) return;
      const controller = controllers.get(sessionId);
      if (controller) io.to(controller).emit("plugin_load_failed", { ...failure, sender: socket.id });
    });

    socket.on("time_ping", (clientT1: number, ack?: (data: { serverTime: number; clientT1: number }) => void) => {
      if (typeof ack === "function") ack({ serverTime: Date.now(), clientT1 });
    });

    socket.on("disconnect", () => {
      const { sessionId } = socket.data;
      if (sessionId && controllers.get(sessionId) === socket.id) {
        controllers.delete(sessionId);
      }
    });
  });
}
