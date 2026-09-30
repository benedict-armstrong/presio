// Loading a session row and deciding whether a request may act as its
// controller. Every presenter-side route does both, and they used to carry
// their own copies, which had drifted (some read ended sessions, some didn't).
//
// The rule, once: an ended (status 'expired') session is gone for every route.
// A controller is whoever holds the controller token; routes that allow it
// also accept the logged-in owner (hosted mode only — local mode has no
// accounts).

import type express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveOptionalUserId, safeEqual } from "../auth.js";
import { isLocalMode } from "../local/mode.js";

// Rows come back untyped from the untyped client; each caller names the
// columns it selects and reads only those.
export type SessionRow = Record<string, any>;

/** The live session `id` with `columns`, or null when there's none. */
export async function loadSession(supabase: SupabaseClient, id: string | string[], columns: string): Promise<SessionRow | null> {
  // A route parameter is only ever one segment; anything else names nothing.
  if (typeof id !== "string") return null;
  const { data, error } = await supabase.from("sessions").select(columns).eq("id", id).neq("status", "expired").single();
  return error || !data ? null : (data as SessionRow);
}

/** The controller token a request carries (the x-controller-token header). */
export const controllerTokenFrom = (req: express.Request) => req.get("x-controller-token") || "";

/**
 * Whether the request may act as the session's controller: it holds the
 * controller token (`token`, else the header), or — with `allowOwner`, in
 * hosted mode — it's signed in as the session's owner. The row must carry
 * controller_token (and user_id, for allowOwner).
 */
export async function authorizeController(
  supabase: SupabaseClient,
  req: express.Request,
  row: SessionRow,
  { allowOwner = false, token = controllerTokenFrom(req) }: { allowOwner?: boolean; token?: string } = {}
): Promise<boolean> {
  if (safeEqual(token, row.controller_token ?? "")) return true;
  if (!allowOwner || isLocalMode) return false;
  const user = await resolveOptionalUserId(supabase, req);
  return !!user && row.user_id === user;
}
