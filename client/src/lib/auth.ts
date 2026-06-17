// Placeholder auth. Real authentication (and online sync for logged-in users)
// is future work; for now this is a localStorage-backed flag so the existing
// server-upload path stays reachable for testing.
const KEY = "presio_auth";

export function isLoggedIn(): boolean {
  return localStorage.getItem(KEY) === "1";
}

export function setLoggedIn(value: boolean): void {
  if (value) localStorage.setItem(KEY, "1");
  else localStorage.removeItem(KEY);
}
