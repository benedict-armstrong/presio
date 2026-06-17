import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { nanoid, customAlphabet } from "nanoid";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { supabase } from "./supabase.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

const generateSessionId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const generatePassphrase = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);

// Track which socket is the controller for each session
const controllers = new Map<string, string>();
// Track blanked state per session (transient, no DB persistence)
const blankedSessions = new Set<string>();

// --- REST API ---

app.post("/api/sessions", upload.single("pdf"), async (req, res) => {
  try {
    const file = req.file;
    if (!file || file.mimetype !== "application/pdf") {
      res.status(400).json({ error: "A PDF file is required" });
      return;
    }

    const id = generateSessionId();
    const pdfPath = `${id}.pdf`;
    const filename = file.originalname.replace(/\.pdf$/i, "");
    const controllerToken = nanoid(24);
    const passphrase = generatePassphrase();

    const timerMode = req.body.timer_mode || null;
    const timerDuration = req.body.timer_duration ? parseInt(req.body.timer_duration, 10) : null;
    const timerThreshold = req.body.timer_threshold ? parseInt(req.body.timer_threshold, 10) : null;
    const notePrefix = req.body.note_prefix || "note:";

    // Count pages
    const doc = await getDocument({ data: new Uint8Array(file.buffer) }).promise;
    const totalSlides = doc.numPages;
    doc.destroy();

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from("presentations")
      .upload(pdfPath, file.buffer, { contentType: "application/pdf", upsert: true });

    if (uploadError) {
      res.status(500).json({ error: "Failed to upload PDF" });
      return;
    }

    // Insert session row
    const { error: dbError } = await supabase.from("sessions").insert({
      id,
      pdf_path: pdfPath,
      filename,
      total_slides: totalSlides,
      controller_token: controllerToken,
      passphrase,
      timer_mode: timerMode,
      timer_duration: timerDuration,
      timer_threshold: timerThreshold,
      note_prefix: notePrefix,
    });

    if (dbError) {
      res.status(500).json({ error: "Failed to create session" });
      return;
    }

    res.json({ id, totalSlides, controllerToken, passphrase });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

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

  const id = generateSessionId();
  const { error } = await supabase.from("sessions").insert({
    id,
    pdf_path: "",
    filename,
    total_slides: totalSlides,
    controller_token: nanoid(24),
    passphrase: generatePassphrase(),
    local: true,
  });

  if (error) {
    console.error("Failed to create local session:", error);
    res.status(500).json({ error: "Failed to create session" });
    return;
  }

  res.json({ id });
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
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Local sessions have no stored PDF, so there is no public URL.
  const pdfUrl = data.pdf_path
    ? supabase.storage.from("presentations").getPublicUrl(data.pdf_path).data.publicUrl
    : "";

  const { controller_token, passphrase, ...publicData } = data;
  res.json({ ...publicData, pdfUrl });
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
    .select("id, pdf_path")
    .eq("id", req.params.id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Session not found" });
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

    await supabase
      .from("sessions")
      .update({
        timer_mode: settings.timerMode ?? null,
        timer_duration: settings.timerDuration ?? null,
        timer_threshold: settings.timerThreshold ?? null,
        note_prefix: settings.notePrefix ?? "note:",
      })
      .eq("id", sessionId);

    io.to(sessionId).emit("settings_update", settings);
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

setInterval(cleanupExpired, 60 * 60 * 1000);

// --- Start ---

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
