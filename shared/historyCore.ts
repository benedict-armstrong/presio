// presio.history's data model, as the client (lib/plugins/history.ts) and the
// server (server/history.ts) both hold it. Whoever orders edits (the server
// while a deck is shared, the presenter's page for a local deck) chains each
// entry's hash onto the one before it, and devices compare heads to catch up,
// so the hash's preimage must be computed identically everywhere: a one-sided
// change would silently fork every history.

import { MAX_PLUGIN_MESSAGE_BYTES } from "./pluginProtocol.js";

export interface HistoryEntry {
  seq: number;
  /** The committing device's id for the op: resends are recognised by it. */
  id: string;
  /** The device that committed it (per-device undo). */
  by: string;
  /** Server time it was ordered at (ms). */
  at: number;
  op: unknown;
  hash: string;
}

export interface HistoryBase {
  seq: number;
  hash: string;
  /** SHA-256 of the snapshot blob the log starts from, or null for none. */
  snapshot: string | null;
}

/** Where a copy of a history ends. */
export interface HistoryHead {
  seq: number;
  hash: string;
}

/** What a device with a given head is missing. */
export type SyncReply =
  | { kind: "empty" }
  | { kind: "current" }
  | { kind: "tail"; entries: HistoryEntry[] }
  | { kind: "reset"; base: HistoryBase; entries: HistoryEntry[] };

/** One op, as UTF-8 JSON: the size of a plugin message. */
export const MAX_HISTORY_OP_BYTES = MAX_PLUGIN_MESSAGE_BYTES;

export const EMPTY_HASH = "";
export const EMPTY_BASE: HistoryBase = { seq: 0, hash: EMPTY_HASH, snapshot: null };

/** The last entry's seq and hash, or the base's when there are none. */
export function headOf({ base, entries }: { base: HistoryBase; entries: HistoryEntry[] }): HistoryHead {
  const last = entries[entries.length - 1];
  return last ? { seq: last.seq, hash: last.hash } : { seq: base.seq, hash: base.hash };
}

/** What a device at `head` is missing from this (non-empty) log. */
export function syncReply(log: { base: HistoryBase; entries: HistoryEntry[] }, head: HistoryHead): SyncReply {
  const { base, entries } = log;
  const top = headOf(log);
  if (head.seq === top.seq && head.hash === top.hash) return { kind: "current" };
  // On this line of history, and not from before the base: just the rest.
  const known =
    (head.seq === base.seq && head.hash === base.hash) || entries.some((e) => e.seq === head.seq && e.hash === head.hash);
  if (known) return { kind: "tail", entries: entries.filter((e) => e.seq > head.seq) };
  return { kind: "reset", base, entries };
}

/** What an entry's hash is the SHA-256 of (UTF-8): chained onto the one before it. */
export function entryPreimage(prev: string, id: string, op: unknown): string {
  return `${prev}\n${id}\n${JSON.stringify(op)}`;
}
