import { useEffect, useRef, useState } from "react";
import { serverNow } from "@/lib/clock";
import type { MediaPlacement } from "@/lib/pdf";
import {
  loadVimeoApi,
  loadYouTubeApi,
  YT_STATE,
  type VimeoPlayer,
  type VimeoTimeData,
  type YTPlayer,
} from "@/lib/embedPlayers";

export type MediaRole = "controller" | "viewer";

export interface MediaState {
  id: string | null;
  action: "play" | "pause" | "reset";
  seq: number;
}

export interface MediaTimeSync {
  id: string;
  t: number;
  playing: boolean;
  /** Server-clock ms when the controller sampled `t`. Used by the viewer to
   *  compensate for transit + queueing latency. */
  sampledAt: number;
  seq: number;
}

export type AudioTarget = "controller" | "both" | "viewers";

export interface AudioState {
  muted: boolean;
  target: AudioTarget;
  seq: number;
}

// eslint-disable-next-line react-refresh/only-export-components
export const defaultAudioState: AudioState = { muted: true, target: "both", seq: 0 };

// eslint-disable-next-line react-refresh/only-export-components
export function isMutedForRole(role: "controller" | "viewer", audio: AudioState): boolean {
  if (audio.muted) return true;
  if (audio.target === "both") return false;
  if (audio.target === "controller") return role !== "controller";
  return role !== "viewer";
}

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

