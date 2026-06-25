import { useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { AuthContext, type AuthContextValue } from "@/lib/useAuth";

// Dev-only: set VITE_DEV_USER (e.g. "dev@example.com") to start signed in as a
// fake user. Lets us exercise the logged-in UI without a real Supabase session.
const devUser: User | null =
  import.meta.env.DEV && import.meta.env.VITE_DEV_USER
    ? ({ id: "dev-user", email: import.meta.env.VITE_DEV_USER } as User)
    : null;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(!devUser);

  useEffect(() => {
    if (devUser) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const value: AuthContextValue = {
    user: devUser ?? session?.user ?? null,
    session,
    loading,
    signInWithGitHub: async (redirectTo) => {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo: redirectTo ?? window.location.href },
      });
      if (error) throw error;
    },
    signInWithPassword: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    signUp: async (email, password) => {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
    },
    signOut: async () => {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
