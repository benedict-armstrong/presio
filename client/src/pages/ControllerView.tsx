import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useNavigate, Link } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { getSessionAuth } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { SessionQRCode } from "@/components/SessionQRCode";
import { CopyField } from "@/components/CopyField";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MobileControllerMenu } from "@/components/MobileControllerMenu";
import { PresentationTimer } from "@/components/PresentationTimer";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
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
  { key: "currentSlide", label: "Current Slide", preferredLayout: { i: "currentSlide", x: 0,  y: 0, w: 6,  h: 8, minW: 4, minH: 3 } },
  { key: "nextSlide",    label: "Next Slide",    preferredLayout: { i: "nextSlide",    x: 6,  y: 0, w: 4,  h: 5, minW: 3, minH: 3 } },
  { key: "timer",        label: "Timer",         preferredLayout: { i: "timer",        x: 10, y: 0, w: 2,  h: 5, minW: 2, minH: 2 } },
  { key: "notes",        label: "Speaker Notes", preferredLayout: { i: "notes",        x: 6,  y: 5, w: 6,  h: 3, minW: 3, minH: 2 } },
  { key: "thumbnails",   label: "Thumbnails",    preferredLayout: { i: "thumbnails",   x: 0,  y: 8, w: 12, h: 4, minW: 4, minH: 2 } },
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
  pdf: PDFDocumentProxy;
  pdfUrl: string;
  currentSlide: number;
  totalSlides: number;
  onGoTo: (slide: number) => void;
  onSyncAll: () => void;
  currentCanvasRef: React.RefObject<HTMLDivElement | null>;
  settings: PresentationSettings;
  onSettingsChange: (settings: PresentationSettings) => void;
  startedAt: number;
  blanked: boolean;
  onBlankToggle: () => void;
  mediaPlacements: MediaPlacement[];
  mediaState: MediaState;
  onMediaControl: (id: string, action: "play" | "pause" | "reset") => void;
  onMediaTime: (id: string, t: number, playing: boolean, sampledAt: number) => void;
  muted: boolean;
  audioState: AudioState;
  onAudioChange: (next: { muted: boolean; target: AudioState["target"] }) => void;
}

