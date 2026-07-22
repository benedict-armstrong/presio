import path from "path";

// Everything local mode writes (the SQLite file and uploaded PDFs) lives under
// one directory, so a single volume mount persists all of it.
function dataDir(): string {
  return process.env.LOCAL_DATA_DIR || path.join(process.cwd(), "data");
}

export function localDbPath(): string {
  return path.join(dataDir(), "presio.db");
}

// Root that blobStore.ts writes into and app.ts serves at /files.
export function localBlobsDir(): string {
  return path.join(dataDir(), "blobs");
}
