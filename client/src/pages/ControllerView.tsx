import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { cn, getSessionAuth } from "@/lib/utils";
import { Settings, Check, Option, Plus, Share2, ExternalLink, QrCode } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { CopyField } from "@/components/CopyField";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LoginDialog } from "@/components/LoginDialog";
import { AccountControl } from "@/components/AccountControl";
import { ControllerOnboarding } from "@/components/ControllerOnboarding";
import { PresentationTimer } from "@/components/PresentationTimer";
import { DownloadStrippedButton } from "@/components/DownloadStrippedButton";
import { hasCompletedControllerOnboarding } from "@/lib/onboarding";
import { useAuth } from "@/lib/useAuth";
import { useClaim } from "@/lib/useClaim";
import { CurrentSlideCard } from "@/components/controller/CurrentSlideCard";
import { NextSlideCard } from "@/components/controller/NextSlideCard";
import { SpeakerNotesCard } from "@/components/controller/SpeakerNotesCard";
import { ThumbnailsCard } from "@/components/controller/ThumbnailsCard";
import { TimerCard, TimerAction, TimerSettingsDialog } from "@/components/controller/TimerCard";
import { ShortcutsEditor } from "@/components/controller/ShortcutsEditor";
import { ControllerHeader } from "@/components/controller/ControllerHeader";
import { ControllerNav } from "@/components/controller/ControllerNav";
import { ControllerMenu } from "@/components/controller/ControllerMenu";
import { ControllerDashboard, type CardEntry } from "@/components/controller/ControllerDashboard";
import { ControllerStack } from "@/components/controller/ControllerStack";
import { ShareDialog } from "@/components/controller/ShareDialog";
import { ConfirmEndDialog } from "@/components/controller/ConfirmEndDialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  DEFAULT_KEYMAP,
  loadKeymap,
  saveKeymap,
  matchesBinding,
  type Keymap,
} from "@/lib/keymap";
import {
  CARD_KEYS,
  CARD_LABELS,
  DEFAULT_LAYOUT,
  loadLayout,
  saveLayout,
  savePreferred,
  hasPreferredLayout,
  loadPreferred,
  addLeaf,
  removeLeaf,
  visibleKeys,
} from "@/lib/controllerLayout";
import { lsGet, lsSet, lsGetString, lsSetString, viewerOpenedKey, STORAGE_KEYS } from "@/lib/storage";
import { type MosaicNode } from "react-mosaic-component";
import type { PresentationSettings } from "./Presentation";
import type { MediaState, AudioState } from "@/components/MediaOverlay";
import type { MediaPlacement } from "@/lib/pdf";
import { DEFAULT_PEN_STYLE, DEFAULT_HIGHLIGHTER_STYLE, hasAnyStrokes, type AnnotationsBySlide, type LaserPoint, type PenStyle, type Stroke, type Tool } from "@/lib/annotations";

// --- Component ---

interface ControllerViewProps {
  id: string;
  local: boolean;
  pdf: PDFDocumentProxy;
  pdfUrl: string;
  currentSlide: number;
  totalSlides: number;
  onGoTo: (slide: number) => void;
  onSyncAll: () => void;
  onEnd: () => void;
  onSynced: () => void;
  onSaveNotes: (slide: number, notes: string) => Promise<void>;
  currentCanvasRef: React.RefObject<HTMLDivElement | null>;
  settings: PresentationSettings;
  onSettingsChange: (settings: PresentationSettings) => void;
  startedAt: number;
  blanked: boolean;
  onBlankToggle: () => void;
  showCode: boolean;
  onShowCodeToggle: () => void;
  mediaPlacements: MediaPlacement[];
  /** All slides' media, keyed by slide number — used for thumbnail posters. */
  mediaBySlide: Map<number, MediaPlacement[]>;
  mediaState: MediaState;
  onMediaControl: (id: string, action: "play" | "pause" | "reset") => void;
  onMediaTime: (id: string, t: number, playing: boolean, sampledAt: number) => void;
  muted: boolean;
  audioState: AudioState;
  onAudioChange: (next: { muted: boolean; target: AudioState["target"] }) => void;
  onLaserMove: (pt: LaserPoint | null) => void;
  annotations: AnnotationsBySlide;
  onStrokeProgress: (stroke: Stroke | null) => void;
  onStrokeCommit: (stroke: Stroke) => void;
  onStrokeUndo: () => void;
  onAnnotationsClear: () => void;
  onDownloadAnnotatedPdf: () => void;
  onSaveDrawing: () => void;
  onLoadDrawing: (file: File) => void;
}