function NativeMediaItem({
  placement,
  mediaState,
  autostart,
  onTimeSync,
  timeSync,
  muted,
}: {
  placement: MediaPlacement;
  mediaState: MediaState;
  autostart: boolean;
  onTimeSync?: (id: string, t: number, playing: boolean, sampledAt: number) => void;
  timeSync: MediaTimeSync | null;
  muted: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const isVideo = placement.mime.startsWith("video/");
  const targeted = mediaState.id === placement.id;

  // Apply playback state to <video>. On the controller (onTimeSync set), also
  // emit an immediate time-sync so viewers don't wait for the next 1s tick.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (autostart && placement.autoplay && mediaState.id === null) {
      v.currentTime = 0;
      v.play().catch(() => { /* autoplay blocked */ });
      return;
    }
    if (!targeted) return;
    const now = serverNow();
    if (mediaState.action === "play") {
      v.play().catch(() => {});
      onTimeSync?.(placement.id, v.currentTime, true, now);
    } else if (mediaState.action === "pause") {
      v.pause();
      onTimeSync?.(placement.id, v.currentTime, false, now);
    } else if (mediaState.action === "reset") {
      const wasPlaying = !v.paused;
      v.currentTime = 0;
      if (wasPlaying) v.play().catch(() => {});
      onTimeSync?.(placement.id, 0, wasPlaying, now);
    }
  }, [mediaState, targeted, placement.autoplay, placement.id, autostart, onTimeSync]);

  // For GIFs, "reset" by re-assigning src forces playback from frame 0.
  // Use the reset action's seq as the cache-busting nonce so the URL changes
  // on each new reset without needing a setState in an effect.
  const gifNonce =
    !isVideo && targeted && mediaState.action === "reset" ? mediaState.seq : 0;

  // Controller: periodically emit current playback time + sample timestamp.
  // 250ms tick keeps corrections small so we never need a hard re-seek.
  useEffect(() => {
    if (!onTimeSync || !isVideo) return;
    const v = videoRef.current;
    if (!v) return;
    const tick = () => {
      if (v.readyState >= 1) {
        onTimeSync(placement.id, v.currentTime, !v.paused, serverNow());
      }
    };
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [onTimeSync, isVideo, placement.id]);

  // Apply muted state imperatively (React's muted attr is not reliably controlled)
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.muted = muted;
  }, [muted]);

  // Viewer: apply incoming time sync.
  //
  // 1. Latency compensation:
  //      expectedT = sample.t + (serverNow - sample.sampledAt)
  //    — compare against where the controller is *now*.
  // 2. EWMA-smoothed drift kills per-sample jitter (network + browser noise),
  //    so playbackRate doesn't flap on every tick (the main source of the
  //    audio "warble").
  // 3. Rate tuning is audio-aware: when this viewer is muted we can correct
  //    aggressively (±10 % / K=0.4); when unmuted we keep the rate within
  //    ±2 % so it stays inaudible, accepting slower convergence.
  // 4. Hard re-anchor only if drift exceeds HARD (a backstop).
  const driftEwmaRef = useRef<number | null>(null);
  useEffect(() => {
    if (!timeSync || !isVideo) return;
    const v = videoRef.current;
    if (!v) return;

    // Match play/pause state first.
    if (timeSync.playing && v.paused) {
      v.play().catch(() => {});
    } else if (!timeSync.playing && !v.paused) {
      v.pause();
    }

    // Make rate shifts sound like a tape, not a vocoder (less artifacted at
    // small deltas). Setting on every effect is cheap and idempotent.
    type WithPitch = HTMLVideoElement & {
      preservesPitch?: boolean;
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    const vp = v as WithPitch;
    if (vp.preservesPitch !== undefined) vp.preservesPitch = false;
    else if (vp.mozPreservesPitch !== undefined) vp.mozPreservesPitch = false;
    else if (vp.webkitPreservesPitch !== undefined) vp.webkitPreservesPitch = false;

    const latencyS = Math.max(0, (serverNow() - timeSync.sampledAt) / 1000);
    const expectedT = timeSync.playing ? timeSync.t + latencyS : timeSync.t;
    const rawDrift = v.currentTime - expectedT;

    // EWMA smoothing on drift. Reseed if direction flips by a large step or
    // we've been seeking, so the filter converges quickly on a real change.
    const prev = driftEwmaRef.current;
    const SMOOTHED_RESET = 1.0;
    let smoothed: number;
    if (prev === null || Math.abs(rawDrift - prev) > SMOOTHED_RESET) {
      smoothed = rawDrift;
    } else {
      const ALPHA = 0.3;
      smoothed = prev * (1 - ALPHA) + rawDrift * ALPHA;
    }
    driftEwmaRef.current = smoothed;

    const HARD = 2.0;
    if (Math.abs(smoothed) > HARD) {
      v.playbackRate = 1;
      v.currentTime = Math.max(0, expectedT);
      driftEwmaRef.current = null;
      return;
    }

    // Audio-aware gain.
    const audible = !muted;
    const DEAD = audible ? 0.15 : 0.05;
    const K = audible ? 0.05 : 0.4;
    const RATE_MIN = audible ? 0.98 : 0.9;
    const RATE_MAX = audible ? 1.02 : 1.1;

    // Soft dead-zone: subtract DEAD from |drift| and correct only the excess.
    // Inside DEAD → rate = 1 exactly; at the edge it stays 1 and ramps up
    // smoothly outside, so we always aim at 0 drift (not at the DEAD boundary)
    // without any step at the threshold.
    let rate = 1;
    if (timeSync.playing) {
      const excess = Math.max(0, Math.abs(smoothed) - DEAD);
      const signedExcess = Math.sign(smoothed) * excess;
      rate = Math.max(RATE_MIN, Math.min(RATE_MAX, 1 - K * signedExcess));
    }
    // Snap to 1 if close to avoid lingering imperceptible drift on the rate.
    if (Math.abs(rate - 1) < 0.005) rate = 1;
    if (Math.abs(v.playbackRate - rate) > 0.002) v.playbackRate = rate;
  }, [timeSync, isVideo, muted]);

  // Reset the drift filter whenever play/pause state or target id changes so
  // we don't carry stale samples into a new context.
  useEffect(() => {
    driftEwmaRef.current = null;
  }, [mediaState.id, mediaState.action, mediaState.seq]);

  const style: React.CSSProperties = {
    position: "absolute",
    left: `${placement.xPct * 100}%`,
    top: `${placement.yPct * 100}%`,
    width: `${placement.wPct * 100}%`,
    height: `${placement.hPct * 100}%`,
    objectFit: "cover",
  };

  if (isVideo) {
    return (
      <video
        ref={videoRef}
        src={placement.blobUrl}
        style={style}
        muted
        playsInline
        loop={placement.loop}
      />
    );
  }

  // GIF (or unknown image) — append nonce to URL to force restart on reset
  const src =
    gifNonce > 0 ? `${placement.blobUrl}#n=${gifNonce}` : placement.blobUrl;
  return <img ref={imgRef} src={src} style={style} alt="" />;
}

