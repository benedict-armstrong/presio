// Largest PDF the server accepts on an upload (sync, claim, re-upload).
// Mirrors MAX_PDF_BYTES in server/validation.ts: the two are built and shipped
// separately, so change both together.
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

export const MAX_PDF_MB = MAX_PDF_BYTES / 1024 / 1024;
