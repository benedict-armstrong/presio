import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useSearchParams, useNavigate, Link } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdf, renderPage, clearCache, loadMediaPlacements, type MediaPlacement } from "@/lib/pdf";
import { defaultAudioState, isMutedForRole, type MediaState, type MediaTimeSync, type AudioState } from "@/components/MediaOverlay";
import { socket } from "@/lib/socket";
import { startClockSync } from "@/lib/clock";
import { getSessionAuth, endSession } from "@/lib/utils";
import { idbGet, idbDelete } from "@/lib/localStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ControllerView } from "./ControllerView";
import { ViewerView } from "./ViewerView";

export interface PresentationSettings {
  timerMode: string | null;
  timerDuration: number | null;
  timerThreshold: number | null;
  notePrefix: string;
}

const defaultSettings: PresentationSettings = {
  timerMode: null,
  timerDuration: null,
  timerThreshold: null,
  notePrefix: "note:",
};

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
  const [settings, setSettings] = useState<PresentationSettings>(defaultSettings);
  const [startedAt] = useState(() => Date.now());
  const [blanked, setBlanked] = useState(false);
  const [mediaPlacements, setMediaPlacements] = useState<Map<number, MediaPlacement[]>>(new Map());
  const [mediaState, setMediaState] = useState<MediaState>({ id: null, action: "pause", seq: 0 });
  const [mediaTime, setMediaTime] = useState<MediaTimeSync | null>(null);
  const [audioState, setAudioState] = useState<AudioState>(defaultAudioState);

  const currentCanvasRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  // Latest broadcastable state, for replying to a local window's state_request
  // without re-subscribing the channel on every slide change.
  const stateRef = useRef({ currentSlide: 1, totalSlides: 0, blanked: false, settings: defaultSettings });

  // Resolved during load: true if this presentation's PDF lives in this
  // browser's IndexedDB (local session). null until known.
  const [local, setLocal] = useState<boolean | null>(null);

  const isViewer = role === "viewer";
  const outOfSync = isViewer && viewerSlide !== null;
  const displaySlide = outOfSync ? viewerSlide! : currentSlide;

  stateRef.current = { currentSlide, totalSlides, blanked, settings };

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
        setSettings({
          timerMode: session.timer_mode ?? null,
          timerDuration: session.timer_duration ?? null,
          timerThreshold: session.timer_threshold ?? null,
          notePrefix: session.note_prefix ?? "note:",
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load presentation");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      clearCache();
      if (localUrl) URL.revokeObjectURL(localUrl);
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
      else if (type === "settings_update") setSettings(payload);
      else if (type === "media_update") setMediaState(payload);
      else if (type === "media_time_update") setMediaTime(payload);
      else if (type === "audio_update") setAudioState(payload);
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
        setSettings(payload.settings);
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
    socket.connect();
    startClockSync();
    socket.emit("join_session", { sessionId: id, role: requestedRole, token: controllerToken });

    socket.on("session_state", ({ currentSlide, totalSlides, role: grantedRole, settings: s }) => {
      setCurrentSlide(currentSlide);
      setTotalSlides(totalSlides);
      if (s) setSettings(s);
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

    socket.on("settings_update", (s: PresentationSettings) => {
      setSettings(s);
    });

    socket.on("blank_update", ({ blanked }: { blanked: boolean }) => {
      setBlanked(blanked);
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

    socket.on("error", ({ message }) => {
      setError(message);
    });

    socket.on("session_ended", () => {
      navigate("/", { replace: true });
    });

    return () => {
      channel.close();
      channelRef.current = null;
      socket.off("session_state");
      socket.off("slide_update");
      socket.off("sync_all");
      socket.off("settings_update");
      socket.off("blank_update");
      socket.off("media_update");
      socket.off("media_time_update");
      socket.off("audio_update");
      socket.off("error");
      socket.off("session_ended");
      socket.disconnect();
    };
  }, [id, local, requestedRole, navigate, setSearchParams]);

  useEffect(() => {
    setMediaState((s) => (s.id === null ? s : { id: null, action: "pause", seq: Date.now() }));
    setMediaTime(null);
  }, [displaySlide]);

  useEffect(() => {
    if (!pdf || !currentCanvasRef.current) return;
    const container = currentCanvasRef.current;
    renderPage(pdf, displaySlide).then((canvas) => {
      container.innerHTML = "";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.objectFit = "contain";
      container.appendChild(canvas);
    });
  }, [pdf, displaySlide, role]);

  const goTo = useCallback(
    (slide: number) => {
      if (slide < 1 || slide > totalSlides) return;
      if (!local) socket.emit("slide_change", { slideNumber: slide });
      channelRef.current?.postMessage({ type: "slide_update", payload: { slideNumber: slide } });
      setCurrentSlide(slide);
      setMediaState({ id: null, action: "pause", seq: Date.now() });
    },
    [totalSlides, local]
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

  const onMediaControl = useCallback(
    (id: string, action: "play" | "pause" | "reset") => {
      const next: MediaState = { id, action, seq: Date.now() };
      if (!local) socket.emit("media_control", { id, action });
      channelRef.current?.postMessage({ type: "media_update", payload: next });
      setMediaState(next);
    },
    [local]
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

  const onAudioChange = useCallback(
    (next: { muted: boolean; target: AudioState["target"] }) => {
      const payload: AudioState = { ...next, seq: Date.now() };
      if (!local) socket.emit("audio_change", next);
      channelRef.current?.postMessage({ type: "audio_update", payload });
      setAudioState(payload);
    },
    [local]
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
        settings={settings}
        startedAt={startedAt}
        blanked={blanked}
        mediaPlacements={currentMedia}
        mediaState={mediaState}
        mediaTime={mediaTime}
        muted={effectiveMuted}
        currentSlide={displaySlide}
        totalSlides={totalSlides}
        outOfSync={outOfSync}
        onViewerGoTo={viewerGoTo}
        onResync={resync}
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
      currentCanvasRef={currentCanvasRef}
      settings={settings}
      onSettingsChange={(s) => {
        setSettings(s);
        if (!local) socket.emit("settings_change", s);
        channelRef.current?.postMessage({ type: "settings_update", payload: s });
      }}
      startedAt={startedAt}
      blanked={blanked}
      onBlankToggle={() => {
        const next = !blanked;
        // Server mode learns the new state from the socket echo; local mode has
        // no echo (BroadcastChannel doesn't deliver to the sender), so set it here.
        if (local) setBlanked(next);
        else socket.emit("blank_toggle");
        channelRef.current?.postMessage({ type: "blank_update", payload: { blanked: next } });
      }}
      mediaPlacements={currentMedia}
      mediaState={mediaState}
      onMediaControl={onMediaControl}
      onMediaTime={onMediaTime}
      muted={effectiveMuted}
      audioState={audioState}
      onAudioChange={onAudioChange}
    />
  );
}