export function ControllerView({
  id,
  local,
  pdf,
  pdfUrl,
  currentSlide,
  totalSlides,
  onGoTo,
  onSyncAll,
  onEnd,
  onSynced,
  onSaveNotes,
  currentCanvasRef,
  settings,
  onSettingsChange,
  startedAt,
  blanked,
  onBlankToggle,
  showCode,
  onShowCodeToggle,
  mediaPlacements,
  mediaBySlide,
  mediaState,
  onMediaControl,
  onMediaTime,
  muted,
  audioState,
  onAudioChange,
  onLaserMove,
  annotations,
  onStrokeProgress,
  onStrokeCommit,
  onStrokeUndo,
  onAnnotationsClear,
  onDownloadAnnotatedPdf,
  onSaveDrawing,
  onLoadDrawing,
}: ControllerViewProps) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [timerSettingsOpen, setTimerSettingsOpen] = useState(false);
  const [keymap, setKeymap] = useState<Keymap>(loadKeymap);
  const [viewerBlocked, setViewerBlocked] = useState(false);
  const [viewerPromptOpen, setViewerPromptOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  // Mobile-only surfaces.
  const [menuOpen, setMenuOpen] = useState(false);
  const [passphraseDialogOpen, setPassphraseDialogOpen] = useState(false);
  // First-run tutorial for the controller. Shown before the viewer prompt.
  const [onboardingOpen, setOnboardingOpen] = useState(() => !hasCompletedControllerOnboarding());
  // Active annotation tool for the current-slide card (laser pointer etc.).
  const [tool, setTool] = useState<Tool>("none");
  // Drawing color/width per tool, remembered across presentations.
  const [penStyle, setPenStyle] = useState<PenStyle>(() => lsGet(STORAGE_KEYS.penStyle, DEFAULT_PEN_STYLE));
  const [highlighterStyle, setHighlighterStyle] = useState<PenStyle>(() =>
    lsGet(STORAGE_KEYS.highlighterStyle, DEFAULT_HIGHLIGHTER_STYLE)
  );
  const activeStyle = tool === "highlighter" ? highlighterStyle : penStyle;
  const changeActiveStyle = useCallback(
    (style: PenStyle) => {
      if (tool === "highlighter") {
        setHighlighterStyle(style);
        lsSet(STORAGE_KEYS.highlighterStyle, style);
      } else {
        setPenStyle(style);
        lsSet(STORAGE_KEYS.penStyle, style);
      }
    },
    [tool]
  );

  const { user } = useAuth();
  const loggedIn = !!user;
  const { syncing, syncError, sync } = useClaim(id);

  const syncOnline = async () => {
    if (await sync(currentSlide)) onSynced();
  };

  // Rather than auto-opening the viewer (which steals the active tab), prompt
  // the presenter to open it themselves. A real click keeps them on the
  // controller and avoids popup blockers.
  useEffect(() => {
    if (isMobile || onboardingOpen) return;
    // Only prompt if the presenter hasn't already opened a viewer for this
    // presentation (the flag survives controller refreshes).
    if (lsGetString(viewerOpenedKey(id)) === "true") return;
    // One-time mount prompt (re-armed when onboarding finishes); the single
    // extra render the rule warns about is intentional and harmless here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViewerPromptOpen(true);
  }, [id, isMobile, onboardingOpen]);

  const [mosaic, setMosaic] = useState<MosaicNode<string> | null>(loadLayout);
  const [hasPreferred, setHasPreferred] = useState(hasPreferredLayout);
  // A card is shown iff it's a leaf in the tree; this drives the Settings checkboxes.
  const visible = new Set(visibleKeys(mosaic));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (matchesBinding(e, keymap.firstSlide)) {
        e.preventDefault();
        onGoTo(1);
      } else if (matchesBinding(e, keymap.lastSlide)) {
        e.preventDefault();
        onGoTo(totalSlides);
      } else if (matchesBinding(e, keymap.nextSlide)) {
        e.preventDefault();
        onGoTo(currentSlide + 1);
      } else if (matchesBinding(e, keymap.prevSlide)) {
        e.preventDefault();
        onGoTo(currentSlide - 1);
      } else if (matchesBinding(e, keymap.toggleBlank)) {
        onBlankToggle();
      } else if (matchesBinding(e, keymap.toggleCode)) {
        // The join code is only meaningful for synced sessions, which have a
        // remote audience; local sessions can't be joined elsewhere.
        if (!local) onShowCodeToggle();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentSlide, totalSlides, onGoTo, onBlankToggle, onShowCodeToggle, local, keymap]);

  const onMosaicChange = useCallback((node: MosaicNode<string> | null) => {
    setMosaic(node);
    saveLayout(node);
  }, []);

  const resetLayout = useCallback(() => {
    setMosaic(DEFAULT_LAYOUT);
    saveLayout(DEFAULT_LAYOUT);
  }, []);

  const savePreferredLayout = useCallback(() => {
    savePreferred(mosaic);
    setHasPreferred(true);
  }, [mosaic]);

  const restorePreferredLayout = useCallback(() => {
    const pref = loadPreferred();
    if (!pref) return;
    setMosaic(pref);
    saveLayout(pref);
  }, []);

  const toggleCard = useCallback((key: string) => {
    setMosaic((prev) => {
      const next = visibleKeys(prev).includes(key)
        ? removeLeaf(prev, key)
        : addLeaf(prev, key);
      saveLayout(next);
      return next;
    });
  }, []);

  const controllerUrl = `${window.location.origin}/s/${id}?role=controller`;
  const viewerUrl = `${window.location.origin}/s/${id}?role=viewer`;
  const { passphrase = "" } = getSessionAuth(id);
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

  // Open the viewer in its named window (reused across opens, so no duplicates)
  // and dismiss the prompt. Passing a feature string forces a separate window
  // rather than a tab in the controller's window, so it never steals the active
  // tab here. Tracks whether a popup blocker got in the way.
  const openViewer = () => {
    const features = "popup,width=1280,height=800";
    const w = window.open(viewerUrl, `presio-viewer-${id}`, features);
    setViewerBlocked(!w);
    if (w) {
      lsSetString(viewerOpenedKey(id), "true");
      setViewerPromptOpen(false);
    }
  };

  // Desktop dashboard card content + optional toolbar action for each key.
  const cardContent: Record<string, CardEntry> = {
    currentSlide: {
      content: (
        <CurrentSlideCard
          ref={currentCanvasRef}
          local={local}
          mediaPlacements={mediaPlacements}
          mediaState={mediaState}
          onMediaControl={onMediaControl}
          onMediaTime={onMediaTime}
          muted={muted}
          audioState={audioState}
          onAudioChange={onAudioChange}
          tool={tool}
          onToolChange={setTool}
          onLaserMove={onLaserMove}
          penStyle={activeStyle}
          onPenStyleChange={changeActiveStyle}
          strokes={annotations[currentSlide] ?? []}
          hasDrawing={hasAnyStrokes(annotations)}
          onStrokeProgress={onStrokeProgress}
          onStrokeCommit={onStrokeCommit}
          onStrokeUndo={onStrokeUndo}
          onAnnotationsClear={onAnnotationsClear}
          onDownloadAnnotatedPdf={onDownloadAnnotatedPdf}
          onSaveDrawing={onSaveDrawing}
          onLoadDrawing={onLoadDrawing}
        />
      ),
    },
    nextSlide: {
      content: <NextSlideCard pdf={pdf} currentSlide={currentSlide} totalSlides={totalSlides} />,
    },
    timer: {
      content: <TimerCard id={id} />,
      action: <TimerAction open={timerSettingsOpen} onToggle={() => setTimerSettingsOpen(!timerSettingsOpen)} />,
    },
    notes: {
      content: (
        <SpeakerNotesCard
          pdf={pdf}
          currentSlide={currentSlide}
          editable={loggedIn}
          onSave={onSaveNotes}
          onRequestLogin={() => setLoginOpen(true)}
        />
      ),
    },
    thumbnails: {
      content: <ThumbnailsCard pdf={pdf} totalSlides={totalSlides} currentSlide={currentSlide} onGoTo={onGoTo} mediaBySlide={mediaBySlide} />,
    },
  };

  const desktopActions = (
    <>
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        title="Settings"
        className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <Settings size={15} />
      </button>
      <ThemeToggle />
      <span className="text-muted-foreground/40">|</span>
      <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setShareDialogOpen(true)}>
        Share
        <Share2 size={12} className="inline ml-1" />
      </Button>
      <span className="text-muted-foreground/40">|</span>
      <button
        type="button"
        onClick={openViewer}
        title={viewerBlocked ? "Viewer window blocked — click to open it" : "Open viewer window"}
        className={`inline-flex items-center gap-1.5 h-8 px-2.5 text-sm font-semibold rounded-md transition-colors ${viewerBlocked
          ? "text-amber-500 bg-amber-500/10 hover:bg-amber-500/20"
          : "text-foreground hover:bg-accent"
          }`}
      >
        <ExternalLink size={15} />
        Open Viewer
      </button>
    </>
  );

  const mobileActions = (
    <ControllerMenu
      open={menuOpen}
      onOpen={() => setMenuOpen(true)}
      onClose={() => setMenuOpen(false)}
      pdf={pdf}
      pdfUrl={pdfUrl}
      hasPassphrase={!!passphrase}
      canShowCode={!local}
      showingCode={showCode}
      onShare={() => setShareDialogOpen(true)}
      onToggleCode={onShowCodeToggle}
      onShowPassphrase={() => setPassphraseDialogOpen(true)}
      onSwitchToViewer={() => navigate(`/s/${id}?role=viewer`, { replace: true })}
      onEndClick={() => setConfirmEnd(true)}
    />
  );

  return (
    <div className={cn("bg-background flex flex-col", isMobile ? "h-dvh" : "h-screen")}>
      <ControllerHeader
        id={id}
        local={local}
        blanked={blanked}
        showingCode={showCode && !local}
        compact={isMobile}
        actions={isMobile ? mobileActions : desktopActions}
      />

      {isMobile ? (
        <ControllerStack
          pdf={pdf}
          currentSlide={currentSlide}
          totalSlides={totalSlides}
          currentCanvasRef={currentCanvasRef}
        />
      ) : (
        <ControllerDashboard
          value={mosaic}
          onChange={onMosaicChange}
          cards={cardContent}
          onHideCard={toggleCard}
        />
      )}

      {isMobile ? (
        <div className="border-t px-3 py-3 space-y-2">
          <div className="flex items-center justify-center gap-3">
            <PresentationTimer
              mode={settings.timerMode}
              duration={settings.timerDuration}
              threshold={settings.timerThreshold}
              startedAt={startedAt}
              className="text-xs font-medium"
            />
            <p className="text-center text-xs text-muted-foreground tabular-nums">
              {currentSlide} / {totalSlides}
            </p>
            {!local && (
              <Button variant="ghost" size="sm" onClick={onSyncAll}>
                Sync All
              </Button>
            )}
          </div>
          <ControllerNav
            size="lg"
            showCount={false}
            currentSlide={currentSlide}
            totalSlides={totalSlides}
            onGoTo={onGoTo}
            className="gap-2"
          />
        </div>
      ) : (
        <div className="border-t p-4 flex items-center justify-center gap-4 shrink-0">
          <ControllerNav
            className="gap-4"
            currentSlide={currentSlide}
            totalSlides={totalSlides}
            onGoTo={onGoTo}
          />
          {!local && (
            <Button variant="ghost" size="sm" onClick={onSyncAll} title="Bring all viewers back to the current slide">
              Sync All
            </Button>
          )}
          {!local && (
            <Button
              variant={showCode ? "default" : "ghost"}
              size="sm"
              onClick={onShowCodeToggle}
              title="Show the join code & QR on all viewers' screens"
            >
              <QrCode size={14} className="mr-1" />
              {showCode ? "Hide Code" : "Show Code"}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {pdfUrl && (
              <Button variant="ghost" size="sm" asChild>
                <a href={pdfUrl} download>
                  Download PDF
                </a>
              </Button>
            )}
            <DownloadStrippedButton pdf={pdf} pdfUrl={pdfUrl} />
            <Button variant="destructive" size="sm" onClick={() => setConfirmEnd(true)}>
              End Presentation
            </Button>
          </div>
        </div>
      )}

      {shareDialogOpen && (
        <ShareDialog
          id={id}
          viewerUrl={viewerUrl}
          controllerUrl={controllerUrl}
          local={local}
          loggedIn={loggedIn}
          syncing={syncing}
          syncError={syncError}
          onLogin={() => setLoginOpen(true)}
          onSync={syncOnline}
          onClose={() => setShareDialogOpen(false)}
          maxWidth={isMobile ? "max-w-[90%]" : "max-w-[50%]"}
        />
      )}

      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}

      {settingsOpen && (
        <DialogOverlay onClose={() => setSettingsOpen(false)} maxWidth="max-w-md">
          <h2 className="text-lg font-semibold">Settings</h2>

          <AccountControl variant="section" />

          <Separator />

          <section className="space-y-2">
            <h3 className="text-sm font-medium">Layout</h3>
            <div className="space-y-0.5">
              {CARD_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleCard(key)}
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent transition-colors text-left"
                >
                  <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${visible.has(key) ? "bg-primary border-primary text-primary-foreground" : "border-input"
                    }`}>
                    {visible.has(key) && <Check size={11} strokeWidth={3} />}
                  </span>
                  {CARD_LABELS[key]}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={savePreferredLayout}>
                Save as preferred
              </Button>
              {hasPreferred && (
                <Button size="sm" variant="outline" onClick={restorePreferredLayout}>
                  Restore preferred
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={resetLayout}>
                Reset to default
              </Button>
            </div>
          </section>

          {passphrase && (
            <>
              <Separator />
              <section className="space-y-2">
                <h3 className="text-sm font-medium">Controller Passphrase</h3>
                <p className="text-xs text-muted-foreground">
                  Share this passphrase to grant controller access
                </p>
                <CopyField label="" value={passphrase} />
              </section>
            </>
          )}

          <Separator />

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Keyboard Shortcuts</h3>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setKeymap(DEFAULT_KEYMAP); saveKeymap(DEFAULT_KEYMAP); }}
              >
                Reset defaults
              </Button>
            </div>
            <ShortcutsEditor
              keymap={keymap}
              onChange={(km) => { setKeymap(km); saveKeymap(km); }}
            />
          </section>

          <Button className="w-full" variant="ghost" onClick={() => setSettingsOpen(false)}>
            Close
          </Button>
        </DialogOverlay>
      )}

      {timerSettingsOpen && (
        <TimerSettingsDialog
          settings={settings}
          onSettingsChange={onSettingsChange}
          onClose={() => setTimerSettingsOpen(false)}
        />
      )}

      {confirmEnd && (
        <ConfirmEndDialog local={local} onConfirm={onEnd} onClose={() => setConfirmEnd(false)} />
      )}

      {passphraseDialogOpen && passphrase && (
        <DialogOverlay onClose={() => setPassphraseDialogOpen(false)} maxWidth="max-w-xs">
          <div className="text-center space-y-3">
            <h2 className="text-lg font-semibold">Controller Passphrase</h2>
            <p className="text-xs text-muted-foreground">
              Share this passphrase to grant controller access
            </p>
            <p className="text-2xl font-bold tracking-widest font-mono select-all">
              {passphrase}
            </p>
            <CopyField label="" value={passphrase} />
          </div>
          <Button className="w-full" variant="ghost" onClick={() => setPassphraseDialogOpen(false)}>
            Close
          </Button>
        </DialogOverlay>
      )}

      {!isMobile && viewerPromptOpen && (
        <DialogOverlay onClose={() => setViewerPromptOpen(false)}>
          <div className="flex flex-col items-center gap-4 text-center">
            <p className="text-xs text-muted-foreground">
              Hold <span className="font-medium text-foreground">{isMac ? "⌥ Option" : "Option/Alt"}</span> and click to open it in its own window.
              <br />
              <br />
              Drag the new window to a different screen to present.
            </p>
            <div className="flex items-center gap-2">
              <kbd className="inline-flex items-center justify-center h-9 min-w-9 px-2 rounded-md border border-border bg-muted text-sm font-medium text-muted-foreground shadow-sm">
                {isMac ? <Option size={15} /> : "Option/Alt"}
              </kbd>
              <Plus size={14} className="text-muted-foreground" />
              <button
                type="button"
                onClick={openViewer}
                className={cn(buttonVariants({ variant: "default" }))}
              >
                Open Viewer Window
              </button>
            </div>
            <button
              type="button"
              onClick={() => setViewerPromptOpen(false)}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4 mt-2"
            >
              Not now
            </button>
          </div>
        </DialogOverlay>
      )}

      {!isMobile && onboardingOpen && (
        <ControllerOnboarding
          onClose={() => setOnboardingOpen(false)}
          onOpenViewer={openViewer}
        />
      )}
    </div>
  );
}
