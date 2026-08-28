import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LocalPresentation } from "@/lib/localStore";

// The matcher reads (and backfills) fingerprints through the IndexedDB store,
// which doesn't exist under the node test environment. Stand in a plain map so
// the tests exercise the matching rules rather than the browser API.
const records = new Map<string, LocalPresentation>();
const idbGet = vi.fn(async (id: string) => records.get(id) ?? null);
const idbPut = vi.fn(async (rec: LocalPresentation) => {
  records.set(rec.id, rec);
});
vi.mock("@/lib/localStore", () => ({
  idbGet: (id: string) => idbGet(id),
  idbPut: (rec: LocalPresentation) => idbPut(rec),
}));

const { matchReupload } = await import("@/lib/reupload");
const { sha256Hex } = await import("@/lib/analytics");

const bytes = (text: string) => new TextEncoder().encode(text);
const hashOf = (text: string) => sha256Hex(bytes(text).buffer as ArrayBuffer);

const local = (id: string, filename: string, sha256?: string) =>
  ({ id, filename, kind: "local" as const, sha256 });
const synced = (id: string, filename: string) =>
  ({ id, filename, kind: "synced" as const });
const account = (id: string, filename: string) =>
  ({ id, filename, kind: "account" as const });

function seedRecord(id: string, text: string) {
  records.set(id, {
    id,
    filename: id,
    totalSlides: 1,
    blob: new Blob([bytes(text)]),
    createdAt: 0,
  } as LocalPresentation);
}

beforeEach(() => {
  records.clear();
  idbGet.mockClear();
  idbPut.mockClear();
});

describe("matchReupload", () => {
  it("returns nothing when no recent shares the filename", async () => {
    const hash = await hashOf("deck");
    expect(await matchReupload("Talk", hash, [local("A", "Other", hash)])).toBeUndefined();
  });

  it("matches the filename case-insensitively", async () => {
    const hash = await hashOf("deck");
    const match = await matchReupload("TALK", hash, [local("A", "talk", hash)]);
    expect(match).toEqual({ target: local("A", "talk", hash), identical: true, compared: true });
  });

  it("reports a byte-identical local re-drop as identical", async () => {
    const hash = await hashOf("deck");
    const match = await matchReupload("Talk", hash, [local("A", "Talk", hash)]);
    expect(match?.identical).toBe(true);
  });

  it("reports a same-name local deck with different bytes as a non-identical match", async () => {
    const match = await matchReupload("Talk", await hashOf("v2"), [
      local("A", "Talk", await hashOf("v1")),
    ]);
    expect(match).toEqual({
      target: expect.objectContaining({ id: "A" }),
      identical: false,
      compared: true,
    });
  });

  it("backfills a missing fingerprint from the stored blob and remembers it", async () => {
    seedRecord("A", "deck");
    const hash = await hashOf("deck");
    const match = await matchReupload("Talk", hash, [local("A", "Talk")]);
    expect(match?.identical).toBe(true);
    expect(idbGet).toHaveBeenCalledWith("A");
    expect(records.get("A")?.sha256).toBe(hash);
  });

  it("skips a local row whose IndexedDB record is gone", async () => {
    // Nothing seeded: the row is a leftover with nothing left to update.
    expect(await matchReupload("Talk", await hashOf("deck"), [local("A", "Talk")])).toBeUndefined();
  });

  it("matches synced and account rows on name alone, never as identical", async () => {
    const hash = await hashOf("deck");
    expect(await matchReupload("Talk", hash, [synced("S", "Talk")])).toEqual({
      target: synced("S", "Talk"),
      identical: false,
      compared: false,
    });
    expect(await matchReupload("Talk", hash, [account("Q", "Talk")])).toEqual({
      target: account("Q", "Talk"),
      identical: false,
      compared: false,
    });
  });

  it("matches a recompile that changed the slide count — count is not part of the match", async () => {
    // The row carries no slide count at all: only the name (and, for local
    // rows, the bytes) decide. A deck that gained a slide still matches.
    const match = await matchReupload("Talk", await hashOf("v2"), [synced("S", "Talk")]);
    expect(match?.target.id).toBe("S");
  });

  it("degrades to a name-only match when the file could not be hashed", async () => {
    // No crypto.subtle (plain-http origin): never claims identical, but still
    // offers the update rather than silently creating a second presentation.
    const match = await matchReupload("Talk", undefined, [local("A", "Talk", "stored-hash")]);
    expect(match).toEqual({
      target: expect.objectContaining({ id: "A" }),
      identical: false,
      // Nothing was weighed, so the prompt must not claim the content differs.
      compared: false,
    });
    expect(idbGet).not.toHaveBeenCalled();
  });

  it("prefers a local row over a synced one with the same name", async () => {
    const match = await matchReupload("Talk", await hashOf("v2"), [
      synced("S", "Talk"),
      local("A", "Talk", await hashOf("v1")),
    ]);
    expect(match?.target.id).toBe("A");
  });

  it("prefers the byte-identical local row over an earlier same-name one", async () => {
    const hash = await hashOf("deck");
    const match = await matchReupload("Talk", hash, [
      local("A", "Talk", await hashOf("other")),
      local("B", "Talk", hash),
    ]);
    expect(match).toEqual({
      target: expect.objectContaining({ id: "B" }),
      identical: true,
      compared: true,
    });
  });

  it("doesn't claim the content differs when the stored copy couldn't be read", async () => {
    idbGet.mockRejectedValueOnce(new Error("storage unavailable"));
    const match = await matchReupload("Talk", await hashOf("v2"), [local("A", "Talk")]);
    expect(match).toEqual({
      target: expect.objectContaining({ id: "A" }),
      identical: false,
      compared: false,
    });
  });

  it("falls back to the first local row when none is identical", async () => {
    // idbList orders locals newest-first, so the first is the freshest copy.
    const match = await matchReupload("Talk", await hashOf("v3"), [
      local("NEW", "Talk", await hashOf("v2")),
      local("OLD", "Talk", await hashOf("v1")),
    ]);
    expect(match?.target.id).toBe("NEW");
  });
});
