import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "./app.js";
import { FakeSupabase, type SessionRow } from "./test/fakeSupabase.js";

// A no-op io stand-in: the DELETE route only calls io.in(id).fetchSockets().
const fakeIo = { in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;

function appWith(fake: FakeSupabase) {
  return createApp({ supabase: fake as unknown as SupabaseClient, io: fakeIo });
}

const future = () => new Date(Date.now() + 86_400_000).toISOString();

const baseRow = (over: Partial<SessionRow>): SessionRow => ({
  id: "ABC123",
  pdf_path: "ABC123.pdf",
  filename: "Talk",
  total_slides: 12,
  current_slide: 3,
  timer_mode: "down",
  timer_duration: 600,
  timer_threshold: 60,
  note_prefix: "note:",
  local: false,
  controller_token: "secret-token",
  passphrase: "PASS1234",
  user_id: "user-1",
  expires_at: future(),
  ...over,
});

describe("GET /api/sessions/:id", () => {
  it("never leaks controller_token, passphrase, or user_id", async () => {
    const app = appWith(new FakeSupabase([baseRow({})]));
    const res = await request(app).get("/api/sessions/ABC123");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("controller_token");
    expect(res.body).not.toHaveProperty("passphrase");
    expect(res.body).not.toHaveProperty("user_id");
    // It does return the public fields + a derived pdfUrl.
    expect(res.body.filename).toBe("Talk");
    expect(res.body.pdfUrl).toBe("https://storage.test/ABC123.pdf");
  });

  it("404s for an unknown session", async () => {
    const app = appWith(new FakeSupabase([]));
    const res = await request(app).get("/api/sessions/NOPE");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/sessions/:id (controller-token auth)", () => {
  it("403s without the right x-controller-token", async () => {
    const fake = new FakeSupabase([baseRow({})]);
    const app = appWith(fake);
    const res = await request(app)
      .delete("/api/sessions/ABC123")
      .set("x-controller-token", "wrong");
    expect(res.status).toBe(403);
    expect(fake.rows).toHaveLength(1); // not deleted
  });

  it("403s when the header is absent", async () => {
    const app = appWith(new FakeSupabase([baseRow({})]));
    const res = await request(app).delete("/api/sessions/ABC123");
    expect(res.status).toBe(403);
  });

  it("deletes when the token matches", async () => {
    const fake = new FakeSupabase([baseRow({})]);
    const app = appWith(fake);
    const res = await request(app)
      .delete("/api/sessions/ABC123")
      .set("x-controller-token", "secret-token");
    expect(res.status).toBe(200);
    expect(fake.rows).toHaveLength(0);
  });
});

describe("POST /api/sessions/:id/claim (auth)", () => {
  it("401s without a bearer token", async () => {
    const app = appWith(new FakeSupabase([baseRow({ local: true })]));
    const res = await request(app).post("/api/sessions/ABC123/claim");
    expect(res.status).toBe(401);
  });

  it("409s when the presentation is already synced", async () => {
    const fake = new FakeSupabase([baseRow({ local: false })]).addToken("tok", "user-1");
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/sessions/ABC123/claim")
      .set("Authorization", "Bearer tok")
      .attach("pdf", Buffer.from("%PDF-1.4"), { filename: "x.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(409);
  });

  it("403s when the concurrent-presentation cap is reached", async () => {
    const fake = new FakeSupabase([
      baseRow({ id: "S1", local: false, user_id: "user-1" }),
      baseRow({ id: "S2", local: false, user_id: "user-1" }),
      baseRow({ id: "S3", local: false, user_id: "user-1" }),
      baseRow({ id: "S4", local: true, user_id: "user-1" }),
    ]).addToken("tok", "user-1");
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/sessions/S4/claim")
      .set("Authorization", "Bearer tok")
      .attach("pdf", Buffer.from("%PDF-1.4"), { filename: "x.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/sessions/external (validation)", () => {
  it("400s on a non-https URL", async () => {
    const app = appWith(new FakeSupabase([]));
    const res = await request(app)
      .post("/api/sessions/external")
      .send({ url: "http://example.com/x.pdf", filename: "x", total_slides: 5 });
    expect(res.status).toBe(400);
  });

  it("400s on missing filename / slides", async () => {
    const app = appWith(new FakeSupabase([]));
    const res = await request(app)
      .post("/api/sessions/external")
      .send({ url: "https://example.com/x.pdf" });
    expect(res.status).toBe(400);
  });

  it("creates a session for a valid external PDF", async () => {
    const fake = new FakeSupabase([]);
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/sessions/external")
      .send({ url: "https://example.com/x.pdf", filename: "Deck", total_slides: 8 });
    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^[A-Z0-9]{6}$/);
    expect(res.body).toHaveProperty("controllerToken");
    expect(fake.rows).toHaveLength(1);
  });
});
