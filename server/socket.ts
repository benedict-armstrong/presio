import type { Server, Socket } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeEqual } from "./auth.js";
import {
  isValidSlideNumber,
  isValidTotalSlides,
  sanitizeLaserPoint,
  sanitizeStroke,
  isStrokeId,
  imageChars,
  MAX_IMAGE_CHARS_PER_SESSION,
  sanitizeAnnotations,
  MAX_STROKES_PER_SLIDE,
  type AnnotationsBySlide,
} from "./validation.js";

export interface SocketState {
  // Which socket is the controller for each session.
  controllers: Map<string, string>;
  // Blanked state per session (transient, no DB persistence).
  blankedSessions: Set<string>;
  // Sessions currently showing the join code / QR on all viewers (transient).
  codeSessions: Set<string>;
  // Committed drawings per session (in-memory; the controller re-seeds them
  // after a server restart from its own persisted copy).
  annotations: Map<string, AnnotationsBySlide>;
}

export function createSocketState(): SocketState {
  return {
    controllers: new Map(),
    blankedSessions: new Set(),
    codeSessions: new Set(),
    annotations: new Map(),
  };
}

// Drop a session's transient socket state (on end / expiry).
export function clearSessionState(state: SocketState, sessionId: string) {
  state.controllers.delete(sessionId);
  state.blankedSessions.delete(sessionId);
  state.codeSessions.delete(sessionId);
  state.annotations.delete(sessionId);
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
// high-frequency: slide_change, laser_move (pointer-rate), stroke_progress,
// media_time. Presenting a long deck, or scrubbing back and forth through
// hundreds of slides, must never be rate limited, so it isn't.
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

export function registerSocketHandlers(
  io: Server,
  supabase: SupabaseClient,
  state: SocketState
) {
  const { controllers, blankedSessions, codeSessions, annotations } = state;

  // Tail of each session's in-flight current_slide write, so overlapping
  // updates land in emit order (see slide_change).
  const pendingSlideWrites = new Map<string, Promise<void>>();

  // Wrap an event handler so it only runs for the session's registered
  // controller, passing the resolved sessionId through. Mutating events
  // (slide/blank/media) all share this guard.
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
        annotations: annotations.get(sessionId) ?? {},
      });
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

    // Laser pointer stream: relay to everyone else in the room. Transient and
    // high-frequency, so nothing is persisted.
    socket.on("laser_move", controllerOnly(socket, (sessionId, payload: unknown) => {
      const pt = sanitizeLaserPoint(payload);
      if (pt === undefined) return;
      socket.to(sessionId).emit("laser_update", pt);
    }));

    // --- Drawing annotations ---

    // In-progress stroke preview: relay-only, nothing persisted.
    socket.on("stroke_progress", controllerOnly(socket, (sessionId, payload: { slide?: unknown; stroke?: unknown }) => {
      if (!isValidSlideNumber(payload?.slide, socket.data.totalSlides)) return;
      if (payload.stroke === null) {
        socket.to(sessionId).emit("stroke_progress", { slide: payload.slide, stroke: null });
        return;
      }
      const stroke = sanitizeStroke(payload.stroke);
      if (!stroke) return;
      socket.to(sessionId).emit("stroke_progress", { slide: payload.slide, stroke });
    }));

    socket.on("stroke_commit", controllerOnly(socket, (sessionId, payload: { slide?: unknown; stroke?: unknown }) => {
      const slide = payload?.slide as number;
      if (!isValidSlideNumber(slide, socket.data.totalSlides)) return;
      const stroke = sanitizeStroke(payload.stroke);
      if (!stroke) return;
      const bySlide = annotations.get(sessionId) ?? {};
      const existing = bySlide[slide] ?? [];
      if (existing.length >= MAX_STROKES_PER_SLIDE) return;
      if (stroke.src && imageChars(bySlide) + stroke.src.length > MAX_IMAGE_CHARS_PER_SESSION) return;
      bySlide[slide] = [...existing, stroke];
      annotations.set(sessionId, bySlide);
      socket.to(sessionId).emit("stroke_commit", { slide, stroke });
    }));

    socket.on("stroke_undo", controllerOnly(socket, (sessionId, payload: { slide?: unknown }) => {
      const slide = payload?.slide as number;
      if (!isValidSlideNumber(slide, socket.data.totalSlides)) return;
      const bySlide = annotations.get(sessionId);
      if (bySlide?.[slide]?.length) bySlide[slide] = bySlide[slide].slice(0, -1);
      socket.to(sessionId).emit("stroke_undo", { slide });
    }));

    // Eraser: drop specific strokes (by id) from one slide.
    socket.on("strokes_erase", controllerOnly(socket, (sessionId, payload: { slide?: unknown; ids?: unknown }) => {
      const slide = payload?.slide as number;
      if (!isValidSlideNumber(slide, socket.data.totalSlides)) return;
      if (!Array.isArray(payload.ids)) return;
      const ids = payload.ids.slice(0, MAX_STROKES_PER_SLIDE).filter(isStrokeId);
      if (!ids.length) return;
      const bySlide = annotations.get(sessionId);
      if (bySlide?.[slide]) bySlide[slide] = bySlide[slide].filter((s) => !s.id || !ids.includes(s.id));
      socket.to(sessionId).emit("strokes_erase", { slide, ids });
    }));

    // Lasso move/resize: replace strokes (matched by id) on one slide.
    socket.on("strokes_update", controllerOnly(socket, (sessionId, payload: { slide?: unknown; strokes?: unknown }) => {
      const slide = payload?.slide as number;
      if (!isValidSlideNumber(slide, socket.data.totalSlides)) return;
      if (!Array.isArray(payload.strokes)) return;
      const updates = new Map<string, NonNullable<ReturnType<typeof sanitizeStroke>>>();
      for (const raw of payload.strokes.slice(0, MAX_STROKES_PER_SLIDE)) {
        const stroke = sanitizeStroke(raw);
        if (stroke?.id) updates.set(stroke.id, stroke);
      }
      if (!updates.size) return;
      const bySlide = annotations.get(sessionId);
      const existing = bySlide?.[slide];
      if (!bySlide || !existing) return;
      // An update may move or resize a stroke, never swap in new image data.
      bySlide[slide] = existing.map((s) => {
        const next = s.id ? updates.get(s.id) : undefined;
        return next && next.src === s.src ? next : s;
      });
      socket.to(sessionId).emit("strokes_update", { slide, strokes: [...updates.values()] });
    }));

    // Undo/redo: replace one slide's strokes wholesale.
    socket.on("slide_annotations_set", controllerOnly(socket, (sessionId, payload: { slide?: unknown; strokes?: unknown }) => {
      const slide = payload?.slide as number;
      if (!isValidSlideNumber(slide, socket.data.totalSlides)) return;
      const bySlide = annotations.get(sessionId) ?? {};
      const others = { ...bySlide };
      delete others[slide];
      // Same limits as a full sync, with the other slides' images counted.
      const clean = sanitizeAnnotations({ [slide]: payload.strokes }, socket.data.totalSlides);
      if (!clean) return;
      const strokes = clean[slide] ?? [];
      if (imageChars(others) + imageChars({ [slide]: strokes }) > MAX_IMAGE_CHARS_PER_SESSION) return;
      bySlide[slide] = strokes;
      annotations.set(sessionId, bySlide);
      socket.to(sessionId).emit("slide_annotations_set", { slide, strokes });
    }));

    socket.on("annotations_clear", controllerOnly(socket, (sessionId, payload: { slide?: unknown }) => {
      const slide = payload?.slide as number;
      if (!isValidSlideNumber(slide, socket.data.totalSlides)) return;
      const bySlide = annotations.get(sessionId);
      if (bySlide) delete bySlide[slide];
      socket.to(sessionId).emit("annotations_clear", { slide });
    }));

    // Full replace: the controller reseeding after a server restart, or the
    // presenter loading a saved drawing file.
    socket.on("annotations_sync", controllerOnly(socket, (sessionId, payload: unknown) => {
      const bySlide = sanitizeAnnotations(payload, socket.data.totalSlides);
      if (!bySlide) return;
      annotations.set(sessionId, bySlide);
      socket.to(sessionId).emit("annotations_state", bySlide);
    }));

    socket.on("media_control", controllerOnly(socket, (sessionId, payload: { id: string; action: "play" | "pause" | "reset" }) => {
      io.to(sessionId).emit("media_update", { ...payload, seq: Date.now() });
    }));

    socket.on("audio_change", controllerOnly(socket, (sessionId, payload: { muted: boolean; target: "controller" | "both" | "viewers" }) => {
      io.to(sessionId).emit("audio_update", { ...payload, seq: Date.now() });
    }));

    socket.on("media_time", controllerOnly(socket, (sessionId, payload: { id: string; t: number; playing: boolean; sampledAt: number }) => {
      socket.to(sessionId).emit("media_time_update", { ...payload, seq: Date.now() });
    }));

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
