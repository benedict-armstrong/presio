import { forwardRef, useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
  ChevronDown,
  Mic,
  Users,
  Eye,
  ZoomOut,
  PenLine,
  Highlighter,
  Eraser,
} from "lucide-react";
import { MediaOverlay, type MediaState, type AudioState, type AudioTarget } from "@/components/MediaOverlay";
import { AnnotationOverlay } from "@/components/AnnotationOverlay";
import { LinkOverlay } from "@/components/LinkOverlay";
import { useSlidePinchZoom } from "@/hooks/useSlidePinchZoom";
import { useFingerDoubleTap } from "@/hooks/useFingerDoubleTap";
import { useIsTouchDevice } from "@/hooks/useIsMobile";
import { AnnotationToolbar } from "@/components/AnnotationToolbar";
import { DEFAULT_PEN_STYLE, DEFAULT_LASER_STYLE, type LaserStyle, type LaserPoint, type PenStyle, type Stroke, type Tool } from "@/lib/annotations";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { lsGetString, STORAGE_KEYS } from "@/lib/storage";
import { readClipboardImage } from "@/lib/imageStroke";
import type { MediaPlacement } from "@/lib/pdf";
import type { PdfLink } from "@/lib/pdfLinks";

interface Props {
  local?: boolean;
  /** Link annotations on the current slide. */
  links?: PdfLink[];
  /** Where an internal link jumps to. The controller drives the session, so
   *  this is the ordinary slide navigation. */
  onLinkGoTo?: (slide: number) => void;
  mediaPlacements?: MediaPlacement[];
  mediaState?: MediaState;
  onMediaControl?: (id: string, action: "play" | "pause" | "reset") => void;
  onMediaTime?: (id: string, t: number, playing: boolean, sampledAt: number) => void;
  muted?: boolean;
  audioState?: AudioState;
  onAudioChange?: (next: { muted: boolean; target: AudioTarget }) => void;
  tool?: Tool;
  /** Whether the floating tool palette is shown (toggled in the card header). */
  toolbarVisible?: boolean;
  /** Pencil mode: only a stylus draws; fingers pan, zoom and tap. */
  pencilMode?: boolean;
  onPencilModeChange?: (on: boolean) => void;
  onToolChange?: (tool: Tool) => void;
  onLaserMove?: (pt: LaserPoint | null) => void;
  penStyle?: PenStyle;
  onPenStyleChange?: (style: PenStyle) => void;
  laserStyle?: LaserStyle;
  onLaserStyleChange?: (style: LaserStyle) => void;
  strokes?: readonly Stroke[];
  onStrokeProgress?: (stroke: Stroke | null) => void;
  onStrokeCommit?: (stroke: Stroke) => void;
  onStrokeUndo?: () => void;
  onStrokeRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onStrokesErase?: (ids: string[], continuing?: boolean) => void;
  onStrokesUpdate?: (strokes: Stroke[]) => void;
  onAnnotationsClear?: () => void;
  /** Reports whether a pinch gesture is running or the slide is zoomed in. */
  onZoomActiveChange?: (active: boolean) => void;
}

const TARGET_LABEL: Record<AudioTarget, string> = {
  controller: "Controller only",
  both: "Controller + Viewers",
  viewers: "Viewers only",
};

const TARGET_ICON: Record<AudioTarget, React.ComponentType<{ className?: string }>> = {
  controller: Mic,
  both: Users,
  viewers: Eye,
};

