// Whether the server runs against a local SQLite + filesystem backend instead
// of Supabase (see server/local/localClient.ts). Set by the single-container
// local.docker-compose.yml at the repo root.
export const isLocalMode = process.env.PRESIO_MODE === "local";

// Development and local/LAN use have no fixed origin to configure ahead of
// time — the client can be reached as localhost, a LAN IP, or a hostname
// (e.g. `npm run dev` viewed from a phone/tablet on the same network), none of
// which are known at startup. CORS (HTTP and socket) accepts any origin then,
// unless ALLOWED_ORIGIN was set explicitly, and the LAN address route is on.
export const isDevOrLocal = () => process.env.NODE_ENV === "development" || isLocalMode;
