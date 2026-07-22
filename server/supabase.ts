import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isLocalMode } from "./local/mode.js";
import { createLocalClient } from "./local/localClient.js";

// PRESIO_MODE=local swaps Supabase for a SQLite + filesystem client with the
// same shape (see server/local/localClient.ts) — every other call site keeps
// using `supabase` exactly as before.
export const supabase = (
  isLocalMode ? createLocalClient() : createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
) as unknown as SupabaseClient;
