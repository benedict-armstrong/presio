import { getDocument } from "pdfjs-dist";
import "@/lib/pdf"; // ensure the pdf.js worker is configured

const LOAD_ERROR =
  "Couldn't load a PDF from that URL. Use a direct, public HTTPS link that allows cross-origin access (e.g. a GitHub raw or Pages URL).";

export interface ExternalPdfMeta {
  url: string;
  filename: string;
  totalSlides: number;
}

// Rewrite "viewer" URLs to a directly-fetchable, CORS-friendly raw URL.
// GitHub's blob/raw page URLs serve HTML, not the file; raw.githubusercontent.com
// serves the bytes with `access-control-allow-origin: *`.
//   https://github.com/<owner>/<repo>/blob/<ref>/<path>
//     -> https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
function normalizePdfUrl(url: URL): URL {
  if (url.hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    // [owner, repo, "blob"|"raw", ref, ...path]
    if ((parts[2] === "blob" || parts[2] === "raw") && parts.length >= 5) {
      const [owner, repo, , ...rest] = parts;
      return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`);
    }
  }
  return url;
}

// Fetch + parse an externally-hosted PDF to validate it loads (CORS + content)
// and read its page count and a display name. Throws a user-friendly error on
// any failure so callers can surface it directly.
export async function loadExternalPdfMeta(rawUrl: string): Promise<ExternalPdfMeta> {
  let url: URL;
  try {
    url = normalizePdfUrl(new URL(rawUrl.trim()));
  } catch {
    throw new Error("Enter a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("The URL must start with https://");
  }

  let totalSlides: number;
  try {
    const doc = await getDocument(url.href).promise;
    totalSlides = doc.numPages;
    doc.destroy();
  } catch {
    throw new Error(LOAD_ERROR);
  }

  // Derive a display name from the last path segment, stripping a .pdf suffix.
  const lastSegment = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  const filename = lastSegment.replace(/\.pdf$/i, "") || "Presentation";

  return { url: url.href, filename, totalSlides };
}

// Store the controller token so the creator keeps control of the session, using
// the same localStorage shape as synced/claimed sessions.
function rememberToken(id: string, controllerToken?: string, passphrase?: string) {
  if (!controllerToken) return;
  localStorage.setItem(`session_${id}`, JSON.stringify({ controllerToken, passphrase }));
}

// Create a new shareable session backed by an externally-hosted PDF. Returns the
// new session id. Sends the access token when provided so a logged-in creator
// owns the session, but login is not required.
export async function createExternalSession(
  meta: ExternalPdfMeta,
  accessToken?: string
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch("/api/sessions/external", {
    method: "POST",
    headers,
    body: JSON.stringify({ url: meta.url, filename: meta.filename, total_slides: meta.totalSlides }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to create session");
  }
  const data = await res.json();
  rememberToken(data.id, data.controllerToken, data.passphrase);
  return data.id as string;
}

// Convert an existing local session into an external one in place (same code).
export async function shareLocalSessionViaUrl(id: string, meta: ExternalPdfMeta): Promise<void> {
  const res = await fetch(`/api/sessions/${id}/share-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: meta.url, total_slides: meta.totalSlides }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to share presentation");
  }
  const data = await res.json();
  rememberToken(id, data.controllerToken, data.passphrase);
}
