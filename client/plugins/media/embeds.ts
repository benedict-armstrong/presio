// YouTube and Vimeo: lazy loaders for their player SDKs, embed URLs, and one
// small interface (play / pause / seek / mute) over both, so the rest of the
// plugin drives either the same way.

import type { Placement } from "./placements";

// YouTube player state codes (https://developers.google.com/youtube/iframe_api_reference)
export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead?: boolean): void;
  mute(): void;
  unMute(): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLIFrameElement,
    opts: { events?: { onReady?: () => void; onStateChange?: (e: { data: number }) => void } }
  ) => YTPlayer;
}

export type VimeoEvent = "play" | "pause" | "timeupdate" | "seeked";
export interface VimeoTimeData {
  seconds: number;
}

export interface VimeoPlayer {
  ready(): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  getCurrentTime(): Promise<number>;
  setCurrentTime(seconds: number): Promise<number>;
  setMuted(muted: boolean): Promise<boolean>;
  on(event: VimeoEvent, fn: (data?: VimeoTimeData) => void): void;
  destroy(): Promise<void>;
}

type VimeoCtor = new (el: HTMLIFrameElement) => VimeoPlayer;

// The SDKs' globals, on this frame's window.
const w = window as unknown as {
  YT?: YTNamespace;
  onYouTubeIframeAPIReady?: () => void;
  Vimeo?: { Player: VimeoCtor };
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

let yt: Promise<YTNamespace> | null = null;
export function loadYouTubeApi(): Promise<YTNamespace> {
  return (yt ??= new Promise<YTNamespace>((resolve, reject) => {
    if (w.YT?.Player) return resolve(w.YT);
    // The loader calls one global when it's ready; chain any previous one.
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (w.YT?.Player) resolve(w.YT);
      else reject(new Error("YouTube IFrame API loaded without YT.Player"));
    };
    loadScript("https://www.youtube.com/iframe_api").catch(reject);
  }));
}

let vimeo: Promise<VimeoCtor> | null = null;
export function loadVimeoApi(): Promise<VimeoCtor> {
  return (vimeo ??= (async () => {
    if (!w.Vimeo?.Player) await loadScript("https://player.vimeo.com/api/player.js");
    if (!w.Vimeo?.Player) throw new Error("Vimeo SDK loaded without Vimeo.Player");
    return w.Vimeo.Player;
  })());
}

/** The embed's URL. The presenter gets the provider's own controls; viewers
 *  get a bare player that only follows the presenter. */
export function embedSrc(p: Placement, presenter: boolean): string {
  if (p.kind === "youtube") {
    const q = new URLSearchParams({
      enablejsapi: "1",
      rel: "0",
      modestbranding: "1",
      playsinline: "1",
      controls: presenter ? "1" : "0",
      origin: window.location.origin,
    });
    // Nothing on a viewer's screen that the presenter doesn't control: no
    // keyboard, fullscreen button or end-card overlays.
    if (!presenter) {
      q.set("disablekb", "1");
      q.set("fs", "0");
      q.set("iv_load_policy", "3");
    }
    if (p.loop) {
      q.set("loop", "1");
      q.set("playlist", p.videoId!);
    }
    return `https://www.youtube-nocookie.com/embed/${p.videoId}?${q}`;
  }
  const q = new URLSearchParams({ dnt: "1", controls: presenter ? "true" : "false" });
  if (p.loop) q.set("loop", "1");
  return `https://player.vimeo.com/video/${p.videoId}?${q}`;
}

export type EmbedPlayer = { kind: "youtube"; player: YTPlayer } | { kind: "vimeo"; player: VimeoPlayer };

export function play(e: EmbedPlayer) {
  if (e.kind === "youtube") e.player.playVideo();
  else e.player.play().catch(() => {});
}

export function pause(e: EmbedPlayer) {
  if (e.kind === "youtube") e.player.pauseVideo();
  else e.player.pause().catch(() => {});
}

export function seek(e: EmbedPlayer, t: number) {
  if (e.kind === "youtube") e.player.seekTo(t, true);
  else e.player.setCurrentTime(t).catch(() => {});
}

export function setMuted(e: EmbedPlayer, muted: boolean) {
  if (e.kind === "vimeo") e.player.setMuted(muted).catch(() => {});
  else if (muted) e.player.mute();
  else e.player.unMute();
}
