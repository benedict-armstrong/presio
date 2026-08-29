import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase, type SessionRow } from "./test/fakeSupabase.js";

// The routes' job is auth, shape and bookkeeping; whether the remote host is
// reachable is lib/remotePdf's, and it has its own tests. Stub the probe so a
// route test never touches DNS or the network.
const probe = vi.fn<(url: string) => Promise<unknown>>();
vi.mock("./lib/remotePdf.js", () => ({
  fetchRemotePdfMeta: (url: string) => probe(url),
}));

const { createApp } = await import("./app.js");

const emissions: { room: string; event: string; payload: unknown }[] = [];
const fakeIo = {
  in: () => ({ fetchSockets: async () => [] }),
  to: (room: string) => ({
    emit: (event: string, payload?: unknown) => emissions.push({ room, event, payload }),
  }),
} as unknown as Server;

const appWith = (fake: FakeSupabase) =>
  createApp({ supabase: fake as unknown as SupabaseClient, io: fakeIo });

const future = () => new Date(Date.now() + 86_400_000).toISOString();

/** A URL-backed presentation: no server copy, just a link to someone's PDF. */
const urlRow = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: "ABC123",
  pdf_path: "",
  pdf_url: "https://cdn.example.com/deck.pdf",
  filename: "Talk",
  total_slides: 12,
  current_slide: 3,
  local: false,
  controller_token: "secret-token",
  passphrase: "PASS1234",
  user_id: "user-1",
  expires_at: future(),
  ...over,
});

const validators = { etag: '"v1"', lastModified: "", contentLength: "900" };

beforeEach(() => {
  emissions.length = 0;
  probe.mockReset();
  probe.mockResolvedValue(validators);
});

describe("GET /api/sessions/:id/remote-version", () => {
  it("returns the remote validators to the controller", async () => {
    const res = await request(appWith(new FakeSupabase([urlRow()])))
      .get("/api/sessions/ABC123/remote-version")
      .set("x-controller-token", "secret-token");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(validators);
    expect(probe).toHaveBeenCalledWith("https://cdn.example.com/deck.pdf");
  });

  it("authorizes the logged-in owner by bearer token too", async () => {
    const fake = new FakeSupabase([urlRow()]).addToken("tok", "user-1");
    const res = await request(appWith(fake))
      .get("/api/sessions/ABC123/remote-version")
      .set("Authorization", "Bearer tok");
    expect(res.status).toBe(200);
  });

  it("403s on a wrong controller token, and never probes the host", async () => {
    const res = await request(appWith(new FakeSupabase([urlRow()])))
      .get("/api/sessions/ABC123/remote-version")
      .set("x-controller-token", "wrong");
    expect(res.status).toBe(403);
    expect(probe).not.toHaveBeenCalled();
  });

  it("403s for a signed-in user who doesn't own the presentation", async () => {
    const fake = new FakeSupabase([urlRow()]).addToken("tok", "someone-else");
    const res = await request(appWith(fake))
      .get("/api/sessions/ABC123/remote-version")
      .set("Authorization", "Bearer tok");
    expect(res.status).toBe(403);
  });

  it("404s for a deck that isn't URL-backed — nothing to watch", async () => {
    const hosted = urlRow({ pdf_url: "", pdf_path: "ABC123.pdf" });
    const res = await request(appWith(new FakeSupabase([hosted])))
      .get("/api/sessions/ABC123/remote-version")
      .set("x-controller-token", "secret-token");
    expect(res.status).toBe(404);
    expect(probe).not.toHaveBeenCalled();
  });

  it("404s for a local deck", async () => {
    const res = await request(appWith(new FakeSupabase([urlRow({ local: true })])))
      .get("/api/sessions/ABC123/remote-version")
      .set("x-controller-token", "secret-token");
    expect(res.status).toBe(404);
  });

  it("404s for an unknown or expired session", async () => {
    const unknown = await request(appWith(new FakeSupabase([])))
      .get("/api/sessions/NOPE00/remote-version")
      .set("x-controller-token", "secret-token");
    expect(unknown.status).toBe(404);

    const expired = await request(appWith(new FakeSupabase([urlRow({ status: "expired" })])))
      .get("/api/sessions/ABC123/remote-version")
      .set("x-controller-token", "secret-token");
    expect(expired.status).toBe(404);
  });

  it("502s when the host can't be reached or is refused", async () => {
    probe.mockResolvedValue(null);
    const res = await request(appWith(new FakeSupabase([urlRow()])))
      .get("/api/sessions/ABC123/remote-version")
      .set("x-controller-token", "secret-token");
    expect(res.status).toBe(502);
  });
});

describe("POST /api/sessions/:id/deck-refreshed", () => {
  const post = (fake: FakeSupabase, body: unknown, token = "secret-token") =>
    request(appWith(fake))
      .post("/api/sessions/ABC123/deck-refreshed")
      .set("x-controller-token", token)
      .send(body as object);

  it("records the new page count and tells the room to reload", async () => {
    const fake = new FakeSupabase([urlRow()]);
    const res = await post(fake, { total_slides: 20 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, totalSlides: 20, filename: "Talk" });
    expect(fake.rows[0].total_slides).toBe(20);
    expect(emissions).toContainEqual({
      room: "ABC123",
      event: "deck_updated",
      payload: { filename: "Talk", totalSlides: 20 },
    });
  });

  it("clamps a current slide that the shorter deck no longer has", async () => {
    const fake = new FakeSupabase([urlRow({ current_slide: 9 })]);
    const res = await post(fake, { total_slides: 7 });
    expect(res.status).toBe(200);
    expect(fake.rows[0].current_slide).toBe(7);
  });

  it("leaves an in-range current slide alone", async () => {
    const fake = new FakeSupabase([urlRow({ current_slide: 3 })]);
    await post(fake, { total_slides: 20 });
    expect(fake.rows[0].current_slide).toBe(3);
  });

  it("uploads nothing — a URL-backed deck keeps no server copy", async () => {
    const fake = new FakeSupabase([urlRow()]);
    await post(fake, { total_slides: 20 });
    expect(fake.uploaded.size).toBe(0);
  });

  it("400s on a missing, unparseable or out-of-range total_slides", async () => {
    for (const body of [{}, { total_slides: "lots" }, { total_slides: 0 }, { total_slides: 99999 }]) {
      const fake = new FakeSupabase([urlRow()]);
      const res = await post(fake, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(fake.rows[0].total_slides).toBe(12); // untouched
    }
  });

  it("400s for a deck that isn't URL-backed", async () => {
    const fake = new FakeSupabase([urlRow({ pdf_url: "", pdf_path: "ABC123.pdf" })]);
    const res = await post(fake, { total_slides: 20 });
    expect(res.status).toBe(400);
    expect(emissions).toHaveLength(0);
  });

  it("403s on a wrong controller token and changes nothing", async () => {
    const fake = new FakeSupabase([urlRow()]);
    const res = await post(fake, { total_slides: 20 }, "wrong");
    expect(res.status).toBe(403);
    expect(fake.rows[0].total_slides).toBe(12);
    expect(emissions).toHaveLength(0);
  });

  it("404s for an unknown session", async () => {
    const res = await request(appWith(new FakeSupabase([])))
      .post("/api/sessions/NOPE00/deck-refreshed")
      .set("x-controller-token", "secret-token")
      .send({ total_slides: 20 });
    expect(res.status).toBe(404);
  });
});
