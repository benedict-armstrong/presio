import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { cn, getSessionAuth } from "@/lib/utils";
import { Settings, Check, Option, Plus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { SessionQRCode } from "@/components/SessionQRCode";
import { CopyField } from "@/components/CopyField";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MobileControllerMenu } from "@/components/MobileControllerMenu";
import { PresentationTimer } from "@/components/PresentationTimer";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
import { LoginDialog } from "@/components/LoginDialog";
import { AccountControl } from "@/components/AccountControl";
import { SyncShareOverlay } from "@/components/SyncShareOverlay";
import { useAuth } from "@/lib/useAuth";
import { useClaim } from "@/lib/useClaim";
import { useShareUrl } from "@/lib/useShareUrl";
import { ControllerCard } from "@/components/controller/ControllerCard";
import { CurrentSlideCard } from "@/components/controller/CurrentSlideCard";
import { NextSlideCard } from "@/components/controller/NextSlideCard";
import { SpeakerNotesCard } from "@/components/controller/SpeakerNotesCard";
import { ThumbnailsCard } from "@/components/controller/ThumbnailsCard";
import { TimerCard, TimerAction, TimerSettingsDialog } from "@/components/controller/TimerCard";
import { PresioLogo } from "@/components/PresioLogo";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ResponsiveGridLayout, useContainerWidth, getCompactor, type Layout, type ResponsiveLayouts } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { PresentationSettings } from "./Presentation";
import type { MediaState, AudioState } from "@/components/MediaOverlay";
import type { MediaPlacement } from "@/lib/pdf";
import { DownloadStrippedButton } from "@/components/DownloadStrippedButton";

const verticalCompactor = getCompactor("vertical");

// --- Keyboard shortcuts ---

interface KeyBinding {
  key: string;
  meta?: boolean;
}

interface Keymap {
  nextSlide: KeyBinding[];
  prevSlide: KeyBinding[];
  firstSlide: KeyBinding[];
  lastSlide: KeyBinding[];
  toggleBlank: KeyBinding[];
}

const KEYMAP_ACTIONS = ["nextSlide", "prevSlide", "firstSlide", "lastSlide", "toggleBlank"] as const;
type KeymapAction = (typeof KEYMAP_ACTIONS)[number];

const KEYMAP_LABELS: Record<KeymapAction, string> = {
  nextSlide: "Next slide",
  prevSlide: "Previous slide",
  firstSlide: "First slide",
  lastSlide: "Last slide",
  toggleBlank: "Blank screen",
};

const DEFAULT_KEYMAP: Keymap = {
  nextSlide: [{ key: "ArrowRight" }, { key: " " }],
  prevSlide: [{ key: "ArrowLeft" }],
  firstSlide: [{ key: "ArrowLeft", meta: true }],
  lastSlide: [{ key: "ArrowRight", meta: true }],
  toggleBlank: [{ key: "b" }],
};

