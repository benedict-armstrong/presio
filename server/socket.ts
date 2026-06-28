import type { Server, Socket } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sanitizeSettings, isValidSlideNumber } from "./validation.js";

export interface SocketState {
  // Which socket is the controller for each session.
  controllers: Map<string, string>;
  // Blanked state per session (transient, no DB persistence).
  blankedSessions: Set<string>;
  // Sessions currently showing the join code / QR on all viewers (transient).
  codeSessions: Set<string>;
}

export function createSocketState(): SocketState {
  return { controllers: new Map(), blankedSessions: new Set(), codeSessions: new Set() };
}

export function registerSocketHandlers(
  io: Server,
  supabase: SupabaseClient,
  state: SocketState
) {
  const { controllers, blankedSessions, codeSessions } = state;

  // Wrap an event handler so it only runs for the session's registered
  // controller, passing the resolved sessionId through. Mutating events
  // (slide/settings/blank/media) all share this guard.
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
        .select("current_slide, total_slides, controller_token, timer_mode, timer_duration, timer_threshold, note_prefix")
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
        settings: {
          timerMode: data.timer_mode,
          timerDuration: data.timer_duration,
          timerThreshold: data.timer_threshold,
          notePrefix: data.note_prefix,
        },
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

    socket.on("settings_change", controllerOnly(socket, async (sessionId, settings: { timerMode?: string | null; timerDuration?: number | null; timerThreshold?: number | null; notePrefix?: string }) => {
      const sanitized = sanitizeSettings(settings);

      await supabase
        .from("sessions")
        .update({
          timer_mode: sanitized.timerMode,
          timer_duration: sanitized.timerDuration,
          timer_threshold: sanitized.timerThreshold,
          note_prefix: sanitized.notePrefix,
        })
        .eq("id", sessionId);

      io.to(sessionId).emit("settings_update", sanitized);
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
