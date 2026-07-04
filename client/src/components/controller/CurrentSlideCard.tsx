import { forwardRef } from "react";
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
} from "lucide-react";
import { MediaOverlay, type MediaState, type AudioState, type AudioTarget } from "@/components/MediaOverlay";
import { AnnotationOverlay } from "@/components/AnnotationOverlay";
import { AnnotationToolbar } from "@/components/AnnotationToolbar";
import { DEFAULT_PEN_STYLE, type LaserPoint, type PenStyle, type Stroke, type Tool } from "@/lib/annotations";
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
import type { MediaPlacement } from "@/lib/pdf";

interface Props {
  local?: boolean;
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
  onToolChange?: (tool: Tool) => void;
  onLaserMove?: (pt: LaserPoint | null) => void;
  penStyle?: PenStyle;
  onPenStyleChange?: (style: PenStyle) => void;
  strokes?: readonly Stroke[];
  onStrokeProgress?: (stroke: Stroke | null) => void;
  onStrokeCommit?: (stroke: Stroke) => void;
  onStrokeUndo?: () => void;
  onAnnotationsClear?: () => void;
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
      mediaState,
      onMediaControl,
      onMediaTime,
      muted = true,
      audioState,
      onAudioChange,
      tool = "none",
      toolbarVisible = true,
      onToolChange,
      onLaserMove,
      penStyle = DEFAULT_PEN_STYLE,
      onPenStyleChange,
      strokes = [],
      onStrokeProgress,
      onStrokeCommit,
      onStrokeUndo,
      onAnnotationsClear,
    },
    ref
  ) => {
    const showControls = mediaPlacements.length > 0 && !!onMediaControl && !!mediaState;
    const isPlayable = (p: MediaPlacement) =>
      p.mime.startsWith("video/") || p.kind === "youtube" || p.kind === "vimeo";
    const hasVideo = mediaPlacements.some(isPlayable);
    const showAudio = showControls && hasVideo && !!audioState && !!onAudioChange;

    return (
      <div className="h-full flex flex-col gap-1">
        <div className="flex-1 min-h-0 relative rounded overflow-hidden bg-white">
          <div ref={ref} className="absolute inset-0" />
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
          <AnnotationOverlay
            containerRef={ref as React.RefObject<HTMLDivElement | null>}
            tool={tool}
            penStyle={penStyle}
            strokes={strokes}
            onLaserMove={onLaserMove}
            onStrokeProgress={onStrokeProgress}
            onStrokeCommit={onStrokeCommit}
          />
          {toolbarVisible && onToolChange && onPenStyleChange && (
            <AnnotationToolbar
              tool={tool}
              onToolChange={onToolChange}
              penStyle={penStyle}
              onPenStyleChange={onPenStyleChange}
              canUndo={strokes.length > 0}
              onUndo={onStrokeUndo ?? (() => {})}
              onClear={onAnnotationsClear ?? (() => {})}
            />
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