export function ControllerView({
  id,
  pdf,
  pdfUrl,
  currentSlide,
  totalSlides,
  onGoTo,
  onSyncAll,
  currentCanvasRef,
  settings,
  onSettingsChange,
  startedAt,
  blanked,
  onBlankToggle,
  mediaPlacements,
  mediaState,
  onMediaControl,
  onMediaTime,
  muted,
  audioState,
  onAudioChange,
}: ControllerViewProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [passphraseDialogOpen, setPassphraseDialogOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [cardsMenuOpen, setCardsMenuOpen] = useState(false);
  const [timerSettingsOpen, setTimerSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [keymap, setKeymap] = useState<Keymap>(loadKeymap);

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

  const visibleLayouts = layouts.filter((l) => cardVisibility[l.i]);

  // Card content + optional action for each key
  const cardContent: Record<string, { content: ReactNode; action?: ReactNode }> = {
    currentSlide: {
      content: (
        <CurrentSlideCard
          ref={currentCanvasRef}
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
      content: <ThumbnailsCard pdf={pdf} totalSlides={totalSlides} currentSlide={currentSlide} onGoTo={onGoTo} />,
    },
  };

  if (isMobile) {
    return (
      <MobileLayout
        id={id}
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
          <span className="text-xs text-muted-foreground">Code:</span>
          <span className="font-mono font-bold tracking-widest select-all">{id}</span>
          <ConnectionIndicator />
          {blanked && (
            <span className="text-xs font-medium text-destructive px-1.5 py-0.5 rounded bg-destructive/10">
              Blanked
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <div className="relative">
            <Button size="sm" variant="ghost" onClick={() => setCardsMenuOpen(!cardsMenuOpen)}>
              Layout
            </Button>
            {cardsMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-popover border rounded-md shadow-md p-1 min-w-[160px]">
                {CARD_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleCard(key)}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs rounded hover:bg-accent transition-colors text-left"
                  >
                    <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${
                      cardVisibility[key] ? "bg-primary border-primary text-primary-foreground" : "border-input"
                    }`}>
                      {cardVisibility[key] && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                      )}
                    </span>
                    {CARD_LABELS[key]}
                  </button>
                ))}
                <div className="border-t my-1" />
                <button
                  type="button"
                  onClick={savePreferredLayout}
                  className="w-full px-3 py-1.5 text-xs rounded hover:bg-accent transition-colors text-left text-muted-foreground"
                >
                  Save as preferred layout
                </button>
                {hasPreferred && (
                  <button
                    type="button"
                    onClick={restorePreferredLayout}
                    className="w-full px-3 py-1.5 text-xs rounded hover:bg-accent transition-colors text-left text-muted-foreground"
                  >
                    Restore preferred layout
                  </button>
                )}
                <button
                  type="button"
                  onClick={resetLayout}
                  className="w-full px-3 py-1.5 text-xs rounded hover:bg-accent transition-colors text-left text-muted-foreground"
                >
                  Reset to default
                </button>
              </div>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setShortcutsOpen(true)}>
            Shortcuts
          </Button>
          {passphrase && (
            <Button size="sm" variant="ghost" onClick={() => setPassphraseDialogOpen(true)}>
              Passphrase
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setShareDialogOpen(true)}>
            Share
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/s/${id}?role=viewer`, { replace: true })}>
            Switch to Viewer
          </Button>
          <a
            href={viewerUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open viewer in new window"
            className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          </a>
          <ThemeToggle />
        </div>
      </div>

      <div
        ref={(el) => {
          // eslint-disable-next-line react-hooks/immutability
          (gridContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          (heightRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }}
        className="flex-1 min-h-0 overflow-hidden"
        onClick={() => cardsMenuOpen && setCardsMenuOpen(false)}
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
        <Button variant="ghost" size="sm" onClick={onSyncAll} title="Bring all viewers back to the current slide">
          Sync All
        </Button>
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
          <SessionQRCode sessionId={id} />
          <div className="space-y-2">
            <CopyField label="Viewer link" value={viewerUrl} />
            <CopyField label="Controller link" value={controllerUrl} />
          </div>
          <Button className="w-full" variant="ghost" onClick={() => setShareDialogOpen(false)}>
            Close
          </Button>
        </DialogOverlay>
      )}

      {passphraseDialogOpen && (
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

      {shortcutsOpen && (
        <KeymapDialog
          keymap={keymap}
          onSave={(km) => { setKeymap(km); saveKeymap(km); }}
          onClose={() => setShortcutsOpen(false)}
        />
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
              This will disconnect all viewers and permanently delete the
              presentation. This action cannot be undone.
            </p>
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" variant="outline" onClick={() => setConfirmEnd(false)}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              variant="destructive"
              onClick={async () => {
                await fetch(`/api/sessions/${id}`, { method: "DELETE" });
                navigate("/", { replace: true });
              }}
            >
              End Presentation
            </Button>
          </div>
        </DialogOverlay>
      )}
    </div>
  );
}

function MobileLayout({
  id,
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
          <span className="font-mono font-bold tracking-widest text-sm select-all">{id}</span>
          <ConnectionIndicator />
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
          <Button variant="ghost" size="sm" onClick={onSyncAll}>
            Sync All
          </Button>
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

function KeymapDialog({
  keymap,
  onSave,
  onClose,
}: {
  keymap: Keymap;
  onSave: (km: Keymap) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Keymap>(() => JSON.parse(JSON.stringify(keymap)));
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
      setDraft((prev) => {
        const next = { ...prev };
        const bindings = [...next[recording.action]];
        bindings[recording.index] = binding;
        next[recording.action] = bindings;
        return next;
      });
      setRecording(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording]);

  return (
    <DialogOverlay onClose={onClose} maxWidth="max-w-md">
      <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
      <div className="space-y-3">
        {KEYMAP_ACTIONS.map((action) => (
          <div key={action} className="flex items-center justify-between">
            <span className="text-sm">{KEYMAP_LABELS[action]}</span>
            <div className="flex items-center gap-1">
              {draft[action].map((b, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setRecording({ action, index: i })}
                  className={`px-2 py-1 text-xs font-mono rounded border min-w-[40px] text-center transition-colors ${
                    recording?.action === action && recording.index === i
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-input hover:border-primary/50"
                  }`}
                >
                  {recording?.action === action && recording.index === i
                    ? "..."
                    : formatBinding(b)}
                </button>
              ))}
              {draft[action].length < 3 && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft((prev) => {
                      const next = { ...prev };
                      next[action] = [...next[action], { key: "" }];
                      return next;
                    });
                    setRecording({ action, index: draft[action].length });
                  }}
                  className="px-1.5 py-1 text-xs rounded border border-dashed border-input hover:border-primary/50 text-muted-foreground"
                >
                  +
                </button>
              )}
              {draft[action].length > 1 && !recording && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft((prev) => {
                      const next = { ...prev };
                      next[action] = next[action].slice(0, -1);
                      return next;
                    });
                  }}
                  className="px-1.5 py-1 text-xs rounded border border-input hover:border-destructive text-muted-foreground hover:text-destructive"
                >
                  −
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-2">
        <Button
          className="flex-1"
          variant="outline"
          onClick={() => {
            setDraft(JSON.parse(JSON.stringify(DEFAULT_KEYMAP)));
          }}
        >
          Reset defaults
        </Button>
        <Button
          className="flex-1"
          onClick={() => {
            onSave(draft);
            onClose();
          }}
        >
          Save
        </Button>
      </div>
    </DialogOverlay>
  );
}
