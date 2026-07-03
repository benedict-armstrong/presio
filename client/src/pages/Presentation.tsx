import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useSearchParams, useNavigate, Link } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdf, loadPdfData, renderPage, clearCache, loadMediaPlacements, type MediaPlacement } from "@/lib/pdf";
import { setSlideNotes } from "@/lib/notesAttach";
import { defaultAudioState, isMutedForRole, type MediaState, type MediaTimeSync, type AudioState } from "@/lib/media";
import { hasAnyStrokes, parseDrawing, serializeDrawing, type AnnotationsBySlide, type LaserPoint, type Stroke } from "@/lib/annotations";
import { renderAnnotatedPdf } from "@/lib/annotatedPdf";
import { lsGet, lsSet, annotationsKey } from "@/lib/storage";
import { socket } from "@/lib/socket";
import { startClockSync } from "@/lib/clock";
import { supabase } from "@/lib/supabaseClient";
import { getSessionAuth, endSession } from "@/lib/utils";
import { idbGet, idbPut, idbDelete } from "@/lib/localStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ControllerView } from "./ControllerView";
import { ViewerView } from "./ViewerView";

export default function Presentation() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedRole = searchParams.get("role") || "viewer";
  const [role, setRole] = useState(requestedRole);

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
  const [mediaPlacements, setMediaPlacements] = useState<Map<number, MediaPlacement[]>>(new Map());
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

  const currentCanvasRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  // Object URL backing a local session's PDF, swapped when notes are edited.
  const localUrlRef = useRef("");
  // Latest broadcastable state, for replying to a local window's state_request
  // without re-subscribing the channel on every slide change.
  const stateRef = useRef({ currentSlide: 1, totalSlides: 0, blanked: false, showCode: false, annotations: {} as AnnotationsBySlide });

  // Resolved during load: true if this presentation's PDF lives in this
  // browser's IndexedDB (local session). null until known.
  const [local, setLocal] = useState<boolean | null>(null);

  const isViewer = role === "viewer";
  const outOfSync = isViewer && viewerSlide !== null;
  const displaySlide = outOfSync ? viewerSlide! : currentSlide;

  stateRef.current = { currentSlide, totalSlides, blanked, showCode, annotations };

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
          loadMediaPlacements(doc).then((m) => {
            if (!cancelled) setMediaPlacements(m);
          }).catch(() => { /* ignore — no media */ });
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
        const doc = await loadPdf(session.pdfUrl);
        if (cancelled) return;
        setPdfUrl(session.pdfUrl);
        setPdf(doc);
        loadMediaPlacements(doc).then((m) => {
          if (!cancelled) setMediaPlacements(m);
        }).catch(() => { /* ignore — no media */ });
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
  }, [id]);

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
        if (requestedRole !== "controller" && payload.annotations) setAnnotations(payload.annotations);
      }
    };

    // Local sessions never touch the server: no socket, sync over the channel.
    if (local) {
      setRole(requestedRole);
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
      } else if (requestedRole === "controller" && hasAnyStrokes(annotationsRef.current)) {
        // The server has no drawings for this session (fresh boot / restart);
        // reseed it from this controller's persisted copy.
        socket.emit("annotations_sync", annotationsRef.current);
      }
      if (grantedRole && grantedRole !== requestedRole) {
        setRole(grantedRole);
        setSearchParams({ role: grantedRole }, { replace: true });
      } else {
        setRole(requestedRole);
      }
    });

    socket.on("slide_update", ({ slideNumber }) => {
      setCurrentSlide(slideNumber);
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
      socket.off("error");
      socket.off("session_ended");
      socket.disconnect();
    };
  }, [id, local, requestedRole, navigate, setSearchParams, applyCommit, applyUndo, applyClear]);

  useEffect(() => {
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
    renderPage(pdf, displaySlide, { targetWidth }).then((canvas) => {
      container.innerHTML = "";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.objectFit = "contain";
      container.appendChild(canvas);
    });
  }, [pdf, displaySlide, role]);

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
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error("Please log in again");
        const form = new FormData();
        form.append("pdf", blob, `${filename || "presentation"}.pdf`);
        const res = await fetch(`/api/sessions/${id}/pdf`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to save notes");
        }
      }

      const doc = await loadPdfData(updated);
      setPdf(doc);
      if (local) {
        const url = URL.createObjectURL(blob);
        if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
        localUrlRef.current = url;
        setPdfUrl(url);
      }
    },
    [pdf, local, id, filename]
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

  const onDownloadAnnotatedPdf = useCallback(async () => {
    if (!pdf) return;
    const original = await pdf.getData();
    const annotated = await renderAnnotatedPdf(original, annotationsRef.current);
    const buf = annotated.buffer.slice(
      annotated.byteOffset,
      annotated.byteOffset + annotated.byteLength
    ) as ArrayBuffer;
    triggerDownload(new Blob([buf], { type: "application/pdf" }), `${filename || "slides"}-annotated.pdf`);
  }, [pdf, filename]);

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

  const currentMedia = mediaPlacements.get(displaySlide) ?? [];

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
  }, [displaySlide, role, mediaPlacements]);

  if (loading) {
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
        pdf={pdf!}
        pdfUrl={pdfUrl}
        canvasRef={currentCanvasRef}
        blanked={blanked}
        mediaPlacements={currentMedia}
        mediaState={mediaState}
        mediaTime={mediaTime}
        muted={effectiveMuted}
        currentSlide={displaySlide}
        totalSlides={totalSlides}
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
      pdf={pdf!}
      pdfUrl={pdfUrl}
      currentSlide={currentSlide}
      totalSlides={totalSlides}
      onGoTo={goTo}
      onSyncAll={syncAll}
      onEnd={endPresentation}
      onSynced={() => setLocal(false)}
      onSaveNotes={saveNotes}
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
      mediaPlacements={currentMedia}
      mediaBySlide={mediaPlacements}
      mediaState={mediaState}
      onMediaControl={onMediaControl}
      onMediaTime={onMediaTime}
      muted={effectiveMuted}
      audioState={audioState}
      onAudioChange={onAudioChange}
      onLaserMove={onLaserMove}
      annotations={annotations}
      onStrokeProgress={onStrokeProgress}
      onStrokeCommit={onStrokeCommit}
      onStrokeUndo={onStrokeUndo}
      onAnnotationsClear={onAnnotationsClear}
      onDownloadAnnotatedPdf={onDownloadAnnotatedPdf}
      onSaveDrawing={onSaveDrawing}
      onLoadDrawing={onLoadDrawing}
    />
  );
}
