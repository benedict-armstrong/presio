import { describe, it, expect } from "vitest";
import fs from "fs";
import http from "http";
import path from "path";
import request from "supertest";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "./app.js";
import { FakeSupabase, type SessionRow } from "./test/fakeSupabase.js";

// A no-op io stand-in: the DELETE route only calls io.in(id).fetchSockets(),
// and the deck-update path broadcasts via io.to(id).emit(). Emissions are
// recorded so tests can assert viewers were told to reload.
const fakeEmissions: { room: string; event: string; payload: unknown }[] = [];
const fakeIo = {
  in: () => ({ fetchSockets: async () => [] }),
  to: (room: string) => ({
    emit: (event: string, payload?: unknown) => fakeEmissions.push({ room, event, payload }),
  }),
} as unknown as Server;

function appWith(fake: FakeSupabase) {
  return createApp({ supabase: fake as unknown as SupabaseClient, io: fakeIo });
}

const future = () => new Date(Date.now() + 86_400_000).toISOString();

// A real PDF — the claim route parses the upload with pdf.js to count pages.
const realPdf = fs.readFileSync(path.join(import.meta.dirname, "../example/example.pdf"));

const baseRow = (over: Partial<SessionRow>): SessionRow => ({
  id: "ABC123",
  pdf_path: "ABC123.pdf",
  filename: "Talk",
  total_slides: 12,
  current_slide: 3,
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

  it("404s for an expired session", async () => {
    const app = appWith(new FakeSupabase([baseRow({ status: "expired" })]));
    const res = await request(app).get("/api/sessions/ABC123");
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

  it("marks the session expired (not deleted) when the token matches", async () => {
    const fake = new FakeSupabase([baseRow({})]);
    const app = appWith(fake);
    const res = await request(app)
      .delete("/api/sessions/ABC123")
      .set("x-controller-token", "secret-token");
    expect(res.status).toBe(200);
    // The row is retained, just marked expired.
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].status).toBe("expired");
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

  it("uploads the PDF and flips the session from local to synced", async () => {
    const fake = new FakeSupabase([baseRow({ local: true, pdf_path: "", user_id: null })]).addToken("tok", "user-1");
    const res = await request(appWith(fake))
      .post("/api/sessions/ABC123/claim")
      .set("Authorization", "Bearer tok")
      .attach("pdf", realPdf, { filename: "x.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(200);
    expect(res.body.totalSlides).toBeGreaterThan(0);
    expect(fake.rows[0].local).toBe(false);
    expect(fake.rows[0].pdf_path).toBe("ABC123.pdf");
  });

  // A browser that aborts mid-upload leaves the multipart body without its
  // closing boundary. busboy raises "Unexpected end of form", which carries no
  // status and used to escape to Express's default handler — an HTML 500 the
  // client parses as a generic failure, with only a stack trace in the logs.
  it("answers a truncated multipart body with 400 JSON, not an HTML 500", async () => {
    const app = appWith(new FakeSupabase([baseRow({ local: true })]).addToken("tok", "user-1"));
    const server = http.createServer(app).listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await new Promise<{ code: number; body: string }>((resolve, reject) => {
        const boundary = "----presiotest";
        const req = http.request({
          port,
          method: "POST",
          path: "/api/sessions/ABC123/claim",
          headers: {
            Authorization: "Bearer tok",
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
        });
        req.on("error", reject);
        req.on("response", (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () => resolve({ code: r.statusCode!, body }));
        });
        req.write(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="pdf"; filename="x.pdf"\r\n` +
            `Content-Type: application/pdf\r\n\r\n` +
            realPdf.subarray(0, 500).toString("binary")
        );
        req.end(); // ends without the trailing --boundary--
      });

      expect(res.code).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/upload didn't complete/i);
    } finally {
      server.close();
    }
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

// A local handoff session, as minted by POST /api/present.
const handoffRow = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: "HND001",
  pdf_path: "handoff/old.pdf",
  filename: "Old deck",
  total_slides: 5,
  current_slide: 2,
  local: true,
  controller_token: "handoff-token",
  passphrase: "PASS1234",
  user_id: null,
  expires_at: future(),
  ...over,
});

describe("POST /api/present (create)", () => {
  it("keeps today's create behaviour when no session_id is given", async () => {
    const fake = new FakeSupabase([]);
    const app = appWith(fake);
    const res = await request(app).post("/api/present").attach("file", realPdf, {
      filename: "deck.pdf",
      contentType: "application/pdf",
    });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["filename", "id", "next", "totalSlides", "url"].sort());
    expect(res.body.url).toMatch(/^http:\/\/.+\/start\/[A-Z0-9]{6}\?t=/);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].local).toBe(true);
  });
});

describe("POST /api/present (update in place)", () => {
  it("replaces a local handoff deck and returns the same link and token", async () => {
    const fake = new FakeSupabase([handoffRow({})]);
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/present")
      .field("session_id", "HND001")
      .field("controller_token", "handoff-token")
      .attach("file", realPdf, { filename: "new-deck.PDF", contentType: "application/pdf" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    // Same presentation → same id and same link/token as the original create.
    expect(res.body.id).toBe("HND001");
    expect(res.body.url).toMatch(/^http:\/\/[^/]+\/start\/HND001\?t=handoff-token$/);
    expect(res.body.totalSlides).toBeGreaterThan(0);

    // The row is reused, not duplicated — no extra concurrent slot.
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].local).toBe(true);
    expect(fake.rows[0].controller_token).toBe("handoff-token");
    expect(fake.rows[0].filename).toBe("new-deck");
    expect(fake.rows[0].pdf_path).toBe("handoff/old.pdf");
    expect(fake.uploaded.get("handoff/old.pdf")?.length).toBe(realPdf.length);
  });

  it("accepts the token via the x-controller-token header too", async () => {
    const fake = new FakeSupabase([handoffRow({ pdf_path: "" })]); // handoff already completed
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/present")
      .set("x-controller-token", "handoff-token")
      .field("session_id", "HND001")
      .attach("file", realPdf, { filename: "v2.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(200);
    // Server copy was cleared by a prior handoff; the update restages it so
    // the link revives.
    expect(fake.rows[0].pdf_path).not.toBe("");
    expect(fake.uploaded.get(fake.rows[0].pdf_path!)).toBeDefined();
  });

  it("403s on a wrong token and leaves the row untouched", async () => {
    const fake = new FakeSupabase([handoffRow({})]);
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/present")
      .field("session_id", "HND001")
      .field("controller_token", "wrong-token")
      .attach("file", realPdf, { filename: "evil.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(403);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].filename).toBe("Old deck");
    expect(fake.uploaded.size).toBe(0);
  });

  it("401s when session_id is given without any controller token", async () => {
    const fake = new FakeSupabase([handoffRow({})]);
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/present")
      .field("session_id", "HND001")
      .attach("file", realPdf, { filename: "deck.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(401);
    expect(fake.rows).toHaveLength(1);
  });

  it("404s on an unknown session instead of creating a new one", async () => {
    const fake = new FakeSupabase([]);
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/present")
      .field("session_id", "NOPE01")
      .field("controller_token", "whatever")
      .attach("file", realPdf, { filename: "deck.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(404);
    expect(JSON.parse(JSON.stringify(res.body)).error).toMatch(/not found or expired/i);
    expect(fake.rows).toHaveLength(0); // no silent create
  });

  it("404s on an expired session", async () => {
    const fake = new FakeSupabase([handoffRow({ status: "expired" })]);
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/present")
      .field("session_id", "HND001")
      .field("controller_token", "handoff-token")
      .attach("file", realPdf, { filename: "deck.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(404);
  });

  it("returns exactly the documented response shape", async () => {
    const fake = new FakeSupabase([handoffRow({})]);
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/present")
      .field("session_id", "HND001")
      .field("controller_token", "handoff-token")
      .attach("file", realPdf, { filename: "v2.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(200);
    // `ok` is an internal discriminant on PresentUpdateResult — it must not
    // leak into the response, which create whitelists and the docs pin down.
    expect(Object.keys(res.body).sort()).toEqual(
      ["filename", "id", "next", "totalSlides", "updated", "url"].sort()
    );
  });

  it("400s when session_id is sent twice instead of silently creating", async () => {
    const fake = new FakeSupabase([handoffRow({})]);
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/present")
      .field("session_id", "HND001")
      .field("session_id", "HND001")
      .field("controller_token", "handoff-token")
      .attach("file", realPdf, { filename: "v2.pdf", contentType: "application/pdf" });

    // Multer hands a repeated field back as an array; reading that as "absent"
    // used to fall through to create — a new id, a new token and a burnt slot.
    expect(res.status).toBe(400);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].filename).toBe("Old deck");
  });

  it("400s when controller_token is sent twice", async () => {
    const fake = new FakeSupabase([handoffRow({})]);
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/present")
      .field("session_id", "HND001")
      .field("controller_token", "handoff-token")
      .field("controller_token", "handoff-token")
      .attach("file", realPdf, { filename: "v2.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(fake.rows).toHaveLength(1);
  });

  it("404s on a session past expires_at that the sweeper has not marked yet", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const fake = new FakeSupabase([handoffRow({ expires_at: past })]);
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/present")
      .field("session_id", "HND001")
      .field("controller_token", "handoff-token")
      .attach("file", realPdf, { filename: "v2.pdf", contentType: "application/pdf" });

    // status is only reconciled hourly, so an expired row can still read active.
    expect(res.status).toBe(404);
    expect(fake.uploaded.size).toBe(0);
  });

  it("updates a synced hosted deck and broadcasts deck_updated", async () => {
    const fake = new FakeSupabase([
      baseRow({ current_slide: 50 }), // clamp into range
    ]);
    fakeEmissions.length = 0;
    const app = appWith(fake);
    const res = await request(app)
      .post("/api/present")
      .field("session_id", "ABC123")
      .field("controller_token", "secret-token")
      .attach("file", realPdf, { filename: "talk-v2.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("ABC123");
    expect(res.body.url).toMatch(/^http:\/\/[^/]+\/s\/ABC123$/);
    expect(fake.rows).toHaveLength(1); // still one slot in use
    expect(fake.rows[0].total_slides).toBeGreaterThan(0);
    expect(fake.rows[0].current_slide).toBeGreaterThan(0);
    expect(fakeEmissions).toContainEqual(
      expect.objectContaining({ room: "ABC123", event: "deck_updated" })
    );
    // A synced deck has no handoff step, so it must not be told to open a
    // handoff link — viewers already reloaded.
    expect(res.body.next).not.toMatch(/hand off/i);
  });
});
