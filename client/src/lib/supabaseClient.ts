import { createClient } from "@supabase/supabase-js";

// Fall back to placeholders when built without Supabase config (CI/e2e builds,
// self-hosts that don't use auth): createClient throws on an empty URL, which
// would take the whole app down instead of just disabling login.
const url = (import.meta.env.VITE_SUPABASE_URL as string) || "https://supabase.invalid";
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY as string) || "anon-key-not-configured";

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
