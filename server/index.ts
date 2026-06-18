import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { nanoid, customAlphabet } from "nanoid";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { supabase } from "./supabase.js";

// Allowed browser origins for cross-origin requests. The client and server are
// served from the same origin in production, so same-origin requests (which
// carry no Origin header, or one matching the host) always work. Set
// ALLOWED_ORIGIN (comma-separated) only when the client is hosted separately.
const allowedOrigins = (process.env.ALLOWED_ORIGIN ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const corsOrigin: cors.CorsOptions["origin"] = (origin, callback) => {
  // No Origin header => same-origin / non-browser client (curl, server-to-server).
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  callback(new Error("Not allowed by CORS"));
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: allowedOrigins.length ? allowedOrigins : false } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Helmet for sensible security headers. The CSP allows the YouTube/Vimeo embed
// SDKs and their iframes, the Supabase API/storage, and websocket connections.
const supabaseHost = (() => {
  try {
    return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : "";
  } catch {
    return "";
  }
})();
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "default-src": ["'self'"],
        "script-src": ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com"],
        "frame-src": ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com"],
        "img-src": ["'self'", "data:", "blob:", "https:"],
        "media-src": ["'self'", "blob:", "https:"],
        // `https:` lets the client fetch externally-hosted PDFs ("bring your own
        // storage") from any HTTPS origin via pdf.js. img-src/media-src already
        // allow https:, so this keeps connect-src consistent with them.
        "connect-src": ["'self'", "blob:", "data:", "ws:", "wss:", "https:", "https://vimeo.com", ...(supabaseHost ? [supabaseHost] : [])],
        "worker-src": ["'self'", "blob:"],
        "upgrade-insecure-requests": null,
      },
    },
    crossOriginEmbedderPolicy: false,
    // YouTube (esp. the JS API / nocookie player) validates the embedding
    // origin via the Referer header. Helmet's default `no-referrer` strips it,
    // which triggers YouTube playback error 153. Send the origin cross-site.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  })
);
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// Throttle the JSON API to blunt brute-force (passphrase auth) and abuse.
// Generous enough not to interfere with normal presenter/viewer flows.
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
app.use("/api", apiLimiter);

const generateSessionId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const generatePassphrase = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);

// How many synced presentations a single user may have live at once. Sessions
// expire after 24h (and are deleted on end), so this caps concurrent — not
// lifetime — presentations.
const MAX_CONCURRENT_PRESENTATIONS = 3;

// Validate a user-supplied external PDF URL. We only ever hand this back to the
// client to fetch (the server never requests it), so the bar is simply that it
// be a well-formed https URL — rejecting http:/data:/javascript: and garbage.
function isValidHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Resolve the owner from an optional bearer token. Anonymous callers are fine —
// an absent or invalid token simply yields null.
async function resolveOptionalUserId(req: express.Request): Promise<string | null> {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return null;
  const { data } = await supabase.auth.getUser(token);
  return data.user?.id ?? null;
}

// Track which socket is the controller for each session
const controllers = new Map<string, string>();
// Track blanked state per session (transient, no DB persistence)
const blankedSessions = new Set<string>();

// --- REST API ---

// Reserve a session code for a presentation kept local to the browser. No PDF
// is uploaded — the bytes stay in the client's IndexedDB. We only record the
// code so it is unique/trackable (and claimable once the user logs in).
app.post("/api/sessions/local", async (req, res) => {
  const filename = typeof req.body.filename === "string" ? req.body.filename : "";
  const totalSlides = parseInt(req.body.total_slides, 10);
  if (!filename || !Number.isFinite(totalSlides) || totalSlides < 1) {
    res.status(400).json({ error: "filename and total_slides are required" });
    return;
  }

  // If the creator is logged in, attach them as the owner up front so the
  // presentation is theirs even while it stays local. Anonymous creators are
  // still allowed — the token is optional, and an invalid one is simply ignored.
  const userId = await resolveOptionalUserId(req);

  const id = generateSessionId();
  const { error } = await supabase.from("sessions").insert({
    id,
    pdf_path: "",
    filename,
    total_slides: totalSlides,
    controller_token: nanoid(24),
    passphrase: generatePassphrase(),
    local: true,
    user_id: userId,
  });

  if (error) {
    console.error("Failed to create local session:", error);
    res.status(500).json({ error: "Failed to create session" });
    return;
  }

  res.json({ id });
});

