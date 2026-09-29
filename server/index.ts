import "./instrument.js"; // must come first — initializes Sentry before other imports
import "dotenv/config";
import http from "http";
import { Server } from "socket.io";
import { supabase } from "./supabase.js";
import { createApp } from "./app.js";
import { getAllowedOrigins } from "./security.js";
import { isDevOrLocal } from "./local/mode.js";
import { registerSocketHandlers, createSocketState } from "./socket.js";
import { historyBucket } from "./history.js";
import { endSessions } from "./lib/sessionLifecycle.js";

const allowedOrigins = getAllowedOrigins();
const io = new Server({
  cors: { origin: allowedOrigins.length ? allowedOrigins : isDevOrLocal() },
});

const socketState = createSocketState(historyBucket(supabase));
const app = createApp({ supabase, io, socketState });
const server = http.createServer(app);
io.attach(server);

registerSocketHandlers(io, supabase, socketState);

// --- Cleanup expired sessions (every hour) ---

async function cleanupExpired() {
  // Only pick up sessions that are still active but past their expiry; rows
  // already marked 'expired' have been handled, so skip them.
  const { data: expired } = await supabase
    .from("sessions")
    .select("id, pdf_path")
    .neq("status", "expired")
    .lt("expires_at", new Date().toISOString());

  if (!expired?.length) return;

  await endSessions(supabase, io, socketState, expired);
  console.log(`Expired ${expired.length} session(s)`);
}

// Run once at startup (the interval otherwise waits a full hour first), then
// hourly. Guard so a transient failure doesn't crash boot.
cleanupExpired().catch((err) => console.error("Initial cleanup failed:", err));
setInterval(() => {
  cleanupExpired().catch((err) => console.error("Cleanup failed:", err));
}, 60 * 60 * 1000);

// --- Start ---

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
