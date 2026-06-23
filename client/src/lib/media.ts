// Shared media types and audio-routing logic for the synced media overlay.
// Kept separate from the React components so they can be imported without
// pulling in the overlay tree (and without tripping react-refresh).

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

export const defaultAudioState: AudioState = { muted: true, target: "both", seq: 0 };

export function isMutedForRole(role: MediaRole, audio: AudioState): boolean {
  if (audio.muted) return true;
  if (audio.target === "both") return false;
  if (audio.target === "controller") return role !== "controller";
  return role !== "viewer";
}