// Reserve a session whose PDF is hosted externally ("bring your own storage").
// The client has already loaded the PDF from `url` to derive total_slides, so we
// store only the URL — no bytes are uploaded and there is no storage cost, which
// is why this needs neither login nor the synced-presentation cap. Viewers fetch
// the PDF directly from the URL, so it must be a public, CORS-friendly host.
app.post("/api/sessions/external", async (req, res) => {
  const url = req.body.url;
  const filename = typeof req.body.filename === "string" ? req.body.filename : "";
  const totalSlides = parseInt(req.body.total_slides, 10);
  if (!isValidHttpsUrl(url)) {
    res.status(400).json({ error: "A valid https PDF URL is required" });
    return;
  }
  if (!filename || !Number.isFinite(totalSlides) || totalSlides < 1) {
    res.status(400).json({ error: "filename and total_slides are required" });
    return;
  }

  const userId = await resolveOptionalUserId(req);

  const id = generateSessionId();
  const controllerToken = nanoid(24);
  const passphrase = generatePassphrase();
  const { error } = await supabase.from("sessions").insert({
    id,
    pdf_path: "",
    pdf_url: url,
    filename,
    total_slides: totalSlides,
    controller_token: controllerToken,
    passphrase,
    local: false,
    user_id: userId,
  });

  if (error) {
    console.error("Failed to create external session:", error);
    res.status(500).json({ error: "Failed to create session" });
    return;
  }

  res.json({ id, controllerToken, passphrase });
});

// Convert an existing local session into an external one in place (same code):
// the client supplies the URL it now hosts the PDF at. Protected, like the local
// session itself, only by knowledge of the random session code.
app.post("/api/sessions/:id/share-url", async (req, res) => {
  const url = req.body.url;
  const totalSlides = parseInt(req.body.total_slides, 10);
  if (!isValidHttpsUrl(url)) {
    res.status(400).json({ error: "A valid https PDF URL is required" });
    return;
  }

  const { data: row, error: rowError } = await supabase
    .from("sessions")
    .select("id, local, controller_token, passphrase")
    .eq("id", req.params.id)
    .single();
  if (rowError || !row) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (!row.local) {
    res.status(409).json({ error: "Presentation is already shared" });
    return;
  }

  const update: Record<string, unknown> = { local: false, pdf_url: url };
  if (Number.isFinite(totalSlides) && totalSlides >= 1) update.total_slides = totalSlides;

  const { error: updateError } = await supabase
    .from("sessions")
    .update(update)
    .eq("id", row.id);
  if (updateError) {
    res.status(500).json({ error: "Failed to update session" });
    return;
  }

  res.json({ id: row.id, controllerToken: row.controller_token, passphrase: row.passphrase });
});

