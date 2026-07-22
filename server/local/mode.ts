// Whether the server runs against a local SQLite + filesystem backend instead
// of Supabase (see server/local/localClient.ts). Set by the single-container
// local.docker-compose.yml at the repo root.
export const isLocalMode = process.env.PRESIO_MODE === "local";
