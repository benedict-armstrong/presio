import { useEffect, useState } from "react";
import type { MediaPlacement } from "@/lib/pdf";
import type { MediaRole, MediaState, MediaTimeSync } from "@/lib/media";
import { NativeMediaItem } from "@/components/media/NativeMediaItem";
import { EmbedMediaItem } from "@/components/media/EmbedMediaItem";

// Re-export the shared media types/helpers so existing import sites that pull
// them from this module keep working.
export type { MediaRole, MediaState, MediaTimeSync, AudioState, AudioTarget } from "@/lib/media";

interface Props {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  placements: MediaPlacement[];
  mediaState: MediaState;
  /** If true (viewer), gifs run on slide enter; controller stays paused until told. */
  autostart?: boolean;
  /** Controller-only: called periodically with the current video time. The
   *  fourth arg is the server-clock ms when this sample was taken. */
  onTimeSync?: (id: string, t: number, playing: boolean, sampledAt: number) => void;
  /** Viewer-only: latest time-sync message from the controller. */
  timeSync?: MediaTimeSync | null;
  /** Whether videos in this overlay should be muted. */
  muted?: boolean;
  /** Which side this overlay is rendered on. Hides controls for viewers and
   *  determines who drives play/pause for cross-origin embeds. */
  role?: MediaRole;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function computeContainedRect(
  containerW: number,
  containerH: number,
  intrinsicW: number,
  intrinsicH: number
): Rect {
  if (!containerW || !containerH || !intrinsicW || !intrinsicH) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(containerW / intrinsicW, containerH / intrinsicH);
  const width = intrinsicW * scale;
  const height = intrinsicH * scale;
  return {
    left: (containerW - width) / 2,
    top: (containerH - height) / 2,
    width,
    height,
  };
}

export function MediaOverlay({
  canvasContainerRef,
  placements,
  mediaState,
  autostart = false,
  onTimeSync,
  timeSync = null,
  muted = true,
  role = "viewer",
}: Props) {
  const [rect, setRect] = useState<Rect>({ left: 0, top: 0, width: 0, height: 0 });

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const measure = () => {
      const canvas = container.querySelector("canvas");
      if (!canvas) {
        setRect({ left: 0, top: 0, width: 0, height: 0 });
        return;
      }
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      setRect(computeContainedRect(cw, ch, canvas.width, canvas.height));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    // The canvas element is swapped on slide change; watch for child mutations
    const mo = new MutationObserver(measure);
    mo.observe(container, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [canvasContainerRef, placements]);

  if (!placements.length || rect.width === 0) return null;

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
    >
      {placements.map((p) => {
        if (p.kind === "youtube" || p.kind === "vimeo") {
          return (
            <EmbedMediaItem
              key={p.id}
              placement={p}
              mediaState={mediaState}
              autostart={autostart}
              muted={muted}
              role={role}
              onTimeSync={onTimeSync}
              timeSync={timeSync && timeSync.id === p.id ? timeSync : null}
            />
          );
        }
        return (
          <NativeMediaItem
            key={p.id}
            placement={p}
            mediaState={mediaState}
            autostart={autostart}
            onTimeSync={onTimeSync}
            timeSync={timeSync && timeSync.id === p.id ? timeSync : null}
            muted={muted}
          />
        );
      })}
    </div>
  );
}