// Turn a local session into a synced one: upload the PDF (kept in the client's
// IndexedDB until now) and attach the authenticated owner. Requires a valid
// Supabase access token.
app.post("/api/sessions/:id/claim", upload.single("pdf"), async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    // Cap how many synced presentations a user can have live at once. Only count
    // non-expired ones; expired sessions are pending cleanup and don't count.
    // Exclude the session being claimed so a re-claim of the same code is a no-op.
    const { count, error: countError } = await supabase
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userData.user.id)
      .eq("local", false)
      .neq("id", req.params.id)
      .gt("expires_at", new Date().toISOString());
    if (countError) {
      res.status(500).json({ error: "Failed to check presentation limit" });
      return;
    }
    if ((count ?? 0) >= MAX_CONCURRENT_PRESENTATIONS) {
      res.status(403).json({
        error: `You can have at most ${MAX_CONCURRENT_PRESENTATIONS} synced presentations at once. End one before syncing another.`,
      });
      return;
    }

    const file = req.file;
    if (!file || file.mimetype !== "application/pdf") {
      res.status(400).json({ error: "A PDF file is required" });
      return;
    }

    const { data: row, error: rowError } = await supabase
      .from("sessions")
      .select("id, local, controller_token, passphrase")
      .eq("id", req.params.id)
      .single();
    if (rowError || !row) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!row.local) {
      res.status(409).json({ error: "Presentation is already synced" });
      return;
    }

    const pdfPath = `${row.id}.pdf`;
    const doc = await getDocument({ data: new Uint8Array(file.buffer) }).promise;
    const totalSlides = doc.numPages;
    doc.destroy();

    const { error: uploadError } = await supabase.storage
      .from("presentations")
      .upload(pdfPath, file.buffer, { contentType: "application/pdf", upsert: true });
    if (uploadError) {
      res.status(500).json({ error: "Failed to upload PDF" });
      return;
    }

    // Preserve the presenter's current position if provided (a local session's
    // slide changes were never persisted server-side).
    const currentSlide = parseInt(req.body.current_slide, 10);
    const update: Record<string, unknown> = {
      local: false,
      pdf_path: pdfPath,
      total_slides: totalSlides,
      user_id: userData.user.id,
    };
    if (Number.isFinite(currentSlide) && currentSlide >= 1) update.current_slide = currentSlide;

    const { error: updateError } = await supabase
      .from("sessions")
      .update(update)
      .eq("id", row.id);
    if (updateError) {
      res.status(500).json({ error: "Failed to update session" });
      return;
    }

    res.json({
      id: row.id,
      totalSlides,
      controllerToken: row.controller_token,
      passphrase: row.passphrase,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/sessions/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, pdf_path, pdf_url, filename, total_slides, current_slide, timer_mode, timer_duration, timer_threshold, note_prefix, local")
    .eq("id", req.params.id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // External sessions store the URL directly; Supabase-hosted ones derive a
  // public URL from the object path; local sessions have neither.
  const pdfUrl = data.pdf_url
    ? data.pdf_url
    : data.pdf_path
      ? supabase.storage.from("presentations").getPublicUrl(data.pdf_path).data.publicUrl
      : "";

  // Return only fields the client needs; never leak controller_token,
  // passphrase, owner user_id, or internal timestamps.
  res.json({
    id: data.id,
    filename: data.filename,
    total_slides: data.total_slides,
    current_slide: data.current_slide,
    timer_mode: data.timer_mode,
    timer_duration: data.timer_duration,
    timer_threshold: data.timer_threshold,
    note_prefix: data.note_prefix,
    local: data.local,
    pdfUrl,
  });
});

app.post("/api/sessions/:id/auth", async (req, res) => {
  const { passphrase } = req.body;
  if (!passphrase) {
    res.status(400).json({ error: "Passphrase is required" });
    return;
  }

  const { data, error } = await supabase
    .from("sessions")
    .select("controller_token, passphrase")
    .eq("id", req.params.id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  if (data.passphrase !== passphrase) {
    res.status(401).json({ error: "Invalid passphrase" });
    return;
  }

  res.json({ controllerToken: data.controller_token, passphrase: data.passphrase });
});

app.delete("/api/sessions/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, pdf_path, controller_token")
    .eq("id", req.params.id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Only the controller (who holds the token) may end a presentation.
  const token = req.get("x-controller-token") || "";
  if (token !== data.controller_token) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }

  if (data.pdf_path) {
    await supabase.storage.from("presentations").remove([data.pdf_path]);
  }
  await supabase.from("sessions").delete().eq("id", data.id);

  // Disconnect all sockets in this session's room
  const sockets = await io.in(data.id).fetchSockets();
  for (const s of sockets) {
    s.emit("session_ended");
    s.disconnect(true);
  }

  res.json({ ok: true });
});

// --- Serve client in production ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, "../client/dist");

