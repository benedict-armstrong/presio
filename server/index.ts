import "./instrument.js"; // must come first — initializes Sentry before other imports
import "dotenv/config";
import http from "http";
import { Server } from "socket.io";
import { supabase } from "./supabase.js";
import { createApp } from "./app.js";
import { getAllowedOrigins } from "./security.js";
import { registerSocketHandlers, createSocketState } from "./socket.js";

const allowedOrigins = getAllowedOrigins();
const io = new Server({ cors: { origin: allowedOrigins.length ? allowedOrigins : false } });

const app = createApp({ supabase, io });
const server = http.createServer(app);
io.attach(server);

registerSocketHandlers(io, supabase, createSocketState());

// --- Cleanup expired sessions (every hour) ---

async function cleanupExpired() {
  const { data: expired } = await supabase
    .from("sessions")
    .select("id, pdf_path")
    .lt("expires_at", new Date().toISOString());

  if (!expired?.length) return;

  const paths = expired.map((s) => s.pdf_path).filter(Boolean);
  if (paths.length) await supabase.storage.from("presentations").remove(paths);

  const ids = expired.map((s) => s.id);
  await supabase.from("sessions").delete().in("id", ids);

  console.log(`Cleaned up ${expired.length} expired session(s)`);
}

// Run once at startup (the interval otherwise waits a full hour first), then
// hourly. Guard so a transient failure doesn't crash boot.
cleanupExpired().catch((err) => console.error("Initial cleanup failed:", err));
setInterval(cleanupExpired, 60 * 60 * 1000);

// --- Start ---

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
