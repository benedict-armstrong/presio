// Replacing a session's deck: overwriting a hosted PDF in place, and telling
// the room. POST /api/sessions/:id/pdf, /deck-refreshed and the agent update
// path (presentHandoff.ts) all do this and used to carry their own copies.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Server } from "socket.io";
import { forgetDeckRetained, setRoomTotalSlides, type SocketState } from "../socket/index.js";
import type { SessionRow } from "./sessionAccess.js";

/** Keep the presenter near where they were in a deck with `totalSlides` pages. */
export const clampSlide = (current: number | null | undefined, totalSlides: number) =>
  Math.min(Math.max(current ?? 1, 1), totalSlides);

export type ReplaceResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Overwrite a synced session's hosted PDF (row: id, pdf_path, current_slide)
 * and record the new page count, clamping the current slide into it. A
 * `filename` renames the presentation too.
 */
export async function replaceHostedDeck(
  supabase: SupabaseClient,
  row: SessionRow,
  deck: { buffer: Buffer; totalSlides: number; filename?: string }
): Promise<ReplaceResult> {
  const { error: uploadError } = await supabase.storage
    .from("presentations")
    .upload(row.pdf_path, deck.buffer, { contentType: "application/pdf", upsert: true });
  if (uploadError) return { ok: false, status: 500, error: "Failed to save PDF" };
  const update: Record<string, unknown> = {
    total_slides: deck.totalSlides,
    current_slide: clampSlide(row.current_slide, deck.totalSlides),
  };
  if (deck.filename) update.filename = deck.filename;
  const { error: updateError } = await supabase.from("sessions").update(update).eq("id", row.id);
  if (updateError) return { ok: false, status: 500, error: "Failed to update session" };
  return { ok: true };
}

/**
 * The session shows a different deck now: forget what plugins retained for
 * the old one (retain: "deck" — keyed by slide number, say), let the room's
 * sockets validate slides against the new count, and have everyone reload.
 */
export function announceDeckUpdate(
  io: Server | undefined,
  socketState: SocketState | undefined,
  sessionId: string,
  deck: { filename: string; totalSlides: number }
) {
  if (socketState) forgetDeckRetained(socketState, sessionId);
  if (!io) return;
  io.to(sessionId).emit("deck_updated", deck);
  void setRoomTotalSlides(io, sessionId, deck.totalSlides).catch((err) =>
    console.warn(`Couldn't update session ${sessionId}'s sockets:`, err)
  );
}
