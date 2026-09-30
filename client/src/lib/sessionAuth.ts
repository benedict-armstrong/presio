// What this browser holds to prove control of a synced presentation — its
// controller token and handover passphrase, kept in localStorage per session —
// and the request headers built from them.

import { lsGet, lsSet, sessionKey } from "./storage";
import { supabase } from "./supabaseClient";
import { authEnabled } from "./authMode";

export interface SessionAuth {
  controllerToken?: string;
  passphrase?: string;
}

export function getSessionAuth(id: string): SessionAuth {
  return lsGet<SessionAuth>(sessionKey(id), {});
}

export function setSessionAuth(id: string, auth: SessionAuth) {
  lsSet(sessionKey(id), auth);
}

// Headers for a presenter-side write. The server accepts either the
// presentation's controller token or the logged-in owner's bearer token, so
// send whichever this browser has — and both when it has both. Sending only
// the bearer token is wrong for a case that matters: a signed-in presenter who
// took control by passphrase isn't the owner, so their token doesn't authorize
// the write and the controller token that would was never sent.
//
// Empty when this browser has neither; callers decide whether that's an error.
export async function controllerHeaders(id: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const { controllerToken } = getSessionAuth(id);
  if (controllerToken) headers["x-controller-token"] = controllerToken;
  if (authEnabled) {
    // getSession() refreshes a token near expiry, so this never sends a stale one.
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

// Ends (deletes) a synced presentation. The server requires the controller
// token, so send the one stored for this session — or `fallbackToken` when this
// device never held the credential (an account-synced deck opened from
// /api/sessions/mine carries its token with the row).
export function endSession(id: string, fallbackToken?: string): Promise<Response> {
  const { controllerToken } = getSessionAuth(id);
  const token = controllerToken ?? fallbackToken;
  return fetch(`/api/sessions/${id}`, {
    method: "DELETE",
    headers: token ? { "x-controller-token": token } : {},
  });
}
