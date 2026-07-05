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
  // Set when the user lands here from a password-reset email; the app shows a
  // "choose a new password" dialog until it's cleared.
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  useEffect(() => {
    if (devUser) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true);
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
      const { error } = await supabase.auth.signUp({
        email,
        password,
        // Send the confirmation link back to where the user signed up, not home.
        options: { emailRedirectTo: window.location.href },
      });
      if (error) throw error;
    },
    signOut: async () => {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
    resetPassword: async (email) => {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.href,
      });
      if (error) throw error;
    },
    updatePassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
    },
    passwordRecovery,
    clearPasswordRecovery: () => setPasswordRecovery(false),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
