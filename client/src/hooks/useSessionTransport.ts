import { useCallback, useEffect, useRef } from "react";
import { socket } from "@/lib/socket";
import { startClockSync } from "@/lib/clock";
import { getSessionAuth } from "@/lib/sessionAuth";
import { useLatestRef } from "./useLatestRef";

/** What a window hears about the session, from the socket or other windows. */
export interface SessionTransportHandlers {
  /** The role this window ends up with (see Presentation's settledRole). */
  onRole: (role: string) => void;
  /** The server granted a role other than the one asked for. */
  onRoleChanged: (role: string) => void;
  onSlide: (slide: number) => void;
  onTotalSlides: (totalSlides: number) => void;
  onBlanked: (blanked: boolean) => void;
  /** The server's full state, answered to every join. */
  onSessionState: (state: { currentSlide: number; totalSlides: number }) => void;
  /** A same-browser controller's state, answered to a state_request. */
  onStateSync: (state: { currentSlide: number; totalSlides?: number; blanked: boolean }) => void;
  onSyncAll: () => void;
  onDeckUpdate: (update: { filename: string; totalSlides: number }) => void;
  onError: (message: string) => void;
  onEnded: () => void;
  /** A local deck was shared from another window and now lives at `id`. */
  onRekeyed: (id: string) => void;
  /** This window's state, for a same-browser window catching up. */
  getState: () => { currentSlide: number; totalSlides: number; blanked: boolean };
}

/**
 * Keep this window in the session: over a BroadcastChannel to same-browser
 * windows always, and for synced sessions over the socket too. `local` is null
 * until the deck has loaded and settled which kind this is.
 *
 * Handlers are read through a ref, so the transport is set up once per
 * id/local/role rather than torn down and rejoined whenever one changes.
 */
