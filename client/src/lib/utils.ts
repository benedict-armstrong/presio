import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { lsGet, lsSet, sessionKey } from "./storage"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

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
