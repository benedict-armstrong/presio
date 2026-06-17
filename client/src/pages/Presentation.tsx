import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useSearchParams, useNavigate, Link } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdf, renderPage, clearCache, loadMediaPlacements, type MediaPlacement } from "@/lib/pdf";
import { defaultAudioState, isMutedForRole, type MediaState, type MediaTimeSync, type AudioState } from "@/components/MediaOverlay";
import { socket } from "@/lib/socket";
import { startClockSync } from "@/lib/clock";
import { getSessionAuth } from "@/lib/utils";
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

  const isViewer = role === "viewer";
  const outOfSync = isViewer && viewerSlide !== null;
  const displaySlide = outOfSync ? viewerSlide! : currentSlide;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/sessions/${id}`);
        if (!res.ok) throw new Error("Session not found");
        const session = await res.json();
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
      } catch {
        if (!cancelled) setError("Failed to load presentation");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      clearCache();
    };
  }, [id]);

  useEffect(() => {
    if (!filename) return;
    const suffix = role === "controller" ? "Controller" : "Viewer";
    document.title = `${filename} - ${suffix}`;
    return () => { document.title = "Presio"; };
  }, [filename, role]);

  useEffect(() => {
    const { controllerToken } = getSessionAuth(id!);
    socket.connect();
    startClockSync();
    socket.emit("join_session", { sessionId: id, role: requestedRole, token: controllerToken });

    const channel = new BroadcastChannel(`presio-${id}`);
    channelRef.current = channel;
    channel.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === "slide_update") setCurrentSlide(payload.slideNumber);
      else if (type === "blank_update") setBlanked(payload.blanked);
      else if (type === "settings_update") setSettings(payload);
      else if (type === "media_update") setMediaState(payload);
      else if (type === "audio_update") setAudioState(payload);
    };

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
  }, [id, requestedRole, navigate, setSearchParams]);

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
      socket.emit("slide_change", { slideNumber: slide });
      channelRef.current?.postMessage({ type: "slide_update", payload: { slideNumber: slide } });
      setCurrentSlide(slide);
      setMediaState({ id: null, action: "pause", seq: Date.now() });
    },
    [totalSlides]
  );

  const viewerGoTo = useCallback(
    (slide: number) => {
      if (slide < 1 || slide > totalSlides) return;
      setViewerSlide(slide);
    },
    [totalSlides]
  );

  const resync = useCallback(() => setViewerSlide(null), []);

  const syncAll = useCallback(() => socket.emit("sync_all"), []);

  const onMediaControl = useCallback(
    (id: string, action: "play" | "pause" | "reset") => {
      const next: MediaState = { id, action, seq: Date.now() };
      socket.emit("media_control", { id, action });
      channelRef.current?.postMessage({ type: "media_update", payload: next });
      setMediaState(next);
    },
    []
  );

  const onMediaTime = useCallback(
    (id: string, t: number, playing: boolean, sampledAt: number) => {
      socket.emit("media_time", { id, t, playing, sampledAt });
    },
    []
  );

  const onAudioChange = useCallback(
    (next: { muted: boolean; target: AudioState["target"] }) => {
      const payload: AudioState = { ...next, seq: Date.now() };
      socket.emit("audio_change", next);
      channelRef.current?.postMessage({ type: "audio_update", payload });
      setAudioState(payload);
    },
    []
  );

  const effectiveMuted = isMutedForRole(role === "controller" ? "controller" : "viewer", audioState);

  const currentMedia = mediaPlacements.get(displaySlide) ?? [];

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
      pdf={pdf!}
      pdfUrl={pdfUrl}
      currentSlide={currentSlide}
      totalSlides={totalSlides}
      onGoTo={goTo}
      onSyncAll={syncAll}
      currentCanvasRef={currentCanvasRef}
      settings={settings}
      onSettingsChange={(s) => {
        setSettings(s);
        socket.emit("settings_change", s);
        channelRef.current?.postMessage({ type: "settings_update", payload: s });
      }}
      startedAt={startedAt}
      blanked={blanked}
      onBlankToggle={() => {
        socket.emit("blank_toggle");
        channelRef.current?.postMessage({ type: "blank_update", payload: { blanked: !blanked } });
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
