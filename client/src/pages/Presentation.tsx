import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useSearchParams, useNavigate, useLocation, Link } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { getDocument } from "pdfjs-dist";
import { loadPdf, loadPdfData, freshPdfUrl, renderPage, clearCache } from "@/lib/pdf";
import { loadDeckInfo, type Deck, type DeckInfo } from "@/lib/deck";
import { setSlideNotes } from "@/lib/notesAttach";
import { defaultAudioState, isMutedForRole, type MediaState, type MediaTimeSync, type AudioState } from "@/lib/media";
import { hasAnyStrokes, parseDrawing, serializeDrawing, type AnnotationsBySlide, type LaserPoint, type Stroke } from "@/lib/annotations";
import { lsGet, lsSet, lsRemove, annotationsKey } from "@/lib/storage";
import { socket } from "@/lib/socket";
import { startClockSync } from "@/lib/clock";
import { supabase } from "@/lib/supabaseClient";
import { authEnabled } from "@/lib/authMode";
import { getSessionAuth, endSession } from "@/lib/utils";
import { idbGet, idbPut, idbDelete } from "@/lib/localStore";
import { track, sha256Hex } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ControllerView } from "./ControllerView";
import { ViewerView } from "./ViewerView";

export default function Presentation() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // Set by Home when it navigates here right after replacing this deck's PDF
  // (see the initial load below). A timestamp, not a flag, so the cache-busted
  // URL is stable across reloads of this page.
  const replacedAt = (useLocation().state as { deckReplaced?: number } | null)?.deckReplaced;
  const requestedRole = searchParams.get("role") || "viewer";
  const [role, setRole] = useState(requestedRole);
  // The role once the session actually settles it — null while the request is
  // still in flight, since the server can hand back something other than what
  // the URL asked for. Only this drives analytics, never `requestedRole`.
  const [settledRole, setSettledRole] = useState<string | null>(null);
  const applyRole = useCallback((next: string) => {
    setRole(next);
    setSettledRole(next);
  }, []);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [currentSlide, setCurrentSlide] = useState(1);
  const [viewerSlide, setViewerSlide] = useState<number | null>(null);
  const [totalSlides, setTotalSlides] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [blanked, setBlanked] = useState(false);
  // Whether all viewers are currently showing the join code / QR overlay.
  const [showCode, setShowCode] = useState(false);
  const [mediaState, setMediaState] = useState<MediaState>({ id: null, action: "pause", seq: 0 });
  const [mediaTime, setMediaTime] = useState<MediaTimeSync | null>(null);
  const [audioState, setAudioState] = useState<AudioState>(defaultAudioState);
  // Laser pointer position streamed from the controller (null = hidden).
  const [laser, setLaser] = useState<LaserPoint | null>(null);
  // Committed drawings per slide. The controller seeds from localStorage so a
  // reload (or a server restart, via annotations_sync) doesn't lose them.
  const [annotations, setAnnotations] = useState<AnnotationsBySlide>(() =>
    requestedRole === "controller" ? lsGet(annotationsKey(id!), {}) : {}
  );
  // In-progress stroke streamed from the controller (viewer windows).
  const [remoteDraft, setRemoteDraft] = useState<{ slide: number; stroke: Stroke | null } | null>(null);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;

  // Everything extracted from the loaded PDF (notes, media, attachments…),
  // re-derived whenever the document is swapped (e.g. after a notes edit).
  const [deckInfo, setDeckInfo] = useState<DeckInfo | null>(null);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    loadDeckInfo(pdf, pdfUrl, filename).then((info) => {
      if (!cancelled) setDeckInfo(info);
    });
    return () => { cancelled = true; };
  }, [pdf, pdfUrl, filename]);

  // The one object the views work with: the PDF bundle plus live drawings.
  const deck = useMemo<Deck | null>(
    () => (deckInfo ? { ...deckInfo, annotations } : null),
    [deckInfo, annotations]
  );

  const currentCanvasRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  // Object URL backing a local session's PDF, swapped when notes are edited.
  const localUrlRef = useRef("");
  // Latest broadcastable state, for replying to a local window's state_request
  // without re-subscribing the channel on every slide change.
  const stateRef = useRef({
    currentSlide: 1,
    totalSlides: 0,
    blanked: false,
    showCode: false,
    annotations: {} as AnnotationsBySlide,
    mediaState: { id: null, action: "pause", seq: 0 } as MediaState,
    audioState: defaultAudioState,
  });

  // Resolved during load: true if this presentation's PDF lives in this
  // browser's IndexedDB (local session). null until known.
  const [local, setLocal] = useState<boolean | null>(null);

  const isViewer = role === "viewer";
  const outOfSync = isViewer && viewerSlide !== null;
  const displaySlide = outOfSync ? viewerSlide! : currentSlide;

  stateRef.current = { currentSlide, totalSlides, blanked, showCode, annotations, mediaState, audioState };

  // Mirror of pdfUrl for callbacks that must not re-subscribe the socket
  // effect when it changes (a deck replace rewrites it on local sessions).
  const pdfUrlRef = useRef("");
  pdfUrlRef.current = pdfUrl;

  // Persist the controller's drawings across reloads.
  useEffect(() => {
    if (role === "controller") lsSet(annotationsKey(id!), annotations);
  }, [annotations, role, id]);

  // Shared stroke mutations, applied identically whether the change originated
  // locally (controller) or arrived over the socket / BroadcastChannel.
  const applyCommit = useCallback((slide: number, stroke: Stroke) => {
    setAnnotations((prev) => ({ ...prev, [slide]: [...(prev[slide] ?? []), stroke] }));
  }, []);
  const applyUndo = useCallback((slide: number) => {
    setAnnotations((prev) =>
      prev[slide]?.length ? { ...prev, [slide]: prev[slide].slice(0, -1) } : prev
    );
  }, []);
  const applyClear = useCallback((slide: number) => {
    setAnnotations((prev) => (prev[slide]?.length ? { ...prev, [slide]: [] } : prev));
  }, []);

  // Swap in a replacement deck that arrived over the wire — socket
  // `deck_updated` for synced sessions or a BroadcastChannel `deck_update`
  // for local ones. Drawings are dropped wholesale: they are keyed by slide
  // number and the new document renumbers every slide after an insertion.
  // Slide clamping needs no extra work here: the deckInfo effect adopts the
  // new document's page count once it loads.
  const applyDeckUpdate = useCallback(
    ({ filename, totalSlides }: { filename: string; totalSlides: number }) => {
      setFilename(filename);
      setAnnotations({});
      lsRemove(annotationsKey(id!));
      setTotalSlides(totalSlides);
      setCurrentSlide((slide) => Math.min(Math.max(slide, 1), totalSlides));
      (async () => {
        try {
          if (local) {
            // Same-browser windows read the fresh record straight from IndexedDB.
            const rec = await idbGet(id!);
            if (!rec) return;
            const bytes = new Uint8Array(await rec.blob.arrayBuffer());
            const doc = await loadPdfData(bytes);
            setPdf(doc);
            const url = URL.createObjectURL(rec.blob);
            if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
            localUrlRef.current = url;
            setPdfUrl(url);
          } else {
            // The stored object path doesn't change on replace, so bust any
            // cached copy along the way before re-fetching.
            clearCache();
            const doc = await loadPdf(freshPdfUrl(pdfUrlRef.current, Date.now()));
            setPdf(doc);
          }
        } catch {
          // Keep showing the previous deck rather than a broken screen; the
          // stored row already describes the new one and a reload recovers.
        }
      })();
    },
    [local, id]
  );

  useEffect(() => {
    let cancelled = false;
    let localUrl = "";
    (async () => {
      try {
        // If the PDF is in this browser's IndexedDB, it's a local session —
        // render it without the server (works offline, independent of the row).
        const rec = await idbGet(id!).catch(() => {
          throw new Error("Couldn't read the presentation from this browser. Private/incognito mode isn't supported — please use a normal window.");
        });
        if (rec) {
          if (cancelled) return;
          setLocal(true);
          localUrl = URL.createObjectURL(rec.blob);
          localUrlRef.current = localUrl;
          const doc = await loadPdf(localUrl);
          if (cancelled) return;
          setPdfUrl(localUrl);
          setPdf(doc);
          setFilename(rec.filename);
          setTotalSlides(rec.totalSlides);
          return;
        }

        const res = await fetch(`/api/sessions/${id}`);
        if (!res.ok) throw new Error("Session not found");
        const session = await res.json();
        if (session.local) {
          // Server knows this code, but the PDF only lives on the presenter's device.
          throw new Error("This presentation is only available in the same browser on the device it was created on");
        }
        if (cancelled) return;
        setLocal(false);
        // Arriving straight from a replace (Home's recents/re-upload flow) the
        // stored object has new bytes at the same URL, and this browser is the
        // one most likely to have the old copy cached — it had the deck open
        // before. Viewers already in the room don't hit this: they get
        // deck_updated and reload through applyDeckUpdate, which busts too.
        // Keyed by the replace's own timestamp, so a reload of this page reuses
        // the fetch rather than starting another one.
        const doc = await loadPdf(
          replacedAt ? freshPdfUrl(session.pdfUrl, replacedAt) : session.pdfUrl
        );
        if (cancelled) return;
        // Store the canonical URL: later reloads append their own version.
        setPdfUrl(session.pdfUrl);
        setPdf(doc);
        setFilename(session.filename);
        setTotalSlides(session.total_slides);
        setCurrentSlide(session.current_slide);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load presentation");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      clearCache();
      if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    };
    // replacedAt belongs here: replacing the same deck again from Home routes
    // back to this already-mounted page with a new timestamp, and that has to
    // reload the document rather than leave the previous one on screen.
  }, [id, replacedAt]);

  // The loaded document decides the page count: URL-backed decks re-fetch
  // their PDF on every load, so a republished file can change the page count
  // under a value stored at creation time. Adopt the document's count, pull
  // the current slide back into range, and refresh whatever stored count
  // remains (IndexedDB record / session row) so every device agrees.
  useEffect(() => {
    if (!deckInfo) return;
    const docTotal = deckInfo.totalSlides;
    if (totalSlides === docTotal) return;
    setTotalSlides(docTotal);
    setCurrentSlide((slide) => Math.min(Math.max(slide, 1), docTotal));
    if (local) {
      idbGet(id!).then((rec) => {
        if (rec && rec.totalSlides !== docTotal) idbPut({ ...rec, totalSlides: docTotal });
      }).catch(() => { /* best effort */ });
    } else if (role === "controller") {
      // Only the controller can correct the stored row; viewers already show
      // the document-derived count either way.
      socket.emit("total_slides_change", { totalSlides: docTotal });
    }
  }, [deckInfo, totalSlides, local, role, id]);

  useEffect(() => {
    if (!filename) return;
    const suffix = role === "controller" ? "Controller" : "Viewer";
    document.title = `${filename} - ${suffix}`;
    return () => { document.title = "Presio"; };
  }, [filename, role]);

  useEffect(() => {
    if (local === null) return; // wait until we know local vs. server

    const channel = new BroadcastChannel(`presio-${id}`);
    channelRef.current = channel;
    channel.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === "slide_update") setCurrentSlide(payload.slideNumber);
      else if (type === "blank_update") setBlanked(payload.blanked);
      else if (type === "code_update") setShowCode(payload.showCode);
      else if (type === "media_update") setMediaState(payload);
      else if (type === "media_time_update") setMediaTime(payload);
      else if (type === "audio_update") setAudioState(payload);
      else if (type === "laser_update") setLaser(payload);
      else if (type === "stroke_progress") setRemoteDraft(payload);
      else if (type === "stroke_commit") applyCommit(payload.slide, payload.stroke);
      else if (type === "stroke_undo") applyUndo(payload.slide);
      else if (type === "annotations_clear") applyClear(payload.slide);
      else if (type === "annotations_state") setAnnotations(payload);
      else if (type === "deck_update") applyDeckUpdate(payload);
      else if (type === "session_ended") navigate("/", { replace: true });
      else if (type === "state_request") {
        // Controller is the source of truth for a local session; reply so a
        // newly opened or reloaded window can catch up.
        if (requestedRole === "controller") {
          channel.postMessage({ type: "state_sync", payload: stateRef.current });
        }
      } else if (type === "state_sync") {
        setCurrentSlide(payload.currentSlide);
        if (payload.totalSlides) setTotalSlides(payload.totalSlides);
        setBlanked(payload.blanked);
        setShowCode(!!payload.showCode);
        if (requestedRole !== "controller") {
          if (payload.annotations) setAnnotations(payload.annotations);
          // Adopt media/audio too, so a window opened mid-playback doesn't
          // sit paused/muted while everyone else is watching a video. The
          // sync also moves displaySlide, which would trip the slide-change
          // media reset below and wipe what we just adopted — flag it off.
          if (payload.mediaState) {
            skipMediaResetRef.current = true;
            setMediaState(payload.mediaState);
          }
          if (payload.audioState) setAudioState(payload.audioState);
        }
      }
    };

    // Local sessions never touch the server: no socket, sync over the channel.
    if (local) {
      applyRole(requestedRole);
      channel.postMessage({ type: "state_request" });
      return () => {
        channel.close();
        channelRef.current = null;
      };
    }

    const { controllerToken } = getSessionAuth(id!);

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

    socket.on("connect", join);
    socket.connect();
    startClockSync();
    if (socket.connected) join();

    // Re-request authoritative state when a viewer's tab returns to the
    // foreground — background tabs get frozen and can miss broadcasts.
    const reconcile = () => {
      if (requestedRole === "viewer" && !document.hidden && socket.connected) join();
    };
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

    socket.on("session_state", ({ currentSlide, totalSlides, role: grantedRole, annotations: serverAnnotations }) => {
      setCurrentSlide(currentSlide);
      setTotalSlides(totalSlides);
      if (serverAnnotations && Object.keys(serverAnnotations).length) {
        setAnnotations(serverAnnotations);
      } else if (requestedRole === "controller") {
        // The server has no drawings for this session (fresh boot / restart);
        // reseed it from this controller's persisted copy.
        if (hasAnyStrokes(annotationsRef.current)) {
          socket.emit("annotations_sync", annotationsRef.current);
        }
      } else {
        // Viewers mirror the server unconditionally — keeping a stale local
        // copy when the server has none would resurrect cleared drawings.
        setAnnotations({});
      }
      if (grantedRole && grantedRole !== requestedRole) {
        applyRole(grantedRole);
        setSearchParams({ role: grantedRole }, { replace: true });
      } else {
        applyRole(requestedRole);
      }
    });

    socket.on("slide_update", ({ slideNumber }) => {
      setCurrentSlide(slideNumber);
    });

    // The controller corrected the session's page count against the document
    // it loaded; follow suit and stay in range.
    socket.on("total_slides_update", ({ totalSlides }: { totalSlides: number }) => {
      setTotalSlides(totalSlides);
      setCurrentSlide((slide) => Math.min(Math.max(slide, 1), totalSlides));
    });

    socket.on("sync_all", () => {
      setViewerSlide(null);
    });

    socket.on("blank_update", ({ blanked }: { blanked: boolean }) => {
      setBlanked(blanked);
    });

    socket.on("code_update", ({ showCode }: { showCode: boolean }) => {
      setShowCode(showCode);
    });

    socket.on("media_update", (payload: MediaState) => {
      setMediaState(payload);
    });

    socket.on("media_time_update", (payload: MediaTimeSync) => {
      setMediaTime(payload);
    });

    socket.on("audio_update", (payload: AudioState) => {
      setAudioState(payload);
    });

    socket.on("laser_update", (payload: LaserPoint | null) => {
      setLaser(payload);
    });

    socket.on("stroke_progress", (payload: { slide: number; stroke: Stroke | null }) => {
      setRemoteDraft(payload);
    });

    socket.on("stroke_commit", ({ slide, stroke }: { slide: number; stroke: Stroke }) => {
      applyCommit(slide, stroke);
    });

    socket.on("stroke_undo", ({ slide }: { slide: number }) => {
      applyUndo(slide);
    });

    socket.on("annotations_clear", ({ slide }: { slide: number }) => {
      applyClear(slide);
    });

    socket.on("annotations_state", (bySlide: AnnotationsBySlide) => {
      setAnnotations(bySlide);
    });

    // The controller replaced the deck (server broadcast from the replace
    // endpoint); reload the new document under the same session.
    socket.on("deck_updated", (payload: { filename: string; totalSlides: number }) => {
      applyDeckUpdate(payload);
    });

    // Another window took controllership (same token, e.g. a second tab).
    // Demote this one to a viewer — updating the role param re-runs this
    // effect, so the tab rejoins as a viewer and won't grab control back on
    // its next reconnect.
    socket.on("controller_replaced", () => {
      applyRole("viewer");
      setSearchParams({ role: "viewer" }, { replace: true });
    });

    socket.on("error", ({ message }) => {
      setError(message);
    });

    socket.on("session_ended", () => {
      navigate("/", { replace: true });
    });

    return () => {
      channel.close();
      channelRef.current = null;
      document.removeEventListener("visibilitychange", reconcile);
      clearInterval(watchdog);
      socket.off("connect", join);
      socket.off("session_state");
      socket.off("slide_update");
      socket.off("total_slides_update");
      socket.off("sync_all");
      socket.off("blank_update");
      socket.off("code_update");
      socket.off("media_update");
      socket.off("media_time_update");
      socket.off("audio_update");
      socket.off("laser_update");
      socket.off("stroke_progress");
      socket.off("stroke_commit");
      socket.off("stroke_undo");
      socket.off("annotations_clear");
      socket.off("annotations_state");
      socket.off("deck_updated");
      socket.off("controller_replaced");
      socket.off("error");
      socket.off("session_ended");
      socket.disconnect();
    };
  }, [id, local, requestedRole, navigate, setSearchParams, applyRole, applyCommit, applyUndo, applyClear, applyDeckUpdate]);

  // Report the settled role to analytics. The `?role=` query param is already
  // in every tracked URL, but Umami's Pages report keys on the path alone, so
  // viewers and controllers collapse into one `/s/:id` row. A custom event
  // gives them their own breakdown. Fires once per role: reconnects re-settle
  // the same value, and only a real change (a controller demoted by
  // controller_replaced) counts as a second data point.
  const trackedRoleRef = useRef("");
  useEffect(() => {
    if (!settledRole) return;
    if (trackedRoleRef.current === settledRole) return;
    trackedRoleRef.current = settledRole;
    track("session-role", { role: settledRole, mode: local ? "local" : "server" });
  }, [settledRole, local]);

  // Set when a state_sync adopts media state alongside a slide change, so the
  // reset below doesn't immediately discard it.
  const skipMediaResetRef = useRef(false);

  useEffect(() => {
    if (skipMediaResetRef.current) {
      skipMediaResetRef.current = false;
      return;
    }
    setMediaState((s) => (s.id === null ? s : { id: null, action: "pause", seq: Date.now() }));
    setMediaTime(null);
  }, [displaySlide]);

  useEffect(() => {
    if (!pdf || !currentCanvasRef.current) return;
    const container = currentCanvasRef.current;
    // Render at the container's real pixel resolution (CSS width * DPR) so the
    // slide stays sharp on large / high-DPI displays instead of upscaling a
    // fixed-size canvas.
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.round((container.clientWidth || 1280) * dpr);
    // renderPage resolves out of order (cached pages are near-instant, fresh
    // ones aren't), so a rapid slide change could leave a stale page on screen
    // — with the annotation overlay drawing the new slide's strokes over it.
    // Drop any render that finishes after the effect has moved on.
    let stale = false;
    renderPage(pdf, displaySlide, { targetWidth }).then((canvas) => {
      if (stale) return;
      container.innerHTML = "";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.objectFit = "contain";
      container.appendChild(canvas);
    });
    return () => { stale = true; };
    // deckInfo gates mounting of the view that owns the container, and refs
    // don't trigger effects — re-run once the container actually exists.
  }, [pdf, displaySlide, role, deckInfo]);

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

  const goTo = useCallback(
    (slide: number) => {
      if (slide < 1 || slide > totalSlides) return;
      broadcast(
        { type: "slide_update", payload: { slideNumber: slide } },
        { event: "slide_change", payload: { slideNumber: slide } }
      );
      setCurrentSlide(slide);
      setMediaState({ id: null, action: "pause", seq: Date.now() });
    },
    [totalSlides, broadcast]
  );

  const viewerGoTo = useCallback(
    (slide: number) => {
      // Local viewers always follow the controller — no independent navigation.
      if (local) return;
      if (slide < 1 || slide > totalSlides) return;
      setViewerSlide(slide);
    },
    [totalSlides, local]
  );

  const resync = useCallback(() => setViewerSlide(null), []);

  const syncAll = useCallback(() => { if (!local) socket.emit("sync_all"); }, [local]);

  const endPresentation = useCallback(async () => {
    if (local) {
      await idbDelete(id!).catch(() => { /* ignore */ });
      channelRef.current?.postMessage({ type: "session_ended" });
    } else {
      await endSession(id!);
    }
    navigate("/", { replace: true });
  }, [local, id, navigate]);

  // Authorization for rewriting a synced deck's stored PDF. A logged-in owner
  // sends their bearer token; a presenter holding only the controller token
  // (anonymous creation, local-mode server, passphrase-granted controllers)
  // sends that — the server accepts both, exactly like ending a session.
  const pdfWriteAuth = useCallback(async (): Promise<Record<string, string>> => {
    if (authEnabled) {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (accessToken) return { Authorization: `Bearer ${accessToken}` };
    }
    const { controllerToken } = getSessionAuth(id!);
    if (!controllerToken) throw new Error("This browser isn't the controller for this presentation");
    return { "x-controller-token": controllerToken };
  }, [id]);

  // Persist edited speaker notes by writing them back into the PDF as a JSON
  // sidecar (matching presio's format), then swap in the updated document so
  // further edits build on it. Local sessions update IndexedDB; synced ones
  // re-upload to the owner's stored PDF.
  const saveNotes = useCallback(
    async (slide: number, text: string) => {
      if (!pdf) return;
      const original = await pdf.getData();
      const updated = await setSlideNotes(original, slide, text);
      // Coerce to a plain ArrayBuffer slice so Blob's BlobPart typing is happy.
      const buf = updated.buffer.slice(
        updated.byteOffset,
        updated.byteOffset + updated.byteLength
      ) as ArrayBuffer;
      const blob = new Blob([buf], { type: "application/pdf" });

      if (local) {
        const rec = await idbGet(id!);
        if (rec) await idbPut({ ...rec, blob });
      } else {
        // Synced deck: re-upload to its server copy.
        const authHeaders = await pdfWriteAuth();
        const form = new FormData();
        form.append("pdf", blob, `${filename || "presentation"}.pdf`);
        const res = await fetch(`/api/sessions/${id}/pdf`, {
          method: "POST",
          headers: authHeaders,
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to save notes");
        }
      }

      // Reflect the edit immediately; the deck re-derives from the new pdf.
      setDeckInfo((info) => {
        if (!info) return info;
        const notes = new Map(info.notes);
        const trimmed = text.trim();
        if (trimmed) notes.set(slide, trimmed);
        else notes.delete(slide);
        return { ...info, notes };
      });

      const doc = await loadPdfData(updated);
      setPdf(doc);
      if (local) {
        const url = URL.createObjectURL(blob);
        if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
        localUrlRef.current = url;
        setPdfUrl(url);
      }
    },
    [pdf, local, id, filename, pdfWriteAuth]
  );

  // Replace this presentation's PDF with a new file, keeping the session id,
  // code, controller token and passphrase. Mirrors saveNotes' local/synced
  // fork: local decks swap the IndexedDB record in place (nothing uploads);
  // synced ones re-upload to their stored object and let the server's
  // deck_updated broadcast drive the document swap on every client.
  const replacePdf = useCallback(
    async (file: File) => {
      if (local === null) return;
      const buf = await file.arrayBuffer();
      // Snapshot before pdf.js transfers the buffer away (see Home.upload).
      const blob = new Blob([buf], { type: "application/pdf" });
      let sha256: string | undefined;
      try {
        sha256 = await sha256Hex(buf);
      } catch {
        // No crypto.subtle (plain-http origins): track without a fingerprint.
      }
      const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
      const totalSlides = doc.numPages;
      doc.destroy();
      const filename = file.name.replace(/\.pdf$/i, "");

      if (local) {
        const rec = await idbGet(id!);
        if (!rec) throw new Error("This presentation is no longer in this browser");
        await idbPut({ ...rec, blob, filename, totalSlides, sha256 });
        channelRef.current?.postMessage({
          type: "deck_update",
          payload: { filename, totalSlides },
        });
        await applyDeckUpdate({ filename, totalSlides });
      } else {
        const authHeaders = await pdfWriteAuth();
        const form = new FormData();
        form.append("pdf", blob, `${filename}.pdf`);
        form.append("filename", filename);
        const res = await fetch(`/api/sessions/${id}/pdf`, {
          method: "POST",
          headers: authHeaders,
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to replace the PDF");
        }
      }

      track("deck-replace", {
        filename,
        sha256,
        size: file.size,
        slides: totalSlides,
        mode: local ? "local" : "server",
      });
    },
    [local, id, applyDeckUpdate, pdfWriteAuth]
  );

  const onMediaControl = useCallback(
    (id: string, action: "play" | "pause" | "reset") => {
      const next: MediaState = { id, action, seq: Date.now() };
      broadcast(
        { type: "media_update", payload: next },
        { event: "media_control", payload: { id, action } }
      );
      setMediaState(next);
    },
    [broadcast]
  );

  const onMediaTime = useCallback(
    (id: string, t: number, playing: boolean, sampledAt: number) => {
      // Local sessions sync over the BroadcastChannel; both windows share the
      // same Date.now() clock, so sampledAt-based latency comp still holds.
      if (local) {
        channelRef.current?.postMessage({
          type: "media_time_update",
          payload: { id, t, playing, sampledAt, seq: Date.now() },
        });
      } else {
        socket.emit("media_time", { id, t, playing, sampledAt });
      }
    },
    [local]
  );

  // Stream the controller's laser pointer to every other window. High-frequency
  // and transient, so it goes straight out without touching component state.
  const onLaserMove = useCallback(
    (pt: LaserPoint | null) => {
      broadcast(
        { type: "laser_update", payload: pt },
        { event: "laser_move", payload: pt }
      );
    },
    [broadcast]
  );

  // --- Drawing (controller side) ---

  const onStrokeProgress = useCallback(
    (stroke: Stroke | null) => {
      const payload = { slide: currentSlide, stroke };
      broadcast(
        { type: "stroke_progress", payload },
        { event: "stroke_progress", payload }
      );
    },
    [currentSlide, broadcast]
  );

  const onStrokeCommit = useCallback(
    (stroke: Stroke) => {
      applyCommit(currentSlide, stroke);
      const payload = { slide: currentSlide, stroke };
      broadcast(
        { type: "stroke_commit", payload },
        { event: "stroke_commit", payload }
      );
    },
    [currentSlide, broadcast, applyCommit]
  );

  const onStrokeUndo = useCallback(() => {
    applyUndo(currentSlide);
    const payload = { slide: currentSlide };
    broadcast({ type: "stroke_undo", payload }, { event: "stroke_undo", payload });
  }, [currentSlide, broadcast, applyUndo]);

  const onAnnotationsClear = useCallback(() => {
    applyClear(currentSlide);
    const payload = { slide: currentSlide };
    broadcast({ type: "annotations_clear", payload }, { event: "annotations_clear", payload });
  }, [currentSlide, broadcast, applyClear]);

  const onAnnotationsReplace = useCallback(
    (bySlide: AnnotationsBySlide) => {
      setAnnotations(bySlide);
      broadcast(
        { type: "annotations_state", payload: bySlide },
        { event: "annotations_sync", payload: bySlide }
      );
    },
    [broadcast]
  );

  const triggerDownload = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onSaveDrawing = useCallback(() => {
    triggerDownload(
      new Blob([serializeDrawing(annotationsRef.current)], { type: "application/json" }),
      `${filename || "slides"}-drawing.json`
    );
  }, [filename]);

  const onLoadDrawing = useCallback(
    async (file: File) => {
      try {
        onAnnotationsReplace(parseDrawing(await file.text()));
      } catch (e) {
        window.alert(e instanceof Error ? e.message : "Failed to load drawing");
      }
    },
    [onAnnotationsReplace]
  );

  const onAudioChange = useCallback(
    (next: { muted: boolean; target: AudioState["target"] }) => {
      const payload: AudioState = { ...next, seq: Date.now() };
      broadcast(
        { type: "audio_update", payload },
        { event: "audio_change", payload: next }
      );
      setAudioState(payload);
    },
    [broadcast]
  );

  const effectiveMuted = isMutedForRole(role === "controller" ? "controller" : "viewer", audioState);

  const currentMedia = deck?.mediaBySlide.get(displaySlide) ?? [];

  // When the controller lands on a slide whose media is marked autoplay, start
  // it through the shared mediaState. This makes the controller the time-sync
  // source so it and all viewers play in lockstep — otherwise the viewer would
  // autoplay on its own (via the autostart path) while the controller stays
  // paused, and the two would drift out of sync.
  useEffect(() => {
    if (role !== "controller") return;
    const auto = currentMedia.find((p) => p.autoplay);
    if (auto) onMediaControl(auto.id, "play");
    // displaySlide drives currentMedia; re-run on slide change or once media loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displaySlide, role, deckInfo]);

  if (loading || (!error && !deck)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading presentation...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 space-y-4 text-center">
            <p className="text-3xl">😕</p>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{error}</h2>
              <p className="text-sm text-muted-foreground">
                The presentation may have expired or been ended by the presenter.
              </p>
            </div>
            <Button asChild className="w-full">
              <Link to="/">Back to Home</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (role === "viewer") {
    return (
      <ViewerView
        id={id!}
        local={!!local}
        deck={deck!}
        canvasRef={currentCanvasRef}
        blanked={blanked}
        mediaState={mediaState}
        mediaTime={mediaTime}
        muted={effectiveMuted}
        currentSlide={displaySlide}
        showCode={showCode}
        outOfSync={outOfSync}
        onViewerGoTo={viewerGoTo}
        onResync={resync}
        laser={laser}
        strokes={annotations[displaySlide] ?? []}
        draft={remoteDraft && remoteDraft.slide === displaySlide ? remoteDraft.stroke : null}
      />
    );
  }

  return (
    <ControllerView
      id={id!}
      local={!!local}
      deck={deck!}
      currentSlide={currentSlide}
      onGoTo={goTo}
      onSyncAll={syncAll}
      onEnd={endPresentation}
      onSynced={() => setLocal(false)}
      onSaveNotes={saveNotes}
      onReplacePdf={replacePdf}
      currentCanvasRef={currentCanvasRef}
      blanked={blanked}
      onBlankToggle={() => {
        const next = !blanked;
        // Server mode learns the new state from the socket echo; local mode has
        // no echo (BroadcastChannel doesn't deliver to the sender), so set it here.
        if (local) setBlanked(next);
        broadcast({ type: "blank_update", payload: { blanked: next } }, { event: "blank_toggle" });
      }}
      showCode={showCode}
      onShowCodeToggle={() => {
        const next = !showCode;
        // Same echo asymmetry as blanking: local mode sets it directly.
        if (local) setShowCode(next);
        broadcast({ type: "code_update", payload: { showCode: next } }, { event: "code_toggle" });
      }}
      mediaState={mediaState}
      onMediaControl={onMediaControl}
      onMediaTime={onMediaTime}
      muted={effectiveMuted}
      audioState={audioState}
      onAudioChange={onAudioChange}
      onLaserMove={onLaserMove}
      onStrokeProgress={onStrokeProgress}
      onStrokeCommit={onStrokeCommit}
      onStrokeUndo={onStrokeUndo}
      onAnnotationsClear={onAnnotationsClear}
      onSaveDrawing={onSaveDrawing}
      onLoadDrawing={onLoadDrawing}
    />
  );
}
