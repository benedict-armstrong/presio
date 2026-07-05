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

// The current page as an auth redirect target, *without* the hash. GoTrue
// appends its tokens as a `#…` fragment; a stray trailing `#` in the target
// (supabase-js leaves one behind after cleaning a previous OAuth return)
// doubles up and makes the tokens unparseable — the login/reset then appears
// to silently do nothing.
const currentPageUrl = () =>
  window.location.origin + window.location.pathname + window.location.search;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(!devUser);
  // Set when the user lands here from a password-reset email; the app shows a
  // "choose a new password" dialog until it's cleared.
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  // GoTrue reports email-link failures (expired, already used) as fragment
  // params on the redirect. Surface them — otherwise a dead link just lands on
  // the page with no explanation.
  const [authLinkError, setAuthLinkError] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const msg = params.get("error_description");
    if (msg) {
      // Remove the error fragment so a reload doesn't re-show it.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    return msg;
  });

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
        options: { redirectTo: redirectTo ?? currentPageUrl() },
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
        options: { emailRedirectTo: currentPageUrl() },
      });
      if (error) throw error;
    },
    signOut: async () => {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
    resetPassword: async (email) => {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: currentPageUrl(),
      });
      if (error) throw error;
    },
    verifyResetCode: async (email, code) => {
      // Same recovery session as clicking the email link, minus the redirect —
      // works even when a mail scanner has prefetched (voided) the link.
      const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "recovery" });
      if (error) throw error;
      setPasswordRecovery(true);
    },
    updatePassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
    },
    passwordRecovery,
    clearPasswordRecovery: () => setPasswordRecovery(false),
    authLinkError,
    clearAuthLinkError: () => setAuthLinkError(null),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
