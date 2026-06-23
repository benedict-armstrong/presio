// Helpers for the synced media overlay: an SDK-agnostic adapter over the
// YouTube/Vimeo player APIs, embed-URL construction, the shared
// percentage-positioned style, and the viewer's latency-compensation math.

import { serverNow } from "@/lib/clock";
import type { MediaPlacement } from "@/lib/pdf";
import type { MediaTimeSync } from "@/lib/media";
import type { VimeoPlayer, YTPlayer } from "@/lib/embedPlayers";

type EmbedKind = "youtube" | "vimeo";

export function isYT(kind: EmbedKind): kind is "youtube" {
  return kind === "youtube";
}

export function playPlayer(player: YTPlayer | VimeoPlayer, kind: EmbedKind) {
  if (isYT(kind)) (player as YTPlayer).playVideo();
  else (player as VimeoPlayer).play().catch(() => {});
}

export function pausePlayer(player: YTPlayer | VimeoPlayer, kind: EmbedKind) {
  if (isYT(kind)) (player as YTPlayer).pauseVideo();
  else (player as VimeoPlayer).pause().catch(() => {});
}

export function seekPlayer(player: YTPlayer | VimeoPlayer, kind: EmbedKind, t: number) {
  if (isYT(kind)) (player as YTPlayer).seekTo(t, true);
  else (player as VimeoPlayer).setCurrentTime(t).catch(() => {});
}

export function setPlayerMuted(player: YTPlayer | VimeoPlayer, kind: EmbedKind, muted: boolean) {
  if (kind === "youtube") {
    if (muted) (player as YTPlayer).mute();
    else (player as YTPlayer).unMute();
  } else {
    (player as VimeoPlayer).setMuted(muted).catch(() => {});
  }
}

export function buildEmbedSrc(p: MediaPlacement, showControls: boolean): string {
  if (p.kind === "youtube" && p.videoId) {
    const q = new URLSearchParams();
    q.set("enablejsapi", "1");
    q.set("rel", "0");
    q.set("modestbranding", "1");
    q.set("playsinline", "1");
    q.set("controls", showControls ? "1" : "0");
    // Disable the keyboard, fullscreen button, and end-card overlays for
    // viewers so nothing surfaces UI we don't control.
    if (!showControls) {
      q.set("disablekb", "1");
      q.set("fs", "0");
      q.set("iv_load_policy", "3");
    }
    if (p.loop) {
      q.set("loop", "1");
      q.set("playlist", p.videoId);
    }
    if (typeof window !== "undefined") q.set("origin", window.location.origin);
    return `https://www.youtube-nocookie.com/embed/${p.videoId}?${q}`;
  }
  if (p.kind === "vimeo" && p.videoId) {
    const q = new URLSearchParams();
    q.set("dnt", "1");
    q.set("controls", showControls ? "true" : "false");
    if (p.loop) q.set("loop", "1");
    return `https://player.vimeo.com/video/${p.videoId}?${q}`;
  }
  return "";
}

/** Absolute box positioning a placement within the slide, as percentages of
 *  the contained-canvas rect. Callers spread this and add their own specifics
 *  (object-fit, borders, pointer-events). */
export function placementBox(p: MediaPlacement): React.CSSProperties {
  return {
    position: "absolute",
    left: `${p.xPct * 100}%`,
    top: `${p.yPct * 100}%`,
    width: `${p.wPct * 100}%`,
    height: `${p.hPct * 100}%`,
  };
}

/** Where the controller "is" now, given a time-sync sample: while playing, add
 *  the elapsed transit latency to the sampled time; while paused, take it as-is. */
export function expectedTime(sync: MediaTimeSync): number {
  const latencyS = Math.max(0, (serverNow() - sync.sampledAt) / 1000);
  return sync.playing ? sync.t + latencyS : sync.t;
}
