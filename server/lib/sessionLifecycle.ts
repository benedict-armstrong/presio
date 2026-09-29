// Ending sessions, whether the controller ends one (DELETE /api/sessions/:id)
// or it expires (the hourly cleanup in index.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Server } from "socket.io";
import { clearSessionState, type SocketState } from "../socket.js";

/**
 * End sessions: remove their PDFs, mark them expired (the rows are kept as a
 * record), tell every connected window and drop it, and forget their socket
 * state. Without the last two, a presentation that ends mid-use just goes
 * dead: the controller's events are silently discarded once its registration
 * is cleared, with no feedback to anyone.
 */
export async function endSessions(
  supabase: SupabaseClient,
  io: Server,
  socketState: SocketState | undefined,
  rows: { id: string; pdf_path?: string | null }[]
): Promise<void> {
  if (!rows.length) return;
  const paths = rows.map((r) => r.pdf_path).filter((p): p is string => !!p);
  if (paths.length) await supabase.storage.from("presentations").remove(paths);
  const ids = rows.map((r) => r.id);
  await supabase.from("sessions").update({ status: "expired" }).in("id", ids);
  for (const id of ids) {
    const sockets = await io.in(id).fetchSockets();
    for (const s of sockets) {
      s.emit("session_ended");
      s.disconnect(true);
    }
    if (socketState) clearSessionState(socketState, id);
  }
}