app.use(express.static(clientDist));
app.get("*path", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// --- WebSocket ---

io.on("connection", (socket) => {
  socket.on("join_session", async ({ sessionId, role, token }: { sessionId: string; role: string; token?: string }) => {
    const { data } = await supabase
      .from("sessions")
      .select("current_slide, total_slides, controller_token, timer_mode, timer_duration, timer_threshold, note_prefix")
      .eq("id", sessionId)
      .single();

    if (!data) {
      socket.emit("error", { message: "Session not found" });
      return;
    }

    let grantedRole = role;
    if (role === "controller") {
      if (token !== data.controller_token) {
        grantedRole = "viewer";
      } else {
        controllers.set(sessionId, socket.id);
      }
    }

    socket.join(sessionId);
    socket.data.sessionId = sessionId;
    socket.data.role = grantedRole;
    socket.data.totalSlides = data.total_slides;

    socket.emit("session_state", {
      currentSlide: data.current_slide,
      totalSlides: data.total_slides,
      role: grantedRole,
      settings: {
        timerMode: data.timer_mode,
        timerDuration: data.timer_duration,
        timerThreshold: data.timer_threshold,
        notePrefix: data.note_prefix,
      },
    });
  });

  socket.on("slide_change", async ({ slideNumber }: { slideNumber: number }) => {
    const { sessionId } = socket.data;
    if (!sessionId) return;

    if (controllers.get(sessionId) !== socket.id) return;

    // Reject non-finite/out-of-range values rather than persisting garbage.
    if (!Number.isInteger(slideNumber) || slideNumber < 1) return;
    const total = socket.data.totalSlides;
    if (typeof total === "number" && slideNumber > total) return;

    await supabase
      .from("sessions")
      .update({ current_slide: slideNumber })
      .eq("id", sessionId);

    io.to(sessionId).emit("slide_update", { slideNumber });
  });

  socket.on("sync_all", () => {
    const { sessionId } = socket.data;
    if (!sessionId) return;
    if (controllers.get(sessionId) !== socket.id) return;
    io.to(sessionId).emit("sync_all");
  });

  socket.on("settings_change", async (settings: { timerMode?: string | null; timerDuration?: number | null; timerThreshold?: number | null; notePrefix?: string }) => {
    const { sessionId } = socket.data;
    if (!sessionId) return;
    if (controllers.get(sessionId) !== socket.id) return;

    // Coerce to known-good values so a malformed payload can't corrupt the row.
    const timerMode =
      settings.timerMode === "up" || settings.timerMode === "down" ? settings.timerMode : null;
    const sanitizeDuration = (n: number | null | undefined) =>
      typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
    const sanitized = {
      timerMode,
      timerDuration: sanitizeDuration(settings.timerDuration),
      timerThreshold: sanitizeDuration(settings.timerThreshold),
      notePrefix: typeof settings.notePrefix === "string" ? settings.notePrefix.slice(0, 100) : "note:",
    };

    await supabase
      .from("sessions")
      .update({
        timer_mode: sanitized.timerMode,
        timer_duration: sanitized.timerDuration,
        timer_threshold: sanitized.timerThreshold,
        note_prefix: sanitized.notePrefix,
      })
      .eq("id", sessionId);

    io.to(sessionId).emit("settings_update", sanitized);
  });

  socket.on("blank_toggle", () => {
    const { sessionId } = socket.data;
    if (!sessionId) return;
    if (controllers.get(sessionId) !== socket.id) return;

    if (blankedSessions.has(sessionId)) {
      blankedSessions.delete(sessionId);
    } else {
      blankedSessions.add(sessionId);
    }
    io.to(sessionId).emit("blank_update", { blanked: blankedSessions.has(sessionId) });
  });

  socket.on("media_control", (payload: { id: string; action: "play" | "pause" | "reset" }) => {
    const { sessionId } = socket.data;
    if (!sessionId) return;
    if (controllers.get(sessionId) !== socket.id) return;
    io.to(sessionId).emit("media_update", { ...payload, seq: Date.now() });
  });

  socket.on("audio_change", (payload: { muted: boolean; target: "controller" | "both" | "viewers" }) => {
    const { sessionId } = socket.data;
    if (!sessionId) return;
    if (controllers.get(sessionId) !== socket.id) return;
    io.to(sessionId).emit("audio_update", { ...payload, seq: Date.now() });
  });

  socket.on("media_time", (payload: { id: string; t: number; playing: boolean; sampledAt: number }) => {
    const { sessionId } = socket.data;
    if (!sessionId) return;
    if (controllers.get(sessionId) !== socket.id) return;
    socket.to(sessionId).emit("media_time_update", { ...payload, seq: Date.now() });
  });

  socket.on("time_ping", (clientT1: number, ack?: (data: { serverTime: number; clientT1: number }) => void) => {
    if (typeof ack === "function") ack({ serverTime: Date.now(), clientT1 });
  });

  socket.on("disconnect", () => {
    const { sessionId } = socket.data;
    if (sessionId && controllers.get(sessionId) === socket.id) {
      controllers.delete(sessionId);
    }
  });
});

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
