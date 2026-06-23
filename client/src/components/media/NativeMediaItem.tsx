import { useEffect, useRef } from "react";
import { serverNow } from "@/lib/clock";
import type { MediaPlacement } from "@/lib/pdf";
import type { MediaState, MediaTimeSync } from "@/lib/media";
import { placementBox, expectedTime } from "@/lib/mediaPlayer";

// A locally-hosted <video> or animated GIF. The controller drives playback and
// emits time-sync samples; the viewer trims playbackRate to stay in lockstep.
export function NativeMediaItem({
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
  // 1. Latency compensation via expectedTime() — compare against where the
  //    controller is *now*.
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

    const expectedT = expectedTime(timeSync);
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

  const style: React.CSSProperties = { ...placementBox(placement), objectFit: "cover" };

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
