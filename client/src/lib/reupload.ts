// Recognising a dropped PDF as a re-upload of a presentation this browser
// already knows about, so the home screen can offer to swap it in under the
// existing code instead of minting a second presentation for the same deck.
//
// The whole comparison is local: the recents list is already in memory and the
// stored fingerprints come from IndexedDB, so a drop that matches nothing costs
// no network round-trip and adds no delay to the ordinary create path.

import { idbGet, idbPut } from "@/lib/localStore";
import { sha256Hex } from "@/lib/analytics";

/** The part of a recents row this matcher needs. Home's `RecentDeck` satisfies
 *  it; the generic below hands the caller its own row type back. */
export interface ReuploadCandidate {
  id: string;
  filename: string;
  kind: "local" | "synced" | "account";
  /** Local rows only: SHA-256 of the stored PDF's bytes, when known. */
  sha256?: string;
}

/**
 * The fingerprint of a local row's stored PDF, backfilling it from the blob for
 * records created before decks were fingerprinted (and remembering the result,
 * so the next drop needs no blob read).
 *
 * `null` means the row's IndexedDB record is gone — there is nothing left to
 * update, so the row isn't a re-upload target at all. `undefined` means the
 * record is there but couldn't be hashed.
 */
async function storedHashOf(row: ReuploadCandidate): Promise<string | null | undefined> {
  if (row.sha256) return row.sha256;
  let rec;
  try {
    rec = await idbGet(row.id);
  } catch {
    return undefined; // storage unavailable: can't compare, but don't drop the row
  }
  if (!rec) return null;
  try {
    const hash = await sha256Hex(await rec.blob.arrayBuffer());
    await idbPut({ ...rec, sha256: hash });
    return hash;
  } catch {
    return undefined;
  }
}

/**
 * Find the presentation a dropped PDF is most likely a re-upload of.
 *
 * Matching is by filename. Local rows additionally compare content hashes, so a
 * byte-identical re-drop can be recognised outright (`identical: true`) — that's
 * someone who lost their link rather than changed their deck, and it wants no
 * prompt at all.
 *
 * `compared` says whether the bytes were actually weighed against a stored copy.
 * Synced and account rows carry no local bytes, and a local row can be missing
 * its record's hash, so the caller must not tell the presenter the content
 * differs unless this is true.
 *
 * Slide count is deliberately *not* part of the match. A recompile that gained
 * or lost a slide is both the commonest case and the one where keeping the
 * existing code matters most, since the link is already out.
 *
 * Local rows are preferred over synced ones when a name is duplicated (only
 * they can be compared by content), and `idbList` already orders them
 * newest-first, so the freshest copy wins.
 *
 * A missing `fileHash` (no `crypto.subtle`, e.g. a plain-http origin) degrades
 * every match to name-only rather than disabling the feature.
 */
export async function matchReupload<T extends ReuploadCandidate>(
  filename: string,
  fileHash: string | undefined,
  recents: readonly T[]
): Promise<{ target: T; identical: boolean; compared: boolean } | undefined> {
  const name = filename.toLowerCase();
  const named = recents.filter((r) => r.filename.toLowerCase() === name);
  if (!named.length) return undefined;

  const locals: { row: T; compared: boolean }[] = [];
  for (const row of named) {
    if (row.kind !== "local") continue;
    if (!fileHash) {
      locals.push({ row, compared: false });
      continue;
    }
    const stored = await storedHashOf(row);
    if (stored === null) continue; // record gone — nothing to update
    if (stored === fileHash) return { target: row, identical: true, compared: true };
    locals.push({ row, compared: stored !== undefined });
  }

  const best = locals[0];
  if (best) return { target: best.row, identical: false, compared: best.compared };
  const other = named.find((r) => r.kind !== "local");
  return other ? { target: other, identical: false, compared: false } : undefined;
}