function loadKeymap(): Keymap {
  try {
    const raw = localStorage.getItem("presio_keymap");
    if (raw) return { ...DEFAULT_KEYMAP, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_KEYMAP;
}

function saveKeymap(km: Keymap) {
  localStorage.setItem("presio_keymap", JSON.stringify(km));
}

function matchesBinding(e: KeyboardEvent, bindings: KeyBinding[]): boolean {
  return bindings.some((b) => {
    const keyMatch = e.key.toLowerCase() === b.key.toLowerCase();
    const metaMatch = b.meta ? e.metaKey : !e.metaKey;
    return keyMatch && metaMatch;
  });
}

function formatBinding(b: KeyBinding): string {
  const parts: string[] = [];
  if (b.meta) parts.push("⌘");
  const display: Record<string, string> = {
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
    " ": "Space", Escape: "Esc", Enter: "Enter",
  };
  parts.push(display[b.key] || b.key.toUpperCase());
  return parts.join("");
}

// --- Card configuration ---

interface CardLayout {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

interface CardConfig {
  key: string;
  label: string;
  preferredLayout: CardLayout;
}

const GRID_ROWS = 12;
const GRID_MARGIN = 12;

const CARD_CONFIGS: CardConfig[] = [
  { key: "currentSlide", label: "Current Slide", preferredLayout: { i: "currentSlide", x: 0, y: 0, w: 6, h: 8, minW: 4, minH: 3 } },
  { key: "nextSlide", label: "Next Slide", preferredLayout: { i: "nextSlide", x: 6, y: 0, w: 4, h: 5, minW: 3, minH: 3 } },
  { key: "timer", label: "Timer", preferredLayout: { i: "timer", x: 10, y: 0, w: 2, h: 5, minW: 2, minH: 2 } },
  { key: "notes", label: "Speaker Notes", preferredLayout: { i: "notes", x: 6, y: 5, w: 6, h: 3, minW: 3, minH: 2 } },
  { key: "thumbnails", label: "Thumbnails", preferredLayout: { i: "thumbnails", x: 0, y: 8, w: 12, h: 4, minW: 4, minH: 2 } },
];

const CARD_KEYS = CARD_CONFIGS.map((c) => c.key);
const CARD_LABELS = Object.fromEntries(CARD_CONFIGS.map((c) => [c.key, c.label]));
const PREFERRED_LAYOUTS: Record<string, CardLayout> =
  Object.fromEntries(CARD_CONFIGS.map((c) => [c.key, c.preferredLayout])) as Record<string, CardLayout>;
const DEFAULT_LAYOUTS: CardLayout[] = CARD_CONFIGS.map((c) => c.preferredLayout);

function loadLayout(): CardLayout[] {
  try {
    const raw = localStorage.getItem("presio_controller_layout");
    if (raw) {
      const saved: CardLayout[] = JSON.parse(raw);
      return CARD_KEYS.map((key) => {
        const s = saved.find((l) => l.i === key);
        const pref = PREFERRED_LAYOUTS[key];
        return s ? { ...s, minW: pref.minW, minH: pref.minH } : pref;
      });
    }
  } catch { /* ignore */ }
  return DEFAULT_LAYOUTS;
}

function loadVisibility(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem("presio_controller_cards");
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return Object.fromEntries(CARD_KEYS.map((k) => [k, true]));
}

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
  currentCanvasRef: React.RefObject<HTMLDivElement | null>;
  settings: PresentationSettings;
  onSettingsChange: (settings: PresentationSettings) => void;
  startedAt: number;
  blanked: boolean;
  onBlankToggle: () => void;
  mediaPlacements: MediaPlacement[];
  /** All slides' media, keyed by slide number — used for thumbnail posters. */
  mediaBySlide: Map<number, MediaPlacement[]>;
  mediaState: MediaState;
  onMediaControl: (id: string, action: "play" | "pause" | "reset") => void;
  onMediaTime: (id: string, t: number, playing: boolean, sampledAt: number) => void;
  muted: boolean;
  audioState: AudioState;
  onAudioChange: (next: { muted: boolean; target: AudioState["target"] }) => void;
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
  currentCanvasRef,
  settings,
  onSettingsChange,
  startedAt,
  blanked,
  onBlankToggle,
  mediaPlacements,
  mediaBySlide,
  mediaState,
  onMediaControl,
  onMediaTime,
  muted,
  audioState,
  onAudioChange,
}: ControllerViewProps) {
  const isMobile = useIsMobile();
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [timerSettingsOpen, setTimerSettingsOpen] = useState(false);
  const [keymap, setKeymap] = useState<Keymap>(loadKeymap);
  const [viewerBlocked, setViewerBlocked] = useState(false);
  const [viewerPromptOpen, setViewerPromptOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  const { user } = useAuth();
  const loggedIn = !!user;
  const { syncing, syncError, sync } = useClaim(id);
  const { converting, shareUrlError, shareViaUrl } = useShareUrl(id);

  const syncOnline = async () => {
    if (await sync(currentSlide)) onSynced();
  };

  const shareUrl = async (url: string) => {
    if (await shareViaUrl(url)) onSynced();
  };

  // Rather than auto-opening the viewer (which steals the active tab), prompt
  // the presenter to open it themselves. A real click keeps them on the
  // controller and avoids popup blockers.
  useEffect(() => {
    if (isMobile) return;
    setViewerPromptOpen(true);
  }, [id, isMobile]);

  const [layouts, setLayouts] = useState<CardLayout[]>(loadLayout);
  const [cardVisibility, setCardVisibility] = useState<Record<string, boolean>>(loadVisibility);
  const [hasPreferred, setHasPreferred] = useState(() => !!localStorage.getItem("presio_preferred_layout"));
  const { containerRef: gridContainerRef, width: gridWidth } = useContainerWidth();
  const heightRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(0);

  useEffect(() => {
    const el = heightRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setContainerHeight(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowHeight = containerHeight > 0
    ? (containerHeight - (GRID_ROWS + 1) * GRID_MARGIN) / GRID_ROWS
    : 60;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentSlide, totalSlides, onGoTo, onBlankToggle, keymap]);

  const onLayoutChange = useCallback((layout: Layout, layouts: ResponsiveLayouts) => {
    const source = layout.length
      ? layout
      : (layouts?.lg ?? layouts?.md ?? layouts?.sm ?? layout);
    const arr: CardLayout[] = source.map((l) => ({ ...l })) as CardLayout[];
    setLayouts(arr);
    localStorage.setItem("presio_controller_layout", JSON.stringify(arr));
  }, []);

  const resetLayout = useCallback(() => {
    const defaultVis = Object.fromEntries(CARD_KEYS.map((k) => [k, true]));
    setLayouts(DEFAULT_LAYOUTS.map((l) => ({ ...l })));
    setCardVisibility(defaultVis);
    localStorage.setItem("presio_controller_layout", JSON.stringify(DEFAULT_LAYOUTS));
    localStorage.setItem("presio_controller_cards", JSON.stringify(defaultVis));
  }, []);

  const savePreferredLayout = useCallback(() => {
    localStorage.setItem("presio_preferred_layout", JSON.stringify(layouts));
    localStorage.setItem("presio_preferred_cards", JSON.stringify(cardVisibility));
    setHasPreferred(true);
  }, [layouts, cardVisibility]);

  const restorePreferredLayout = useCallback(() => {
    try {
      const savedLayout = localStorage.getItem("presio_preferred_layout");
      const savedCards = localStorage.getItem("presio_preferred_cards");
      if (!savedLayout || !savedCards) return;
      const parsed: CardLayout[] = JSON.parse(savedLayout);
      const vis: Record<string, boolean> = JSON.parse(savedCards);
      const restored = CARD_KEYS.map((key) => {
        const s = parsed.find((l) => l.i === key);
        const pref = PREFERRED_LAYOUTS[key];
        return s ? { ...s, minW: pref.minW, minH: pref.minH } : pref;
      });
      setLayouts(restored);
      setCardVisibility(vis);
      localStorage.setItem("presio_controller_layout", JSON.stringify(restored));
      localStorage.setItem("presio_controller_cards", JSON.stringify(vis));
    } catch { /* ignore */ }
  }, []);

  const toggleCard = useCallback((key: string) => {
    setCardVisibility((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem("presio_controller_cards", JSON.stringify(next));
      return next;
    });
    // When toggling ON, reset to preferred size so it doesn't appear tiny
    setLayouts((prev) => {
      const pref = PREFERRED_LAYOUTS[key];
      if (!pref) return prev;
      return prev.map((l) => l.i === key ? { ...pref } : l);
    });
  }, []);

  const controllerUrl = `${window.location.origin}/s/${id}?role=controller`;
  const viewerUrl = `${window.location.origin}/s/${id}?role=viewer`;
  const { passphrase } = getSessionAuth(id);
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

  // Open the viewer in its named window (reused across opens, so no duplicates)
  // and dismiss the prompt. Passing a feature string forces a separate window
  // rather than a tab in the controller's window, so it never steals the active
  // tab here. Tracks whether a popup blocker got in the way.
  const openViewer = () => {
    const features = "popup,width=1280,height=800";
    const w = window.open(viewerUrl, `presio-viewer-${id}`, features);
    setViewerBlocked(!w);
    if (w) setViewerPromptOpen(false);
  };

  const visibleLayouts = layouts.filter((l) => cardVisibility[l.i]);

  // Card content + optional action for each key
  const cardContent: Record<string, { content: ReactNode; action?: ReactNode }> = {
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
      content: <SpeakerNotesCard pdf={pdf} currentSlide={currentSlide} />,
    },
    thumbnails: {
      content: <ThumbnailsCard pdf={pdf} totalSlides={totalSlides} currentSlide={currentSlide} onGoTo={onGoTo} mediaBySlide={mediaBySlide} />,
    },
  };

  if (isMobile) {
    return (
      <MobileLayout
        id={id}
        local={local}
        pdfUrl={pdfUrl}
        pdf={pdf}
        currentSlide={currentSlide}
        totalSlides={totalSlides}
        onGoTo={onGoTo}
        onSyncAll={onSyncAll}
        currentCanvasRef={currentCanvasRef}
        settings={settings}
        startedAt={startedAt}
        passphrase={passphrase}
      />
    );
  }

  return (
    <div className="h-screen bg-background flex flex-col">
      <div className="border-b px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex items-center gap-1.5 text-sm font-semibold hover:text-muted-foreground transition-colors">
            <PresioLogo className="h-4 w-auto" />
            Presio
          </Link>
          <span className="text-muted-foreground/40">|</span>
          {!local && (
            <>
              <span className="text-xs text-muted-foreground">Code:</span>
              <span className="font-mono font-bold tracking-widest select-all">{id}</span>
            </>
          )}
          <ConnectionIndicator local={local} />
          {local && <span className="text-xs font-medium text-amber-600 dark:text-amber-500">Local</span>}
          {blanked && (
            <span className="text-xs font-medium text-destructive px-1.5 py-0.5 rounded bg-destructive/10">
              Blanked
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setShareDialogOpen(true)}>
            Share
          </Button>
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
          <button
            type="button"
            onClick={openViewer}
            title={viewerBlocked ? "Viewer window blocked — click to open it" : "Open viewer window"}
            className={`inline-flex items-center gap-1.5 h-8 px-2.5 text-sm font-semibold rounded-md transition-colors ${viewerBlocked
              ? "text-amber-500 bg-amber-500/10 hover:bg-amber-500/20"
              : "text-foreground hover:bg-accent"
              }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
            Open Viewer
          </button>
        </div>
      </div>

      <div
        ref={(el) => {
          // eslint-disable-next-line react-hooks/immutability
          (gridContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          (heightRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }}
        className="flex-1 min-h-0 overflow-hidden"
      >
        <ResponsiveGridLayout
          className="layout"
          width={gridWidth}
          layouts={{ lg: visibleLayouts }}
          breakpoints={{ lg: 0 }}
          cols={{ lg: 12 }}
          rowHeight={rowHeight}
          maxRows={GRID_ROWS}
          onLayoutChange={onLayoutChange}
          compactor={verticalCompactor}
          margin={[GRID_MARGIN, GRID_MARGIN]}
        >
          {CARD_KEYS.filter((key) => cardVisibility[key]).map((key) => (
            <div key={key}>
              <ControllerCard title={CARD_LABELS[key]} action={cardContent[key].action}>
                {cardContent[key].content}
              </ControllerCard>
            </div>
          ))}
        </ResponsiveGridLayout>
      </div>

      <div className="border-t p-4 flex items-center justify-center gap-4 shrink-0">
        <Button
          variant="outline"
          onClick={() => onGoTo(currentSlide - 1)}
          disabled={currentSlide <= 1}
        >
          Previous
        </Button>
        <span className="text-sm font-medium tabular-nums">
          {currentSlide} / {totalSlides}
        </span>
        <Button
          variant="outline"
          onClick={() => onGoTo(currentSlide + 1)}
          disabled={currentSlide >= totalSlides}
        >
          Next
        </Button>
        {!local && (
          <Button variant="ghost" size="sm" onClick={onSyncAll} title="Bring all viewers back to the current slide">
            Sync All
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

      {shareDialogOpen && (
        <DialogOverlay onClose={() => setShareDialogOpen(false)} maxWidth="max-w-[50%]">
          {local ? (
            <>
              <SyncShareOverlay
                id={id}
                viewerUrl={viewerUrl}
                loggedIn={loggedIn}
                syncing={syncing}
                syncError={syncError}
                onLogin={() => setLoginOpen(true)}
                onSync={syncOnline}
                converting={converting}
                shareUrlError={shareUrlError}
                onShareUrl={shareUrl}
              />
              <p className="text-sm text-muted-foreground text-center">
                This presentation is local to this browser. Sync it online to let
                viewers join from any device.
              </p>
            </>
          ) : (
            <>
              <SessionQRCode sessionId={id} />
              <div className="space-y-2">
                <CopyField label="Viewer link" value={viewerUrl} />
                <CopyField label="Controller link" value={controllerUrl} />
              </div>
            </>
          )}
          <Button className="w-full" variant="ghost" onClick={() => setShareDialogOpen(false)}>
            Close
          </Button>
        </DialogOverlay>
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
                  <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${cardVisibility[key] ? "bg-primary border-primary text-primary-foreground" : "border-input"
                    }`}>
                    {cardVisibility[key] && <Check size={11} strokeWidth={3} />}
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
        <DialogOverlay onClose={() => setConfirmEnd(false)}>
          <div className="space-y-2 text-center">
            <h2 className="text-lg font-semibold">End Presentation?</h2>
            <p className="text-sm text-muted-foreground">
              {local
                ? "This will close the viewer window and delete the presentation from this browser. This action cannot be undone."
                : "This will disconnect all viewers and permanently delete the presentation. This action cannot be undone."}
            </p>
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" variant="outline" onClick={() => setConfirmEnd(false)}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              variant="destructive"
              onClick={onEnd}
            >
              End Presentation
            </Button>
          </div>
        </DialogOverlay>
      )}

      {viewerPromptOpen && (
        <DialogOverlay onClose={() => setViewerPromptOpen(false)}>
          <div className="flex flex-col items-center gap-4 text-center">
            {/* <h2 className="text-base font-semibold">Open the viewer</h2> */}
            <p className="text-xs text-muted-foreground">
              Hold <span className="font-medium text-foreground">{isMac ? "⌥ Option" : "Option/Alt"}</span> and click to open it in its own window.
            </p>
            <div className="flex items-center gap-2">
              <kbd className="inline-flex items-center justify-center h-9 min-w-9 px-2 rounded-md border border-border bg-muted text-sm font-medium text-muted-foreground shadow-sm">
                {isMac ? <Option size={15} /> : "Option/Alt"}
              </kbd>
              <Plus size={14} className="text-muted-foreground" />
              {/* A real link so a modifier-click opens it in its own window. */}
              {/* <Button asChild>
                <a
                  href={viewerUrl}
                  target={`presio-viewer-${id}`}
                  rel="noopener"
                  onClick={() => setViewerPromptOpen(false)}
                >
                  Open Viewer
                </a>
              </Button> */}
              <button
                type="button"
                onClick={openViewer}
                className={cn(buttonVariants({ variant: "default" }))}
              >
                Open Viewer
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
    </div>
  );
}

function MobileLayout({
  id,
  local,
  pdfUrl,
  pdf,
  currentSlide,
  totalSlides,
  onGoTo,
  onSyncAll,
  currentCanvasRef,
  settings,
  startedAt,
  passphrase,
}: {
  id: string;
  local: boolean;
  pdfUrl: string;
  pdf: PDFDocumentProxy;
  currentSlide: number;
  totalSlides: number;
  onGoTo: (slide: number) => void;
  onSyncAll: () => void;
  currentCanvasRef: React.RefObject<HTMLDivElement | null>;
  settings: PresentationSettings;
  startedAt: number;
  passphrase: string;
}) {
  return (
    <div className="h-dvh bg-background flex flex-col">
      <div className="border-b px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link to="/" className="flex items-center gap-1.5 text-sm font-semibold hover:text-muted-foreground transition-colors">
            <PresioLogo className="h-4 w-auto" />
            Presio
          </Link>
          <span className="text-muted-foreground/40">|</span>
          {!local && (
            <span className="font-mono font-bold tracking-widest text-sm select-all">{id}</span>
          )}
          <ConnectionIndicator local={local} />
          {local && <span className="text-xs font-medium text-amber-600 dark:text-amber-500">Local</span>}
        </div>
        <MobileControllerMenu id={id} pdf={pdf} pdfUrl={pdfUrl} passphrase={passphrase} />
      </div>

      <div className="flex-1 flex flex-col gap-2 p-3 min-h-0">
        <div className="flex-3 flex flex-col gap-1 min-h-0">
          <p className="text-xs text-muted-foreground font-medium">Current</p>
          <div
            ref={currentCanvasRef}
            className="flex-1 border rounded-lg overflow-hidden bg-white min-h-0"
          />
        </div>
        <div className="flex-2 flex flex-col gap-1 min-h-0">
          <p className="text-xs text-muted-foreground font-medium">Next</p>
          <NextSlideCard pdf={pdf} currentSlide={currentSlide} totalSlides={totalSlides} />
        </div>
      </div>

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
        <div className="flex gap-2">
          <Button
            className="flex-1 h-12 text-base"
            variant="outline"
            onClick={() => onGoTo(currentSlide - 1)}
            disabled={currentSlide <= 1}
          >
            Previous
          </Button>
          <Button
            className="flex-1 h-12 text-base"
            variant="outline"
            onClick={() => onGoTo(currentSlide + 1)}
            disabled={currentSlide >= totalSlides}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function ShortcutsEditor({
  keymap,
  onChange,
}: {
  keymap: Keymap;
  onChange: (km: Keymap) => void;
}) {
  const [recording, setRecording] = useState<{ action: KeymapAction; index: number } | null>(null);

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const binding: KeyBinding = { key: e.key };
      if (e.metaKey) binding.meta = true;
      const next = { ...keymap };
      const bindings = [...next[recording.action]];
      bindings[recording.index] = binding;
      next[recording.action] = bindings;
      onChange(next);
      setRecording(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording, keymap, onChange]);

  return (
    <div className="space-y-2">
      {KEYMAP_ACTIONS.map((action) => (
        <div key={action} className="flex items-center justify-between">
          <span className="text-sm">{KEYMAP_LABELS[action]}</span>
          <div className="flex items-center gap-1">
            {keymap[action].map((b, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setRecording({ action, index: i })}
                className={`px-2 py-1 text-xs font-mono rounded border min-w-[40px] text-center transition-colors ${recording?.action === action && recording.index === i
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-input hover:border-primary/50"
                  }`}
              >
                {recording?.action === action && recording.index === i
                  ? "..."
                  : formatBinding(b)}
              </button>
            ))}
            {keymap[action].length < 3 && (
              <button
                type="button"
                onClick={() => {
                  const next = { ...keymap, [action]: [...keymap[action], { key: "" }] };
                  onChange(next);
                  setRecording({ action, index: keymap[action].length });
                }}
                className="px-1.5 py-1 text-xs rounded border border-dashed border-input hover:border-primary/50 text-muted-foreground"
              >
                +
              </button>
            )}
            {keymap[action].length > 1 && !recording && (
              <button
                type="button"
                onClick={() => onChange({ ...keymap, [action]: keymap[action].slice(0, -1) })}
                className="px-1.5 py-1 text-xs rounded border border-input hover:border-destructive text-muted-foreground hover:text-destructive"
              >
                −
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
