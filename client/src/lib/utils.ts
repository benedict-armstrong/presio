import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getSessionAuth(id: string) {
  try {
    return JSON.parse(localStorage.getItem(`session_${id}`) || "{}");
  } catch {
    return {};
  }
}

// Ends (deletes) a synced presentation. The server requires the controller
// token, so send the one stored for this session.
export function endSession(id: string): Promise<Response> {
  const { controllerToken } = getSessionAuth(id);
  return fetch(`/api/sessions/${id}`, {
    method: "DELETE",
    headers: controllerToken ? { "x-controller-token": controllerToken } : {},
  });
}
