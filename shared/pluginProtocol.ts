// The plugin wire protocol's limits, shapes and helpers, as both the client
// (lib/plugins/) and the server (validation.ts, socket.ts) apply them.
//
// The server never runs plugin code or looks inside plugin messages: it relays
// them between the presenter and the audience, keeps the presenter's
// "retained" messages for late joiners, and tells viewers which plugins the
// presenter published. The client enforces the same caps before sending, so a
// message the server would drop never reaches the presenter's own frames
// either.

/** A plugin's id (its manifest's "id"). */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A plugin message's type, and a presio.storage key. */
export const PLUGIN_TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A SHA-256, hex (a plugin page's hash, a blob's address). */
export const SHA256_RE = /^[0-9a-f]{64}$/;

/** One plugin message's payload, one history op, or one plugin's settings,
 *  as UTF-8 JSON. */
export const MAX_PLUGIN_MESSAGE_BYTES = 16 * 1024;
/** What one plugin may keep in presio.storage for one session, as UTF-8 JSON. */
export const MAX_PLUGIN_STORAGE_BYTES = 16 * 1024;
/** Plugins one session may run (publish, retain for, keep histories for). */
export const MAX_PLUGINS_PER_SESSION = 8;
// Retained messages are a plugin's state for late joiners, one message per
// piece of it (a timer's state, the media showing). So a plugin may keep many,
// and the byte budget is what bounds memory: 2 MB per plugin, 16 MB for a
// session with every plugin slot full.
export const MAX_RETAINED_PER_PLUGIN = 1024;
export const MAX_RETAINED_BYTES_PER_PLUGIN = 2 * 1024 * 1024;

/** true: kept for the session; "deck": kept until the deck is replaced. */
export type Retain = boolean | "deck";

/** The manifest fields viewers need to label and mount a published plugin. */
export interface PublishedPluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  surfaces: string[];
  permissions: string[];
}

/** A plugin the presenter runs on viewers: where they load it from, and the
 *  hash of its HTML, which viewers check what they load against. The server
 *  never carries the plugin itself. */
export interface PublishedPlugin {
  manifest: PublishedPluginManifest;
  /** As the presenter registered it: built-ins by path, so each viewer loads
   *  them from its own origin; others by absolute URL. */
  url: string;
  hash: string;
}

/** A retained message, as a joining device receives it. */
export interface RetainedMessage {
  plugin: string;
  type: string;
  payload: unknown;
  retain: Retain;
}

/** A retained message's identity: its plugin and type (a later one replaces it). */
export const retainKey = ({ plugin, type }: { plugin: string; type: string }) => `${plugin}\u0000${type}`;

const encoder = new TextEncoder();

/** A value's size as UTF-8 JSON, or Infinity when it can't be serialized.
 *  Every cap above is measured this way, on both sides. */
export function jsonBytes(value: unknown): number {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return Infinity;
  }
  return json === undefined ? 0 : encoder.encode(json).length;
}

/**
 * Whether a retained message of `size` bytes may be kept under `key`, given
 * what's retained already: its plugin's count and byte budget (a message it
 * replaces doesn't count), and the session's plugin cap.
 */
export function fitsRetainedBudget(
  retained: Iterable<[key: string, entry: { plugin: string; size: number }]>,
  candidate: { key: string; plugin: string; size: number }
): boolean {
  const plugins = new Set<string>();
  let count = 0;
  let bytes = 0;
  for (const [key, entry] of retained) {
    plugins.add(entry.plugin);
    if (entry.plugin !== candidate.plugin || key === candidate.key) continue;
    count++;
    bytes += entry.size;
  }
  if (!plugins.has(candidate.plugin) && plugins.size >= MAX_PLUGINS_PER_SESSION) return false;
  return count < MAX_RETAINED_PER_PLUGIN && bytes + candidate.size <= MAX_RETAINED_BYTES_PER_PLUGIN;
}