export const CurrentSlideCard = forwardRef<HTMLDivElement, Props>(
  (
    {
      local = false,
      mediaPlacements = [],
      links = [],
      onLinkGoTo,
      mediaState,
      onMediaControl,
      onMediaTime,
      muted = true,
      audioState,
      onAudioChange,
      tool = "none",
      toolbarVisible = true,
      pencilMode = false,
      onPencilModeChange,
      onToolChange,
      onLaserMove,
      penStyle = DEFAULT_PEN_STYLE,
      onPenStyleChange,
      laserStyle = DEFAULT_LASER_STYLE,
      onLaserStyleChange,
      strokes = [],
      onStrokeProgress,
      onStrokeCommit,
      onStrokeUndo,
      onStrokeRedo,
      canUndo = false,
      canRedo = false,
      onStrokesErase,
      onStrokesUpdate,
      onAnnotationsClear,
      onZoomActiveChange,
    },
    ref
  ) => {
    const showControls = mediaPlacements.length > 0 && !!onMediaControl && !!mediaState;
    const isPlayable = (p: MediaPlacement) =>
      p.mime.startsWith("video/") || p.kind === "youtube" || p.kind === "vimeo";
    const hasVideo = mediaPlacements.some(isPlayable);
    const showAudio = showControls && hasVideo && !!audioState && !!onAudioChange;

    // Pinch to zoom the composed slide (rendered page + annotations move
    // together). Local to this device. With a drawing tool active the first
    // finger still draws, but two fingers always pinch and pan.
    const surfaceRef = useRef<HTMLDivElement | null>(null);

    // The tool palette belongs to the slide: with the mouse elsewhere there is
    // nothing to point at, so it fades out and the slide is seen unobstructed.
    // Touch-first devices have no pointer to leave with, so there it stays put.
    const [mouseOver, setMouseOver] = useState(false);
    const touch = useIsTouchDevice();

    // Pencil mode is switched on the first time a pen touches the slide. Only
    // that first sighting counts — turning it off stays off.
    const detectPencil = (e: React.PointerEvent) => {
      if (e.pointerType !== "pen" || lsGetString(STORAGE_KEYS.pencilMode) !== "") return;
      onPencilModeChange?.(true);
    };

    // Images: pasted with ⌘V (handled by the overlay), or from the palette —
    // the clipboard when it holds one, otherwise a photo/file picker.
    const insertImageRef = useRef<((image: Blob) => Promise<void>) | null>(null);
    const imageInputRef = useRef<HTMLInputElement | null>(null);
    const insertImage = async (image: Blob) => {
      try {
        await insertImageRef.current?.(image);
      } catch (err) {
        console.warn("Could not insert image:", err);
      }
    };
    const onInsertImage = async () => {
      const fromClipboard = await readClipboardImage();
      if (fromClipboard) await insertImage(fromClipboard);
      else imageInputRef.current?.click();
    };

    const { zoom, gesturing, reset: resetZoom } = useSlidePinchZoom(surfaceRef, {
      drawing: tool !== "none" && !pencilMode,
      doubleTapReset: !(pencilMode && (tool === "pen" || tool === "highlighter" || tool === "eraser")),
      onActiveChange: onZoomActiveChange,
    });

    // Pencil mode: a finger double-tap flips between the eraser and the
    // drawing tool used last (the Pencil's own double-tap isn't exposed to
    // the web). From the plain cursor it starts writing — unless zoomed in,
    // where double-tap returns to fit.
    const eraserToggle =
      pencilMode &&
      (tool === "pen" ||
        tool === "highlighter" ||
        tool === "eraser" ||
        (tool === "none" && toolbarVisible && zoom.scale <= 1));
    const lastDrawTool = useRef<Tool>("pen");
    // Brief faded icon of the tool just switched to, where the tap landed.
    const [toolFlash, setToolFlash] = useState<{ tool: Tool; x: number; y: number; key: number } | null>(null);
    useEffect(() => {
      if (tool === "pen" || tool === "highlighter") lastDrawTool.current = tool;
    }, [tool]);
    useFingerDoubleTap(surfaceRef, {
      enabled: eraserToggle,
      onDoubleTap: (x, y) => {
        const next = tool === "eraser" || tool === "none" ? lastDrawTool.current : "eraser";
        onToolChange?.(next);
        const box = surfaceRef.current?.getBoundingClientRect();
        if (box) setToolFlash((f) => ({ tool: next, x: x - box.left, y: y - box.top, key: (f?.key ?? 0) + 1 }));
      },
      // With any tool active (taps don't navigate then), two fingers
      // double-tapped undo.
      twoFingerEnabled: tool !== "none",
      onTwoFingerDoubleTap: () => onStrokeUndo?.(),
    });

    return (
      <div className="h-full flex flex-col gap-1">
        <div
          ref={surfaceRef}
          onPointerDownCapture={detectPencil}
          onPointerEnter={(e) => { if (e.pointerType === "mouse") setMouseOver(true); }}
          onPointerLeave={(e) => { if (e.pointerType === "mouse") setMouseOver(false); }}
          className="flex-1 min-h-0 relative rounded overflow-hidden bg-white select-none [-webkit-touch-callout:none] touch-none"
        >
          <div
            className="absolute inset-0 will-change-transform"
            style={{
              transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
              transformOrigin: "0 0",
            }}
          >
            <div ref={ref} className="absolute inset-0" />
            <AnnotationOverlay
              containerRef={ref as React.RefObject<HTMLDivElement | null>}
              tool={tool}
              penStyle={penStyle}
              laserStyle={laserStyle}
              strokes={strokes}
              onLaserMove={onLaserMove}
              onStrokeProgress={onStrokeProgress}
              onStrokeCommit={onStrokeCommit}
              onStrokesErase={onStrokesErase}
              onStrokesUpdate={onStrokesUpdate}
              onToolChange={onToolChange}
              insertImageRef={insertImageRef}
              gestureActive={gesturing}
              pencilOnly={pencilMode}
            />
            {/* Inside the zoom transform so links track the slide when the
                presenter pinches in, and above the canvas but below the
                annotation layer. */}
            <LinkOverlay
              canvasContainerRef={ref as React.RefObject<HTMLDivElement | null>}
              links={links}
              onGoToSlide={onLinkGoTo}
              enabled={tool === "none"}
            />
          </div>
          {mediaState && mediaPlacements.length > 0 && (
            <MediaOverlay
              canvasContainerRef={ref as React.RefObject<HTMLDivElement | null>}
              placements={mediaPlacements}
              mediaState={mediaState}
              onTimeSync={onMediaTime}
              muted={muted}
              role="controller"
            />
          )}
          {toolbarVisible && onToolChange && onPenStyleChange && (
            <AnnotationToolbar
              tool={tool}
              onToolChange={onToolChange}
              penStyle={penStyle}
              onPenStyleChange={onPenStyleChange}
              laserStyle={laserStyle}
              onLaserStyleChange={onLaserStyleChange}
              canUndo={canUndo}
              canRedo={canRedo}
              canClear={strokes.length > 0}
              onUndo={onStrokeUndo ?? (() => {})}
              onRedo={onStrokeRedo ?? (() => {})}
              onClear={onAnnotationsClear ?? (() => {})}
              dimmed={!touch && !mouseOver}
              pencilMode={pencilMode}
              // Only where a finger can draw at all: touch screens (or once a
              // pencil has shown up).
              onPencilModeChange={touch || pencilMode ? onPencilModeChange : undefined}
              onInsertImage={onInsertImage}
            />
          )}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void insertImage(file);
            }}
          />
          {toolFlash && (
            <ToolFlash
              key={toolFlash.key}
              tool={toolFlash.tool}
              x={toolFlash.x}
              y={toolFlash.y}
              onDone={() => setToolFlash(null)}
            />
          )}
          {zoom.scale > 1 && (
            <Button
              type="button"
              size="icon-sm"
              onClick={resetZoom}
              className="absolute right-2 bottom-2 z-10 shadow-md"
              title="Back to fit"
              aria-label="Back to fit"
            >
              <ZoomOut className="size-4" />
            </Button>
          )}
        </div>
        {showControls && (
          <div className="flex flex-col gap-2 shrink-0 w-full">
            {mediaPlacements.map((p) => {
              const active = mediaState!.id === p.id;
              const isPlaying = active && mediaState!.action === "play";
              const isPaused = active && mediaState!.action === "pause";
              const isVideo = isPlayable(p);
              return (
                <div
                  key={p.id}
                  className={cn(
                    "flex flex-col gap-1.5 rounded-lg border-2 bg-card px-3 py-2 shadow-sm transition-colors w-full",
                    isPlaying && "border-green-500",
                    isPaused && "border-amber-500",
                    !isPlaying && !isPaused && "border-border"
                  )}
                >
                  <span
                    className="font-mono text-sm truncate"
                    title={p.filename ?? p.blobUrl}
                  >
                    {p.filename ?? p.id}
                  </span>
                  <div className="flex items-center gap-2 justify-start">
                    {isVideo && (
                      <Button
                        type="button"
                        size="icon-lg"
                        onClick={() =>
                          onMediaControl!(p.id, isPlaying ? "pause" : "play")
                        }
                        className={cn(
                          isPlaying
                            ? "bg-amber-500 text-white shadow-md ring-2 ring-amber-300 scale-105 hover:!bg-amber-600 hover:!text-white"
                            : "bg-green-500 text-white shadow-md hover:!bg-green-600 hover:!text-white"
                        )}
                        title={isPlaying ? "Pause" : "Play"}
                        aria-pressed={isPlaying}
                      >
                        {isPlaying ? (
                          <Pause className="size-5 fill-current" />
                        ) : (
                          <Play className="size-5 fill-current" />
                        )}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="icon-lg"
                      onClick={() => onMediaControl!(p.id, "reset")}
                      className="bg-blue-500 text-white shadow-md hover:!bg-blue-600 hover:!text-white"
                      title="Restart from beginning"
                    >
                      <RotateCcw className="size-5" />
                    </Button>
                    {showAudio && isVideo && (
                      <AudioControl
                        local={local}
                        audioState={audioState!}
                        onAudioChange={onAudioChange!}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }
);

function AudioControl({
  local,
  audioState,
  onAudioChange,
}: {
  local: boolean;
  audioState: AudioState;
  onAudioChange: (next: { muted: boolean; target: AudioTarget }) => void;
}) {
  const isMuted = audioState.muted;
  const activeColors = isMuted
    ? "bg-red-500 text-white shadow-md hover:!bg-red-600 hover:!text-white"
    : "bg-purple-500 text-white shadow-md hover:!bg-purple-600 hover:!text-white";

  // Local sessions run the viewer on the same machine as the controller, so the
  // controller is the only sensible audio source — drop the target selector and
  // pin the target to "controller".
  const muteButton = (
    <Button
      type="button"
      size="icon-lg"
      onClick={() =>
        onAudioChange({
          muted: !audioState.muted,
          target: local ? "controller" : audioState.target,
        })
      }
      className={activeColors}
      title={isMuted ? "Unmute" : "Mute"}
      aria-pressed={isMuted}
    >
      {isMuted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
    </Button>
  );

  if (local) return muteButton;

  return (
    <ButtonGroup>
      {muteButton}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-lg"
            className={cn("w-7", activeColors)}
            title={`Audio: ${TARGET_LABEL[audioState.target]}`}
            aria-label="Audio target"
          >
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          <div className="px-2 py-1 text-xs text-muted-foreground uppercase tracking-wide">
            Play audio on
          </div>
          <DropdownMenuRadioGroup
            value={audioState.target}
            onValueChange={(v) =>
              onAudioChange({ muted: audioState.muted, target: v as AudioTarget })
            }
          >
            {(Object.keys(TARGET_LABEL) as AudioTarget[]).map((t) => {
              const Icon = TARGET_ICON[t];
              return (
                <DropdownMenuRadioItem key={t} value={t}>
                  <Icon className="size-4" />
                  {TARGET_LABEL[t]}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

// How long the switched-to tool's icon shows, and how quickly it fades.
const FLASH_HOLD_MS = 250;
const FLASH_FADE_MS = 100;
const FLASH_ICON: Partial<Record<Tool, React.ComponentType<{ size?: number }>>> = {
  pen: PenLine,
  highlighter: Highlighter,
  eraser: Eraser,
};

function ToolFlash({ tool, x, y, onDone }: { tool: Tool; x: number; y: number; onDone: () => void }) {
  const [fading, setFading] = useState(false);
  // Latest callback, so parent re-renders don't restart the timers.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  useEffect(() => {
    const fade = setTimeout(() => setFading(true), FLASH_HOLD_MS);
    const done = setTimeout(() => onDoneRef.current(), FLASH_HOLD_MS + FLASH_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, []);
  const Icon = FLASH_ICON[tool];
  if (!Icon) return null;
  return (
    <div
      aria-hidden
      className="absolute z-20 -translate-x-1/2 -translate-y-1/2 inline-flex items-center justify-center size-7 rounded bg-primary text-primary-foreground shadow-sm pointer-events-none"
      style={{ left: x, top: y, opacity: fading ? 0 : 0.6, transition: `opacity ${FLASH_FADE_MS}ms ease-out` }}
    >
      <Icon size={15} />
    </div>
  );
}
