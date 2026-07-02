import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { RotateCw, EllipsisVertical } from "lucide-react";
import { getSessionAuth, setSessionAuth } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { QRCodeSVG } from "qrcode.react";
import { SessionQRCode } from "@/components/SessionQRCode";
import { PresentationTimer } from "@/components/PresentationTimer";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
import type { PresentationSettings } from "./Presentation";
import { MediaOverlay, type MediaState, type MediaTimeSync } from "@/components/MediaOverlay";
import { AnnotationOverlay } from "@/components/AnnotationOverlay";
import type { LaserPoint } from "@/lib/annotations";
import type { MediaPlacement } from "@/lib/pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { DownloadStrippedButton } from "@/components/DownloadStrippedButton";
import { ViewerHint } from "@/components/ViewerHint";

export function ViewerView({
  id,
  local,
  pdf,
  pdfUrl,
  canvasRef,
  settings,
  startedAt,
  blanked,
  mediaPlacements,
  mediaState,
  mediaTime,
  muted,
  currentSlide,
  totalSlides,
  showCode,
  outOfSync,
  onViewerGoTo,
  onResync,
  laser,
}: {
  id: string;
  local: boolean;
  pdf: PDFDocumentProxy;
  pdfUrl: string;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  settings: PresentationSettings;
  startedAt: number;
  blanked: boolean;
  mediaPlacements: MediaPlacement[];
  mediaState: MediaState;
  mediaTime: MediaTimeSync | null;
  muted: boolean;
  currentSlide: number;
  totalSlides: number;
  showCode: boolean;
  outOfSync: boolean;
  onViewerGoTo: (slide: number) => void;
  onResync: () => void;
  laser: LaserPoint | null;
}) {
  const navigate = useNavigate();
  const [cursorVisible, setCursorVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const resetTimer = useCallback(() => {
    setCursorVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!menuOpen && !authOpen) setCursorVisible(false);
    }, 3000);
  }, [menuOpen, authOpen]);

  useEffect(() => {
    resetTimer();
    window.addEventListener("mousemove", resetTimer);
    return () => {
      window.removeEventListener("mousemove", resetTimer);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [resetTimer]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
      } else if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        onViewerGoTo(currentSlide + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        onViewerGoTo(currentSlide - 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentSlide, onViewerGoTo]);

  const submitPassphrase = async () => {
    setAuthError("");
    setAuthLoading(true);
    try {
      const res = await fetch(`/api/sessions/${id}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Authentication failed");
      }
      const data = await res.json();
      setSessionAuth(id, {
        controllerToken: data.controllerToken,
        passphrase: data.passphrase,
      });
      navigate(`/s/${id}?role=controller`, { replace: true });
    } catch (e: unknown) {
      setAuthError(e instanceof Error ? e.message : "Authentication failed");
    } finally {
      setAuthLoading(false);
    }
  };

  return (
    <div
      className="h-screen w-screen bg-black flex items-center justify-center relative"
      style={{ cursor: cursorVisible ? "default" : "none" }}
    >
      <div ref={canvasRef} data-testid="viewer-slide" data-slide={currentSlide} className="w-full h-full relative" />
      <MediaOverlay
        canvasContainerRef={canvasRef}
        placements={mediaPlacements}
        mediaState={mediaState}
        autostart
        timeSync={mediaTime}
        muted={muted}
        role="viewer"
      />

      <AnnotationOverlay containerRef={canvasRef} remoteLaser={laser} />

      <ViewerHint canNavigate={!local} />

      {blanked && (
        <div className="absolute inset-0 bg-black z-10 flex items-center justify-center">
          <p className={`text-white/50 text-sm select-none transition-opacity duration-300 ${
            cursorVisible ? "opacity-100" : "opacity-0"
          }`}>
            Screen blanked by presenter
          </p>
        </div>
      )}

      {showCode && !local && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 bg-black/95">
          <p className="text-white/70 text-lg select-none">Scan to join this presentation</p>
          <div className="rounded-lg bg-white p-4">
            <QRCodeSVG value={`${window.location.origin}/s/${id}?role=viewer`} size={260} />
          </div>
          <div className="text-center space-y-1">
            <p className="text-white/50 text-sm select-none">Session code</p>
            <p className="text-white text-4xl font-bold tracking-widest font-mono select-all">
              {id}
            </p>
          </div>
        </div>
      )}

      <div className="absolute top-4 left-4 flex items-center gap-2">
        {outOfSync ? (
          <button
            onClick={onResync}
            title="Out of sync — click to follow the presenter"
            className="flex items-center gap-1.5 rounded-full bg-amber-500/20 px-2 py-1 text-amber-300 hover:bg-amber-500/30 hover:text-amber-200 transition-colors cursor-pointer"
          >
            <RotateCw size={14} />
            <span className="text-xs font-medium">Sync</span>
          </button>
        ) : (
          <span className={`transition-opacity duration-300 ${
            cursorVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}>
            <ConnectionIndicator dark local={local} />
          </span>
        )}
        {outOfSync && (
          <span className="text-white/40 text-xs tabular-nums select-none">
            {currentSlide} / {totalSlides}
          </span>
        )}
        <PresentationTimer
          mode={settings.timerMode}
          duration={settings.timerDuration}
          threshold={settings.timerThreshold}
          startedAt={startedAt}
          className={`text-white/70 text-sm transition-opacity duration-300 ${
            cursorVisible ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>

      <button
        onClick={() => setMenuOpen(true)}
        className={`absolute top-4 right-4 p-2 rounded-full bg-black/20 hover:bg-black/30 text-white backdrop-blur drop-shadow-md cursor-pointer transition-opacity duration-300 ${
          cursorVisible ? "opacity-70 hover:opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <EllipsisVertical size={20} />
      </button>

      {menuOpen && (
        <DialogOverlay onClose={() => setMenuOpen(false)} maxWidth="max-w-xs">
          {!local && <SessionQRCode sessionId={id} size={160} />}
          <div className="space-y-2">
            <Button
              className="w-full"
              variant="outline"
              onClick={() => {
                // Local sessions are same-device; no passphrase gate needed.
                const { controllerToken } = getSessionAuth(id);
                if (local || controllerToken) {
                  navigate(`/s/${id}?role=controller`, { replace: true });
                } else {
                  setMenuOpen(false);
                  setAuthOpen(true);
                }
              }}
            >
              Switch to Controller
            </Button>
            {pdfUrl && (
              <Button className="w-full" variant="outline" asChild>
                <a href={pdfUrl} download>
                  Download PDF
                </a>
              </Button>
            )}
            <DownloadStrippedButton pdf={pdf} pdfUrl={pdfUrl} variant="outline" size="default" block />
            <Button
              className="w-full"
              variant="outline"
              onClick={() => {
                if (document.fullscreenElement) {
                  document.exitFullscreen();
                } else {
                  document.documentElement.requestFullscreen();
                }
                setMenuOpen(false);
              }}
            >
              {isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
            </Button>
            <Button className="w-full" variant="outline" onClick={() => navigate("/")}>
              Back to Home
            </Button>
            <Button className="w-full" variant="ghost" onClick={() => setMenuOpen(false)}>
              Close
            </Button>
          </div>
        </DialogOverlay>
      )}

      {authOpen && (
        <DialogOverlay onClose={() => { setAuthOpen(false); setAuthError(""); setPassphrase(""); }} maxWidth="max-w-xs">
          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-center">Enter Passphrase</h2>
            <p className="text-xs text-muted-foreground text-center">
              Enter the controller passphrase to take control of this presentation.
            </p>
            <input
              type="text"
              placeholder="Passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value.toUpperCase())}
              maxLength={8}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-center text-lg font-mono tracking-widest placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => { if (e.key === "Enter") submitPassphrase(); }}
              autoFocus
            />
            {authError && (
              <p className="text-sm text-destructive text-center">{authError}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" variant="outline" onClick={() => { setAuthOpen(false); setAuthError(""); setPassphrase(""); }}>
              Cancel
            </Button>
            <Button className="flex-1" disabled={!passphrase || authLoading} onClick={submitPassphrase}>
              {authLoading ? "Verifying..." : "Submit"}
            </Button>
          </div>
        </DialogOverlay>
      )}
    </div>
  );
}
