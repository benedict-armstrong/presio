import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { useAuth } from "@/lib/useAuth";

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.73 1.27 3.4.97.1-.76.41-1.27.74-1.56-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.02 11.02 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.42.36.79 1.08.79 2.18v3.23c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}

export function LoginDialog({ onClose }: { onClose: () => void }) {
  const { signInWithGitHub, signInWithPassword, signUp, resetPassword } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState("");

  const submit = async () => {
    setError("");
    setInfo("");
    setLoading(true);
    try {
      if (mode === "signup") {
        await signUp(email, password);
        setInfo("Account created. Check your email for a confirmation link, then sign in.");
        setMode("signin");
      } else if (mode === "reset") {
        await resetPassword(email);
        setInfo("If an account exists for that address, a reset link is on its way.");
      } else {
        await signInWithPassword(email, password);
        onClose();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const github = async () => {
    setError("");
    try {
      // No explicit target: the provider defaults to the current page with the
      // hash stripped (a stray `#` corrupts GoTrue's token fragment).
      await signInWithGitHub();
      // Redirects away; nothing more to do here.
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "GitHub sign-in failed");
    }
  };

  return (
    <DialogOverlay onClose={onClose} maxWidth="max-w-xs">
      <div className="space-y-1 text-center">
        <h2 className="text-lg font-semibold">
          {mode === "signup" ? "Create account" : mode === "reset" ? "Reset password" : "Log in"}
        </h2>
        <p className="text-xs text-muted-foreground">
          {mode === "reset"
            ? "Enter your email and we'll send you a reset link."
            : "Log in to share presentations online across devices."}
        </p>
      </div>

      {mode !== "reset" && (
        <>
          <Button variant="outline" className="w-full" onClick={github}>
            <GitHubIcon />
            Continue with GitHub
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">or</span>
            </div>
          </div>
        </>
      )}

      <div className="space-y-2">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          autoComplete="email"
        />
        {mode !== "reset" && (
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && email && password) submit(); }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {info && <p className="text-sm text-muted-foreground">{info}</p>}
        <Button
          className="w-full"
          disabled={!email || (mode !== "reset" && !password) || loading}
          onClick={submit}
        >
          {loading ? "Please wait…" : mode === "signup" ? "Sign up" : mode === "reset" ? "Send reset link" : "Log in"}
        </Button>
      </div>

      {mode === "signin" && (
        <button
          type="button"
          onClick={() => { setMode("reset"); setError(""); setInfo(""); }}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4 mx-auto block"
        >
          Forgot password?
        </button>
      )}
      <button
        type="button"
        onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); setInfo(""); }}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4 mx-auto block"
      >
        {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Log in"}
      </button>
    </DialogOverlay>
  );
}
