import { useState } from "react";
import { idbGet, idbDelete } from "@/lib/localStore";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { setSessionAuth } from "@/lib/utils";

// Uploads the local PDF and turns this session into a normal synced one (same
// code). Stores the returned controller token so the presenter keeps control,
// and drops the local IndexedDB copy so future loads use the synced path.
export function useClaim(id: string) {
  const { session } = useAuth();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");

  const sync = async (currentSlide?: number): Promise<boolean> => {
    // We may appear "logged in" without a real Supabase session — notably the
    // dev-only VITE_DEV_USER flag fakes a user but never establishes a session,
    // and the server's claim endpoint requires a real access token. Surface that
    // instead of silently doing nothing when the button is clicked.
    if (!session) {
      setSyncError("You're not fully signed in. Please log in again to sync.");
      return false;
    }
    setSyncError("");
    setSyncing(true);
    try {
      // Pull a fresh token rather than the cached session's: getSession()
      // auto-refreshes if it's near expiry, so the claim never fails with a
      // stale 401.
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session) throw new Error("Please log in again");
      const accessToken = sessionData.session.access_token;

      const rec = await idbGet(id);
      if (!rec) throw new Error("Local copy not found on this device");
      const form = new FormData();
      form.append("pdf", rec.blob, `${rec.filename}.pdf`);
      if (currentSlide) form.append("current_slide", String(currentSlide));
      const res = await fetch(`/api/sessions/${id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to sync presentation");
      }
      const data = await res.json();
      if (data.controllerToken) {
        setSessionAuth(id, { controllerToken: data.controllerToken, passphrase: data.passphrase });
      }
      await idbDelete(id).catch(() => { /* ignore */ });
      return true;
    } catch (e: unknown) {
      setSyncError(e instanceof Error ? e.message : "Failed to sync presentation");
      return false;
    } finally {
      setSyncing(false);
    }
  };

  return { syncing, syncError, sync };
}
