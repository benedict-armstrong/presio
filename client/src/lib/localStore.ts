// IndexedDB store for PDFs that are kept local to the browser and never
// uploaded to the server. Shared across same-origin tabs/windows.

const DB_NAME = "presio";
const DB_VERSION = 2;
const STORE = "presentations";

export interface LocalPresentation {
  id: string;
  filename: string;
  totalSlides: number;
  blob: Blob;
  /** SHA-256 hex of the stored PDF's bytes, when known. Optional: records
   * created before v2 have no hash. */
  sha256?: string;
  /** File System Access handle to the deck's file on disk (Chromium only),
   * so the deck can be watched for recompiles. Handles are structured-
   * cloneable, so they live on the record directly — no schema change. */
  handle?: FileSystemFileHandle;
  createdAt: number;
}

// `handle` is omitted alongside the blob: idbList builds its rows field by
// field and never copies one, so advertising it would be a type-level lie.
export type LocalPresentationMeta = Omit<LocalPresentation, "blob" | "handle">;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    // A presentation runs as two windows in this browser (controller + viewer),
    // so on the deploy that raises DB_VERSION one of them will still hold a
    // connection at the old version and block the upgrade. Without these two
    // handlers `open` neither succeeds nor errors and every caller hangs
    // forever: `onblocked` turns the deadlock into a message the UI can show,
    // and `onversionchange` makes *this* connection step aside when some other
    // window is the one upgrading.
    req.onblocked = () =>
      reject(
        new Error(
          "Presio was updated. Please close this presentation's other windows/tabs and reload."
        )
      );
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null; // force a reopen (at the new version) on next use
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  // Never cache a failed open: whatever blocked it (another window still on
  // the old version) normally clears, and the next call should try again.
  attempt.catch(() => {
    if (dbPromise === attempt) dbPromise = null;
  });
  dbPromise = attempt;
  return attempt;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const req = run(transaction.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export function idbPut(rec: LocalPresentation): Promise<void> {
  return tx("readwrite", (store) => store.put(rec)).then(() => undefined);
}

export function idbGet(id: string): Promise<LocalPresentation | null> {
  return tx<LocalPresentation | undefined>("readonly", (store) => store.get(id)).then(
    (r) => r ?? null
  );
}

export function idbDelete(id: string): Promise<void> {
  return tx("readwrite", (store) => store.delete(id)).then(() => undefined);
}

export function idbList(): Promise<LocalPresentationMeta[]> {
  return tx<LocalPresentation[]>("readonly", (store) => store.getAll()).then((recs) =>
    recs
      .map((r) => ({
        id: r.id,
        filename: r.filename,
        totalSlides: r.totalSlides,
        sha256: r.sha256,
        createdAt: r.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

export async function idbPruneOlderThan(ms: number): Promise<void> {
  const cutoff = Date.now() - ms;
  const all = await tx<LocalPresentation[]>("readonly", (store) => store.getAll());
  await Promise.all(all.filter((r) => r.createdAt < cutoff).map((r) => idbDelete(r.id)));
}