// YouTube / Vimeo embed. Both SDKs are lazy-loaded on first use. The
// controller drives play/pause/reset via the SDK; viewers see the same
// iframe with player chrome hidden, mirroring the controller's state.
function EmbedMediaItem({
  placement,
  mediaState,
  autostart,
  muted,
  role,
  onTimeSync,
  timeSync,
}: {
  placement: MediaPlacement;
  mediaState: MediaState;
  autostart: boolean;
  muted: boolean;
  role: MediaRole;
  onTimeSync?: (id: string, t: number, playing: boolean, sampledAt: number) => void;
  timeSync: MediaTimeSync | null;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<YTPlayer | VimeoPlayer | null>(null);
  const readyRef = useRef(false);

  const targeted = mediaState.id === placement.id;
  const showControls = role === "controller";
  const src = buildEmbedSrc(placement, showControls);

  // Latest input snapshot for use from the SDK's async ready callback —
  // avoids stale closures without forcing extra renders. Updated in an
  // effect (before the apply effect below) so React's strict ref-write
  // rule is respected.
  const inputsRef = useRef({
    kind: placement.kind,
    id: placement.id,
    autoplay: placement.autoplay,
    mediaState,
    targeted,
    autostart,
    muted,
    role,
    onTimeSync,
  });
  useEffect(() => {
    inputsRef.current = {
      kind: placement.kind,
      id: placement.id,
      autoplay: placement.autoplay,
      mediaState,
      targeted,
      autostart,
      muted,
      role,
      onTimeSync,
    };
  });

  // Latest Vimeo time/play state, fed by Vimeo's promise-based event API so
  // the controller's 250ms tick can read it synchronously.
  const vimeoSampleRef = useRef<{ t: number; playing: boolean }>({ t: 0, playing: false });

  // Track the last play/pause we issued to the SDK. Repeatedly calling
  // playVideo() on YouTube while audio is unmuted freezes the decoder, so we
  // only issue a transition when it actually changes — same pattern as
  // NativeMediaItem's `if (timeSync.playing && v.paused)` guard.
  const lastIssuedPlayingRef = useRef<boolean | null>(null);
  const setPlaying = (playing: boolean) => {
    const p = playerRef.current;
    const s = inputsRef.current;
    if (!p || !readyRef.current) return;
    if (s.kind !== "youtube" && s.kind !== "vimeo") return;
    if (lastIssuedPlayingRef.current === playing) return;
    lastIssuedPlayingRef.current = playing;
    if (playing) playPlayer(p, s.kind);
    else pausePlayer(p, s.kind);
  };

  const emitTimeSync = () => {
    const p = playerRef.current;
    const s = inputsRef.current;
    if (!p || !readyRef.current || s.role !== "controller" || !s.onTimeSync) return;
    if (s.kind === "youtube") {
      const yp = p as YTPlayer;
      const playing = yp.getPlayerState() === YT_STATE.PLAYING;
      s.onTimeSync(s.id, yp.getCurrentTime(), playing, serverNow());
    } else if (s.kind === "vimeo") {
      const { t, playing } = vimeoSampleRef.current;
      s.onTimeSync(s.id, t, playing, serverNow());
    }
  };

  // Browsers block audio playback that wasn't started by a user gesture. On
  // the controller, the toggle click counts as that gesture; on viewers,
  // however, a remote websocket message asking us to unmute does NOT — YouTube
  // responds by pausing the iframe and showing its play overlay (the freeze
  // the user reported). So on viewers we keep the player muted until the
  // audience taps the "enable audio" overlay; that tap is a real gesture and
  // lets us unmute.
  const [audioGestureGranted, setAudioGestureGranted] = useState(false);
  const needsAudioGesture = role === "viewer" && !muted && !audioGestureGranted;
  const applyMute = () => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    if (placement.kind !== "youtube" && placement.kind !== "vimeo") return;
    const allowed = role !== "viewer" || audioGestureGranted;
    const effectiveMuted = !muted && !allowed ? true : muted;
    setPlayerMuted(p, placement.kind, effectiveMuted);
  };
  const handleEnableAudio = () => {
    // Flip state first so the next render reflects the granted gesture; we
    // also unmute the player directly here so the synchronous click handler
    // (a valid user gesture) carries through to the SDK call.
    setAudioGestureGranted(true);
    const p = playerRef.current;
    if (p && readyRef.current && (placement.kind === "youtube" || placement.kind === "vimeo")) {
      setPlayerMuted(p, placement.kind, false);
    }
  };

  const applyState = () => {
    const p = playerRef.current;
    const s = inputsRef.current;
    if (!p || !readyRef.current) return;
    if (s.kind !== "youtube" && s.kind !== "vimeo") return;
    if (s.autostart && s.autoplay && s.mediaState.id === null) {
      setPlaying(true);
      return;
    }
    if (!s.targeted) return;
    if (s.mediaState.action === "play") setPlaying(true);
    else if (s.mediaState.action === "pause") setPlaying(false);
    else if (s.mediaState.action === "reset") {
      seekPlayer(p, s.kind, 0);
      lastIssuedPlayingRef.current = null;
    }
  };

  // Lazy-load the SDK and attach a player to the iframe. Re-runs if the
  // iframe `src` changes (e.g. role flip), fully tearing down the previous
  // player so SDKs always bind to the live <iframe>.
  useEffect(() => {
    const el = iframeRef.current;
    if (!el || !placement.videoId) return;
    let cancelled = false;
    readyRef.current = false;

    (async () => {
      try {
        if (placement.kind === "youtube") {
          const YT = await loadYouTubeApi();
          if (cancelled) return;
          const p = new YT.Player(el, {
            events: {
              onReady: () => {
                if (cancelled) return;
                readyRef.current = true;
                applyMute();
                applyState();
                emitTimeSync();
              },
              // Fires on play / pause / seek (YT issues PAUSED → PLAYING
              // around a seek). Emit immediately so viewers don't wait for
              // the next 250ms tick.
              onStateChange: () => {
                if (!readyRef.current) return;
                emitTimeSync();
              },
            },
          });
          playerRef.current = p;
        } else {
          const Ctor = await loadVimeoApi();
          if (cancelled) return;
          const p = new Ctor(el);
          playerRef.current = p;
          // Vimeo's APIs are promise-based — keep a synchronous cache of
          // (t, playing) so the controller's tick emits without awaiting.
          const onTimeUpdate = (data?: VimeoTimeData) => {
            vimeoSampleRef.current = {
              t: data?.seconds ?? vimeoSampleRef.current.t,
              playing: vimeoSampleRef.current.playing,
            };
          };
          const onPlay = (data?: VimeoTimeData) => {
            vimeoSampleRef.current = { t: data?.seconds ?? vimeoSampleRef.current.t, playing: true };
            emitTimeSync();
          };
          const onPause = (data?: VimeoTimeData) => {
            vimeoSampleRef.current = { t: data?.seconds ?? vimeoSampleRef.current.t, playing: false };
            emitTimeSync();
          };
          const onSeeked = (data?: VimeoTimeData) => {
            vimeoSampleRef.current = {
              t: data?.seconds ?? vimeoSampleRef.current.t,
              playing: vimeoSampleRef.current.playing,
            };
            emitTimeSync();
          };
          p.on("timeupdate", onTimeUpdate);
          p.on("play", onPlay);
          p.on("pause", onPause);
          p.on("seeked", onSeeked);
          p.ready()
            .then(() => {
              if (cancelled) return;
              readyRef.current = true;
              applyMute();
              applyState();
              emitTimeSync();
            })
            .catch(() => {});
        }
      } catch {
        // SDK load failed; the bare iframe still renders with its URL-param
        // playback options as a degraded fallback.
      }
    })();

    return () => {
      cancelled = true;
      const p = playerRef.current;
      playerRef.current = null;
      readyRef.current = false;
      lastIssuedPlayingRef.current = null;
      try {
        (p as { destroy?: () => unknown } | null)?.destroy?.();
      } catch { /* ignore */ }
    };
    // applyState reads inputsRef each call, so it is stable for these deps.
  }, [placement.kind, placement.videoId, src]);

  // Re-apply playback state whenever the controller's mediaState or autostart
  // inputs change. Mute is handled separately so toggling audio doesn't
  // re-issue play (which freezes YouTube's decoder when unmuted).
  useEffect(() => {
    applyState();
    // applyState pulls from inputsRef (kept in sync above on every render),
    // so this effect's deps just need to fire on actual input changes.
  }, [mediaState, targeted, autostart, placement.kind, placement.autoplay]);

  useEffect(() => {
    applyMute();
    // applyMute reads `muted`/`role`/gesture state; deps trigger on input change.
  }, [muted, placement.kind, role, audioGestureGranted]);

  // Controller: periodically emit current playback time + sample timestamp,
  // mirroring the native <video> path. Seek/play/pause via the iframe's own
  // chrome lands here on the next tick (plus an instant emit on each state
  // change in the SDK callbacks above).
  useEffect(() => {
    if (role !== "controller" || !onTimeSync) return;
    const interval = setInterval(() => {
      if (readyRef.current) emitTimeSync();
    }, 250);
    return () => clearInterval(interval);
    // emitTimeSync reads inputsRef and playerRef.
  }, [role, onTimeSync, placement.id]);

  // Viewer: apply incoming time sync. Match play/pause to the controller's
  // current state and seek when drift exceeds HARD; YT/Vimeo embeds don't
  // expose continuous playback-rate trimming the way <video> does, so we
  // rely on coarse re-seeks instead of the EWMA-smoothed rate adjustment.
  useEffect(() => {
    if (role !== "viewer" || !timeSync) return;
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    if (placement.kind !== "youtube" && placement.kind !== "vimeo") return;

    const latencyS = Math.max(0, (serverNow() - timeSync.sampledAt) / 1000);
    const expectedT = timeSync.playing ? timeSync.t + latencyS : timeSync.t;
    const HARD = 1.5;

    setPlaying(timeSync.playing);

    if (placement.kind === "youtube") {
      const drift = (p as YTPlayer).getCurrentTime() - expectedT;
      if (Math.abs(drift) > HARD) (p as YTPlayer).seekTo(Math.max(0, expectedT), true);
    } else {
      (p as VimeoPlayer).getCurrentTime().then((current) => {
        if (Math.abs(current - expectedT) > HARD) {
          (p as VimeoPlayer).setCurrentTime(Math.max(0, expectedT)).catch(() => {});
        }
      }).catch(() => {});
    }
  }, [timeSync, role, placement.kind]);

  const style: React.CSSProperties = {
    position: "absolute",
    left: `${placement.xPct * 100}%`,
    top: `${placement.yPct * 100}%`,
    width: `${placement.wPct * 100}%`,
    height: `${placement.hPct * 100}%`,
    border: 0,
    pointerEvents: role === "controller" ? "auto" : "none",
  };

  if (!placement.videoId) return null;

  const overlayStyle: React.CSSProperties = {
    position: "absolute",
    left: `${placement.xPct * 100}%`,
    top: `${placement.yPct * 100}%`,
    width: `${placement.wPct * 100}%`,
    height: `${placement.hPct * 100}%`,
    pointerEvents: "auto",
    background: "rgba(0,0,0,0.55)",
    color: "white",
    border: 0,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    fontWeight: 500,
    gap: 8,
  };

  return (
    <>
      <iframe
        ref={iframeRef}
        src={src}
        style={style}
        allow={
          placement.kind === "youtube"
            ? "autoplay; encrypted-media; picture-in-picture"
            : "autoplay; fullscreen; picture-in-picture"
        }
        allowFullScreen
        title={placement.kind === "youtube" ? "YouTube video" : "Vimeo video"}
      />
      {needsAudioGesture && (
        <button type="button" onClick={handleEnableAudio} style={overlayStyle}>
          Tap to enable audio
        </button>
      )}
    </>
  );
}

