// The presenter's copy of plugin histories (presio.history), in IndexedDB:
// the copy that lasts. The server only holds one while a deck is shared.
//
// Its own database rather than a store in "presio" (lib/localStore.ts): adding
// a store there means a version bump, and a version bump blocks while the
// deck's other window still has the old version open.

import type { HistoryLog } from "./history";

const DB_NAME = "presio-history";
const DB_VERSION = 1;
const LOGS = "logs";
const BLOBS = "blobs";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOGS)) db.createObjectStore(LOGS);
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    req.onblocked = () => reject(new Error("Presio was updated. Please close this presentation's other windows/tabs and reload."));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  attempt.catch(() => {
    if (dbPromise === attempt) dbPromise = null;
  });
  dbPromise = attempt;
  return attempt;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

/** A log's key: the deck (its presentation id) and the plugin. */
const logKey = (deck: string, plugin: string) => `${deck}\u0000${plugin}`;
/** Every log of one deck. */
const deckRange = (deck: string) => IDBKeyRange.bound(`${deck}\u0000`, `${deck}\u0001`, false, true);

export async function loadLog(deck: string, plugin: string): Promise<HistoryLog | null> {
  return ((await run(LOGS, "readonly", (s) => s.get(logKey(deck, plugin)))) as HistoryLog | undefined) ?? null;
}

export function saveLog(deck: string, plugin: string, log: HistoryLog): Promise<unknown> {
  return run(LOGS, "readwrite", (s) => s.put(log, logKey(deck, plugin)));
}

export function deleteLog(deck: string, plugin: string): Promise<unknown> {
  return run(LOGS, "readwrite", (s) => s.delete(logKey(deck, plugin)));
}

export async function getBlob(sha: string): Promise<Blob | null> {
  return ((await run(BLOBS, "readonly", (s) => s.get(sha))) as Blob | undefined) ?? null;
}

export function putBlob(sha: string, blob: Blob): Promise<unknown> {
  return run(BLOBS, "readwrite", (s) => s.put(blob, sha));
}

/**
 * A deck's id changed (a local deck was shared and got a join code): its
 * histories follow it, or the presenter loses their edits the moment they
 * share. Blobs are keyed by content and stay where they are.
 */
export async function rekeyHistories(oldDeck: string, newDeck: string): Promise<void> {
  if (oldDeck === newDeck) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(LOGS, "readwrite");
    const store = tx.objectStore(LOGS);
    const req = store.openCursor(deckRange(oldDeck));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const plugin = String(cursor.key).slice(oldDeck.length + 1);
      store.put(cursor.value, logKey(newDeck, plugin));
      cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
