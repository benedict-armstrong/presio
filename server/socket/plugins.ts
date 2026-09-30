// Plugins over the socket: what the presenter publishes for viewers to run,
// its settings for them, and the messages between a plugin's instances.
//
// The server never runs plugin code or looks inside plugin messages: it relays
// them between the presenter and the audience and keeps the presenter's
// "retained" ones for late joiners (shared/pluginProtocol.ts has the caps).

import {
  fitsRetainedBudget,
  jsonBytes,
  MAX_PLUGINS_PER_SESSION,
  retainKey,
  type PublishedPlugin,
} from "../../shared/pluginProtocol.js";
import {
  asRecord,
  sanitizePluginEvent,
  sanitizePluginLoadFailure,
  sanitizePluginSettings,
  sanitizePublishedPlugin,
} from "../validation.js";
import { allowAudiencePluginEvent, controllerOnly } from "./guards.js";
import type { RetainedPluginEvent, SocketState } from "./state.js";
import type { PresioServer, PresioSocket } from "./types.js";

/**
 * What a joining (or re-joining) socket needs to mount the session's plugins:
 * which ones run and where each loads from (by URL and hash; the viewer
 * fetches them itself), the presenter's settings for each, and the retained
 * messages.
 */
export const pluginsState = (state: SocketState, sessionId: string) => ({
  plugins: [...(state.publishedPlugins.get(sessionId)?.values() ?? [])],
  settings: Object.fromEntries(state.pluginSettings.get(sessionId) ?? []),
  retained: [...(state.pluginRetained.get(sessionId)?.values() ?? [])].map(({ plugin, type, payload, retain }) => ({
    plugin,
    type,
    payload,
    retain,
  })),
});

/**
 * Keep (or, for a null payload, forget) a presenter's retained message, within
 * its plugin's budget. Over budget it's still relayed live, just not kept for
 * late joiners.
 */
function retain(state: SocketState, sessionId: string, event: RetainedPluginEvent) {
  const retained = state.pluginRetained.get(sessionId) ?? new Map<string, RetainedPluginEvent>();
  const key = retainKey(event);
  if (event.payload === null) {
    retained.delete(key);
    return;
  }
  if (!fitsRetainedBudget(retained, { key, plugin: event.plugin, size: event.size })) return;
  retained.set(key, event);
  state.pluginRetained.set(sessionId, retained);
}

export function registerPluginHandlers(io: PresioServer, socket: PresioSocket, state: SocketState) {
  const { controllers, publishedPlugins, pluginSettings } = state;

  // The controller publishes the plugins that have to run on viewers —
  // where each loads from and its hash, never the plugin itself (viewers
  // fetch that directly) — replacing whatever it published before.
  socket.on("plugins_publish", controllerOnly(state, socket, (sessionId, payload: unknown) => {
    const { plugins } = asRecord(payload);
    if (!Array.isArray(plugins)) return;
    const next = new Map<string, PublishedPlugin>();
    for (const raw of plugins.slice(0, MAX_PLUGINS_PER_SESSION)) {
      const plugin = sanitizePublishedPlugin(raw);
      if (plugin) next.set(plugin.manifest.id, plugin);
    }
    publishedPlugins.set(sessionId, next);
    io.to(sessionId).emit("plugins_state", pluginsState(state, sessionId));
  }));

  // The presenter changed a plugin's settings: keep them for joiners and
  // pass them on to the plugin's viewer instances.
  socket.on("plugin_settings", controllerOnly(state, socket, (sessionId, raw: unknown) => {
    const update = sanitizePluginSettings(raw);
    if (!update) return;
    const bySession = pluginSettings.get(sessionId) ?? new Map<string, Record<string, unknown>>();
    if (!bySession.has(update.plugin) && bySession.size >= MAX_PLUGINS_PER_SESSION) return;
    bySession.set(update.plugin, update.settings);
    pluginSettings.set(sessionId, bySession);
    socket.to(sessionId).emit("plugin_settings", update);
  }));

  // Plugin messages. The presenter's go to everyone else in the room (and
  // are kept for late joiners when retained); the audience's go to the
  // presenter only, so one phone can't broadcast to the whole room.
  socket.on("plugin_event", (raw: unknown) => {
    const { sessionId } = socket.data;
    if (!sessionId) return;
    const event = sanitizePluginEvent(raw);
    if (!event) return;
    const { plugin, type, payload } = event;

    if (controllers.get(sessionId) === socket.id) {
      if (event.retain) retain(state, sessionId, { plugin, type, payload, retain: event.retain, size: jsonBytes(payload) });
      // Volatile ones (a laser position) may be dropped for a viewer whose
      // connection is backed up, rather than queued behind newer ones.
      const room = event.volatile ? socket.to(sessionId).volatile : socket.to(sessionId);
      room.emit("plugin_event", { plugin, type, payload, from: "presenter" });
      return;
    }

    // Audience: only to a plugin the presenter actually published.
    if (!publishedPlugins.get(sessionId)?.has(plugin)) return;
    if (!allowAudiencePluginEvent(socket)) return;
    const controller = controllers.get(sessionId);
    if (!controller) return;
    io.to(controller).emit("plugin_event", { plugin, type, payload, from: "audience", sender: socket.id });
  });

  // A viewer couldn't load one of the published plugins (a presenter's
  // localhost dev server, a version that changed under its URL): tell the
  // presenter, who otherwise can't see it. Throttled like the audience's
  // plugin messages, and only for the version actually published.
  socket.on("plugin_load_failed", (raw: unknown) => {
    const { sessionId } = socket.data;
    if (!sessionId || controllers.get(sessionId) === socket.id) return;
    const failure = sanitizePluginLoadFailure(raw);
    if (!failure) return;
    if (publishedPlugins.get(sessionId)?.get(failure.plugin)?.hash !== failure.hash) return;
    if (!allowAudiencePluginEvent(socket)) return;
    const controller = controllers.get(sessionId);
    if (controller) io.to(controller).emit("plugin_load_failed", { ...failure, sender: socket.id });
  });
}
