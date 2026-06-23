import { useEffect, useRef, useState } from "react";
import { serverNow } from "@/lib/clock";
import type { MediaPlacement } from "@/lib/pdf";
import type { MediaRole, MediaState, MediaTimeSync } from "@/lib/media";
import {
  loadVimeoApi,
  loadYouTubeApi,
  YT_STATE,
  type VimeoPlayer,
  type VimeoTimeData,
  type YTPlayer,
} from "@/lib/embedPlayers";
import {
  buildEmbedSrc,
  expectedTime,
  pausePlayer,
  placementBox,
  playPlayer,
  seekPlayer,
  setPlayerMuted,
} from "@/lib/mediaPlayer";

// YouTube / Vimeo embed. Both SDKs are lazy-loaded on first use. The
// controller drives play/pause/reset via the SDK; viewers see the same
// iframe with player chrome hidden, mirroring the controller's state.
export function EmbedMediaItem({
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

    const expectedT = expectedTime(timeSync);
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

  if (!placement.videoId) return null;

  const style: React.CSSProperties = {
    ...placementBox(placement),
    border: 0,
    pointerEvents: role === "controller" ? "auto" : "none",
  };

  const overlayStyle: React.CSSProperties = {
    ...placementBox(placement),
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