function buildEmbedSrc(p: MediaPlacement, showControls: boolean): string {
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

function isYT(kind: "youtube" | "vimeo"): kind is "youtube" {
  return kind === "youtube";
}

function playPlayer(player: YTPlayer | VimeoPlayer, kind: "youtube" | "vimeo") {
  if (isYT(kind)) (player as YTPlayer).playVideo();
  else (player as VimeoPlayer).play().catch(() => {});
}

function pausePlayer(player: YTPlayer | VimeoPlayer, kind: "youtube" | "vimeo") {
  if (isYT(kind)) (player as YTPlayer).pauseVideo();
  else (player as VimeoPlayer).pause().catch(() => {});
}

function seekPlayer(player: YTPlayer | VimeoPlayer, kind: "youtube" | "vimeo", t: number) {
  if (isYT(kind)) (player as YTPlayer).seekTo(t, true);
  else (player as VimeoPlayer).setCurrentTime(t).catch(() => {});
}

function setPlayerMuted(
  player: YTPlayer | VimeoPlayer,
  kind: "youtube" | "vimeo",
  muted: boolean
) {
  if (kind === "youtube") {
    if (muted) (player as YTPlayer).mute();
    else (player as YTPlayer).unMute();
  } else {
    (player as VimeoPlayer).setMuted(muted).catch(() => {});
  }
}
