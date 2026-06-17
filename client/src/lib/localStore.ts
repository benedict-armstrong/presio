// IndexedDB store for PDFs that are kept local to the browser and never
// uploaded to the server. Shared across same-origin tabs/windows.

const DB_NAME = "presio";
const DB_VERSION = 1;
const STORE = "presentations";

export interface LocalPresentation {
  id: string;
  filename: string;
  totalSlides: number;
  blob: Blob;
  createdAt: number;
}

export type LocalPresentationMeta = Omit<LocalPresentation, "blob">;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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
      .map((r) => ({ id: r.id, filename: r.filename, totalSlides: r.totalSlides, createdAt: r.createdAt }))
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

export async function idbPruneOlderThan(ms: number): Promise<void> {
  const cutoff = Date.now() - ms;
  const all = await tx<LocalPresentation[]>("readonly", (store) => store.getAll());
  await Promise.all(all.filter((r) => r.createdAt < cutoff).map((r) => idbDelete(r.id)));
}
