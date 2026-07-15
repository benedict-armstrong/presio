import type { SupabaseClient } from "@supabase/supabase-js";
import { nanoid, customAlphabet } from "nanoid";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { isValidTotalSlides, MAX_TOTAL_SLIDES } from "../validation.js";

const generateSessionId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const generatePassphrase = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);

// Keep in sync with OWNED_SESSION_TTL_MS in routes/sessions.ts
const OWNED_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ownedExpiry = () => new Date(Date.now() + OWNED_SESSION_TTL_MS).toISOString();

export const PRESENT_NEXT =
  "Open url in a browser to start a local presentation (skips share). The PDF is copied into the browser and removed from the server. Unclaimed links expire after 24h (7 days when authenticated).";

export type PresentResult =
  | { ok: true; id: string; url: string; filename: string; totalSlides: number; next: string; controllerToken: string }
  | { ok: false; status: number; error: string };

async function insertSession(supabase: SupabaseClient, row: Record<string, unknown>): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = generateSessionId();
    const { error } = await supabase.from("sessions").insert({ ...row, id });
    if (!error) return id;
    if (error.code !== "23505") {
      console.error("Failed to create session:", error);
      return null;
    }
  }
  console.error("Failed to create session: code collision after 3 attempts");
  return null;
}

/** Stage a PDF for local handoff; returns an open URL the browser claims into IndexedDB. */
export async function createPresentHandoff(
  supabase: SupabaseClient,
  opts: { buffer: Buffer; originalName: string; userId: string | null; baseUrl: string }
): Promise<PresentResult> {
  let totalSlides: number;
  try {
    const doc = await getDocument({ data: new Uint8Array(opts.buffer) }).promise;
    totalSlides = doc.numPages;
    doc.destroy();
  } catch {
    return { ok: false, status: 422, error: "Could not parse PDF" };
  }
  if (!isValidTotalSlides(totalSlides)) {
    return { ok: false, status: 400, error: `PDF exceeds the ${MAX_TOTAL_SLIDES}-page limit` };
  }

  const filename = opts.originalName.replace(/\.pdf$/i, "") || "presentation";
  const controllerToken = nanoid(24);
  const passphrase = generatePassphrase();
  const pdfPath = `handoff/${nanoid(32)}.pdf`;

  const id = await insertSession(supabase, {
    pdf_path: pdfPath,
    filename,
    total_slides: totalSlides,
    controller_token: controllerToken,
    passphrase,
    local: true,
    user_id: opts.userId,
    ...(opts.userId ? { expires_at: ownedExpiry() } : {}),
  });
  if (!id) return { ok: false, status: 500, error: "Failed to create session" };

  const { error: uploadError } = await supabase.storage
    .from("presentations")
    .upload(pdfPath, opts.buffer, { contentType: "application/pdf", upsert: false });
  if (uploadError) {
    console.error("Failed to stage PDF:", uploadError);
    await supabase.from("sessions").update({ status: "expired" }).eq("id", id);
    return { ok: false, status: 500, error: "Failed to upload PDF" };
  }

  const url = `${opts.baseUrl}/start/${id}?t=${controllerToken}`;
  return {
    ok: true,
    id,
    url,
    filename,
    totalSlides,
    next: PRESENT_NEXT,
    controllerToken,
  };
}

export function handoffTokenFrom(req: { get(name: string): string | undefined; query: Record<string, unknown> }): string {
  return req.get("x-controller-token") || (typeof req.query.t === "string" ? req.query.t : "") || "";
}