export function useSessionTransport(
  id: string,
  local: boolean | null,
  requestedRole: string,
  handlers: SessionTransportHandlers
) {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const on = useLatestRef(handlers);

  useEffect(() => {
    if (local === null) return; // wait until we know local vs. server

    const channel = new BroadcastChannel(`presio-${id}`);
    channelRef.current = channel;
    channel.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === "slide_update") on.current.onSlide(payload.slideNumber);
      else if (type === "blank_update") on.current.onBlanked(payload.blanked);
      else if (type === "deck_update") on.current.onDeckUpdate(payload);
      else if (type === "session_ended") on.current.onEnded();
      else if (type === "rekeyed") on.current.onRekeyed(payload.id);
      else if (type === "state_request") {
        // Controller is the source of truth for a local session; reply so a
        // newly opened or reloaded window can catch up.
        if (requestedRole === "controller") {
          channel.postMessage({ type: "state_sync", payload: on.current.getState() });
        }
      } else if (type === "state_sync") on.current.onStateSync(payload);
    };

    // Local sessions never touch the server: no socket, sync over the channel.
    if (local) {
      on.current.onRole(requestedRole);
      channel.postMessage({ type: "state_request" });
      return () => {
        channel.close();
        channelRef.current = null;
      };
    }

    const { controllerToken } = getSessionAuth(id);

    // Re-emit join on every (re)connect, not just the first mount. Socket.io
    // transparently reconnects after a network blip, server restart, or a
    // sleeping laptop, but the reconnected socket is in no room and would
    // silently miss every broadcast until it re-joins (looking connected the
    // whole time). The server answers join_session with full session_state, so
    // this also reconciles anything that changed while we were away, and
    // re-registers the controller after a server restart wiped its in-memory map.
    const join = () => {
      socket.emit("join_session", { sessionId: id, role: requestedRole, token: controllerToken });
    };

    // Re-request authoritative state when a viewer's tab returns to the
    // foreground — background tabs get frozen and can miss broadcasts.
    const reconcile = () => {
      if (requestedRole === "viewer" && !document.hidden && socket.connected) join();
    };

    // Every listener is registered by reference and removed the same way: the
    // socket is shared app-wide, and socket.off(event) with no handler would
    // also drop anyone else's listener for that event.
    const listeners: Record<string, Parameters<typeof socket.on>[1]> = {
      connect: join,
      session_state: ({ currentSlide, totalSlides, role: grantedRole }: { currentSlide: number; totalSlides: number; role?: string }) => {
        on.current.onSessionState({ currentSlide, totalSlides });
        if (grantedRole && grantedRole !== requestedRole) on.current.onRoleChanged(grantedRole);
        else on.current.onRole(requestedRole);
      },
      slide_update: ({ slideNumber }: { slideNumber: number }) => on.current.onSlide(slideNumber),
      // The controller corrected the session's page count against the
      // document it loaded; follow suit and stay in range.
      total_slides_update: ({ totalSlides }: { totalSlides: number }) => on.current.onTotalSlides(totalSlides),
      sync_all: () => on.current.onSyncAll(),
      blank_update: ({ blanked }: { blanked: boolean }) => on.current.onBlanked(blanked),
      // The controller replaced the deck (server broadcast from the replace
      // endpoint). The window that performed the replace has usually applied
      // it already, from the reply to its own upload; this then joins that swap.
      deck_updated: (payload: { filename: string; totalSlides: number }) => on.current.onDeckUpdate(payload),
      // Another window took controllership (same token, e.g. a second tab).
      // Demoting this one changes the role param, which re-runs this effect,
      // so the tab rejoins as a viewer and won't grab control back on its
      // next reconnect.
      controller_replaced: () => on.current.onRoleChanged("viewer"),
      error: ({ message }: { message: string }) => on.current.onError(message),
      session_ended: () => on.current.onEnded(),
    };
    for (const [event, fn] of Object.entries(listeners)) socket.on(event, fn);

    socket.connect();
    startClockSync();
    if (socket.connected) join();
    document.addEventListener("visibilitychange", reconcile);

    // Recovery / reconciliation watchdog. While disconnected, every role nudges
    // the socket to reconnect on a fast 5s cadence so a dropped connection comes
    // back quickly instead of waiting out socket.io's backoff. While connected,
    // viewers re-request state on a slow backstop interval in case a broadcast
    // was ever dropped without a disconnect — kept infrequent and skipped while
    // hidden so a large audience can't hammer the server. The controller is
    // excluded from the backstop: it drives state, so reconciling it from the
    // server could yank it back mid-advance.
    const RECONNECT_EVERY_MS = 5000;
    const RECONCILE_EVERY_MS = 30000;
    let sinceReconcile = 0;
    const watchdog = setInterval(() => {
      if (!socket.connected) {
        socket.connect(); // idempotent; nudges reconnection if it stalled
        sinceReconcile = 0;
        return;
      }
      sinceReconcile += RECONNECT_EVERY_MS;
      if (sinceReconcile >= RECONCILE_EVERY_MS && requestedRole === "viewer" && !document.hidden) {
        sinceReconcile = 0;
        join();
      }
    }, RECONNECT_EVERY_MS);

    return () => {
      channel.close();
      channelRef.current = null;
      document.removeEventListener("visibilitychange", reconcile);
      clearInterval(watchdog);
      for (const [event, fn] of Object.entries(listeners)) socket.off(event, fn);
      socket.disconnect();
    };
  }, [id, local, requestedRole, on]);

  // Mirror a local state change outward: always to other same-browser windows
  // (BroadcastChannel) and, for synced sessions, to the server (socket). The
  // channel message `type` and the socket `event` intentionally differ — the
  // server echoes a *_update broadcast in response to a *_change/control emit.
  const broadcast = useCallback(
    (
      channelMsg: { type: string; payload?: unknown },
      socketEmit?: { event: string; payload?: unknown }
    ) => {
      if (!local && socketEmit) socket.emit(socketEmit.event, socketEmit.payload);
      channelRef.current?.postMessage(channelMsg);
    },
    [local]
  );

  return { channelRef, broadcast };
}
