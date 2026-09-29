// Plugin histories (presio.history) over the socket: catching up, and the
// controller's writes. The store itself is history.ts; blobs go over HTTP
// (routes/history.ts).

import { SHA256_RE } from "../../shared/pluginProtocol.js";
import { HistoryError, parseBase, sanitizeHead, sanitizeHistoryCommit } from "../history.js";
import { asRecord, pluginMessage } from "../validation.js";
import { ackOrNoop, allowAudiencePluginEvent, controllerOnly } from "./guards.js";
import type { SocketState } from "./state.js";
import type { PresioServer, PresioSocket } from "./types.js";

export function registerHistoryHandlers(io: PresioServer, socket: PresioSocket, state: SocketState) {
  const { controllers, history } = state;

  // Anyone in the session may catch up on a history: a device sends the
  // head it has and gets what it's missing. Viewers are throttled like
  // their plugin messages; they only sync on joining or after a gap.
  socket.on("history_sync", async (raw, ack) => {
    const { sessionId } = socket.data;
    if (typeof ack !== "function") return;
    const r = pluginMessage(raw);
    const head = sanitizeHead(r?.head);
    if (!sessionId || !r || !head) return ack({ error: "Bad request" });
    if (controllers.get(sessionId) !== socket.id && !allowAudiencePluginEvent(socket)) return ack({ error: "Too many requests" });
    try {
      ack(await history.sync(sessionId, r.plugin, head));
    } catch (err) {
      console.warn("history_sync failed:", err);
      ack({ error: "Couldn't read the history" });
    }
  });

  // The controller's edits: ordered here, then sent to everyone in the
  // session, the sender included — that's how it learns the entry's place.
  socket.on("history_commit", controllerOnly(state, socket, async (sessionId, raw: unknown, ack?: unknown) => {
    const reply = ackOrNoop(ack);
    const commit = sanitizeHistoryCommit(raw);
    if (!commit) return reply({ error: "Bad commit" });
    try {
      const entry = await history.commit(sessionId, commit);
      if (entry) io.to(sessionId).emit("history_entry", { plugin: commit.plugin, entry });
      reply({ ok: true });
    } catch (err) {
      reply({ error: err instanceof HistoryError ? err.message : "Couldn't save the edit" });
      if (!(err instanceof HistoryError)) console.warn("history_commit failed:", err);
    }
  }));

  // A deck shared with edits already on it: the controller's copy becomes
  // the session's, from a seed blob it uploaded first.
  socket.on("history_seed", controllerOnly(state, socket, async (sessionId, raw: unknown, ack?: unknown) => {
    const reply = ackOrNoop(ack);
    const r = pluginMessage(raw);
    if (!r || typeof r.sha !== "string" || !SHA256_RE.test(r.sha)) return reply({ error: "Bad seed" });
    try {
      const seeded = await history.seed(sessionId, r.plugin, r.sha);
      if (seeded) socket.to(sessionId).emit("history_reset", { plugin: r.plugin });
      reply({ ok: seeded });
    } catch (err) {
      console.warn("history_seed failed:", err);
      reply({ ok: false });
    }
  }));

  // The controller took a snapshot: the log may start from it.
  socket.on("history_snapshot", controllerOnly(state, socket, async (sessionId, raw: unknown, ack?: unknown) => {
    const reply = ackOrNoop(ack);
    const r = pluginMessage(raw);
    const base = parseBase(asRecord(raw).base);
    if (!r || !base?.snapshot) return reply({ ok: false });
    try {
      reply({ ok: await history.snapshot(sessionId, r.plugin, { seq: base.seq, hash: base.hash, sha: base.snapshot }) });
    } catch (err) {
      console.warn("history_snapshot failed:", err);
      reply({ ok: false });
    }
  }));

  // A different deck: start the plugin's history afresh, everywhere.
  socket.on("history_reset", controllerOnly(state, socket, async (sessionId, raw: unknown) => {
    const r = pluginMessage(raw);
    if (!r) return;
    try {
      await history.reset(sessionId, r.plugin);
      socket.to(sessionId).emit("history_reset", { plugin: r.plugin });
    } catch (err) {
      console.warn("history_reset failed:", err);
    }
  }));
}
