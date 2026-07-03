import type { Server, Socket } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isValidSlideNumber,
  sanitizeLaserPoint,
  sanitizeStroke,
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

export function registerSocketHandlers(
  io: Server,
  supabase: SupabaseClient,
  state: SocketState
) {
  const { controllers, blankedSessions, codeSessions, annotations } = state;

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
        if (token !== data.controller_token) {
          grantedRole = "viewer";
        } else {
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

      await supabase
        .from("sessions")
        .update({ current_slide: slideNumber })
        .eq("id", sessionId);

      io.to(sessionId).emit("slide_update", { slideNumber });
    }));

    socket.on("sync_all", controllerOnly(socket, (sessionId) => {
      io.to(sessionId).emit("sync_all");
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
