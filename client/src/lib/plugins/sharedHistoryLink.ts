// A shared deck's way to the server's copy of the plugins' histories
// (server/history.ts orders edits over the socket), and to their blobs, which
// travel over HTTP.

import { socket } from "@/lib/socket";
import { getSessionAuth } from "@/lib/sessionAuth";
import { blobSha, type HistoryLink, type SyncReply } from "./history";

/** How long to wait on the server's answer about a history. */
const HISTORY_ACK_MS = 15_000;
// A blob another device just added may not be uploaded yet: ask again after
// these waits before giving up (the plugin can ask again later).
const BLOB_RETRY_MS = [1000, 2000, 4000, 8000];

/** A shared deck's way to the server's copy of the histories, and its blobs. */
export function sharedHistoryLink(
  id: string,
  isPresenter: boolean,
  localBlob: (sha: string) => Promise<Blob | null>
): HistoryLink & { retryUploads(): void } {
  const ask = async <T,>(event: string, args: unknown): Promise<T> => socket.timeout(HISTORY_ACK_MS).emitWithAck(event, args);
  const blobUrl = (sha: string) => `/api/sessions/${encodeURIComponent(id)}/blobs/${sha}`;
  // Blobs that couldn't be uploaded yet (offline): tried again on reconnecting.
  const unsent = new Map<string, Blob>();

  const upload = async (sha: string, blob: Blob) => {
    const res = await fetch(blobUrl(sha), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "x-controller-token": getSessionAuth(id).controllerToken ?? "" },
      body: blob,
    });
    if (res.ok) {
      unsent.delete(sha);
      return;
    }
    const body = await res.json().catch(() => ({}));
    // Refused for good (too big, storage full): the plugin should hear.
    if (res.status === 413 || res.status === 422) throw new Error(body.error || "The server refused the blob");
    throw new TypeError(body.error || `upload failed (${res.status})`);
  };

  const tryUpload = async (sha: string, blob: Blob) => {
    try {
      await upload(sha, blob);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      unsent.set(sha, blob);
    }
  };

  return {
    sync: async (plugin, head) => {
      const reply = await ask<SyncReply | { error: string }>("history_sync", { plugin, head });
      if ("error" in reply) throw new Error(reply.error);
      return reply;
    },
    ...(isPresenter
      ? {
          commit: async (plugin, op) => {
            const reply = await ask<{ ok?: boolean; error?: string }>("history_commit", { plugin, id: op.id, by: op.by, op: op.op });
            return reply?.error ?? null;
          },
          seed: async (plugin, log) => {
            if (log.base.snapshot) {
              const snapshot = await localBlob(log.base.snapshot);
              if (!snapshot) return false;
              await upload(log.base.snapshot, snapshot);
            }
            const seed = new Blob([JSON.stringify({ base: log.base, entries: log.entries })], { type: "application/json" });
            const sha = await blobSha(seed);
            await upload(sha, seed);
            const reply = await ask<{ ok?: boolean }>("history_seed", { plugin, sha });
            return reply?.ok === true;
          },
          snapshot: async (plugin, base) => {
            if (base.snapshot && unsent.has(base.snapshot)) return false;
            const reply = await ask<{ ok?: boolean }>("history_snapshot", { plugin, base });
            return reply?.ok === true;
          },
          reset: (plugin) => void socket.emit("history_reset", { plugin }),
          uploadBlob: tryUpload,
        }
      : {}),
    fetchBlob: async (sha) => {
      for (let attempt = 0; ; attempt++) {
        try {
          // Low priority: a blob never gets ahead of the slides themselves.
          const res = await fetch(blobUrl(sha), { priority: "low" } as RequestInit);
          if (res.ok) return await res.blob();
          if (res.status !== 404) return null;
        } catch {
          /* offline: try again */
        }
        if (attempt >= BLOB_RETRY_MS.length) return null;
        await new Promise((r) => setTimeout(r, BLOB_RETRY_MS[attempt]));
      }
    },
    retryUploads: () => {
      for (const [sha, blob] of unsent) void tryUpload(sha, blob).catch(() => unsent.delete(sha));
    },
  };
}
