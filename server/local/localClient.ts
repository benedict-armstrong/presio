// Drop-in replacement for the Supabase client (server/supabase.ts), structurally
// compatible with the subset of SupabaseClient the routes call — see
// server/test/fakeSupabase.ts for the in-memory version of the same shape used
// by tests. Selected by PRESIO_MODE=local (server/local/mode.ts).
import { openLocalDb } from "./db.js";
import { LocalQuery, type UpsertOptions } from "./queryBuilder.js";
import { createBucket } from "./blobStore.js";

export function createLocalClient() {
  const db = openLocalDb();

  return {
    from(table: string) {
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
          new LocalQuery(db, table, "select").select(cols, opts),
        insert: (payload: Record<string, unknown> | Record<string, unknown>[]) =>
          new LocalQuery(db, table, "insert", payload),
        update: (payload: Record<string, unknown>) => new LocalQuery(db, table, "update", payload),
        upsert: (payload: Record<string, unknown>, opts?: UpsertOptions) =>
          new LocalQuery(db, table, "upsert", payload, opts),
        delete: () => new LocalQuery(db, table, "delete"),
      };
    },

    storage: {
      from: (bucket: string) => createBucket(bucket),
    },

    auth: {
      // No GoTrue in local mode, so every request is anonymous.
      // resolveOptionalUserId() treats this as "no owner" (fine, anonymous
      // sessions are allowed); requireUser() treats it as "not authenticated",
      // which correctly disables the login-gated routes (claim, PDF replace)
      // rather than crashing them.
      async getUser() {
        return { data: { user: null }, error: { message: "Auth is not available in local mode" } };
      },
    },
  };
}
