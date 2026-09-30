// Size limits the client and the server both enforce.

/** Largest PDF the server accepts on an upload (sync, claim, re-upload). The
 *  client disables Sync above it rather than attempt an upload that would fail.
 *  The reverse proxies' body limits (docker-compose files) must allow it too. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

export const MAX_PDF_MB = MAX_PDF_BYTES / 1024 / 1024;

/** Upper bound on a deck's declared page count. */
export const MAX_TOTAL_SLIDES = 3000;

/** One blob a plugin keeps (presio.history snapshots, images). */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024;

/** All the blobs one session keeps. */
export const MAX_SESSION_BLOB_BYTES = 50 * 1024 * 1024;
