import { describe, it, expect } from "vitest";
import fs from "fs";
import request from "supertest";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import type express from "express";
import { createApp } from "./app.js";
import { FakeSupabase, type SessionRow } from "./test/fakeSupabase.js";

const fakeIo = { in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;

function appWith(fake: FakeSupabase) {
  return createApp({ supabase: fake as unknown as SupabaseClient, io: fakeIo });
}

const future = () => new Date(Date.now() + 86_400_000).toISOString();

// A real PDF — present parses the upload with pdf.js to count pages.
const realPdf = fs.readFileSync("../example/example.pdf");

// The MCP transport answers with an SSE stream; pull the single data payload out.
async function callPresent(app: express.Express, args: Record<string, unknown>) {
  const res = await request(app)
    .post("/mcp")
    .set("Accept", "application/json, text/event-stream")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "present_pdf", arguments: args },
    });
  expect(res.status).toBe(200);
  return res;
}

function toolResult(res: request.Response): { isError?: boolean; text?: string } {
  // Response may arrive as application/json or as a one-event SSE stream.
  if (res.body && Object.keys(res.body).length) {
    return pick(res.body?.result);
  }
  const sse = String(res.text || "");
  const match = sse.match(/^data: (.*)$/m);
  expect(match, "expected an SSE data event").toBeTruthy();
  const body = JSON.parse(match![1]);
  if (body.error) throw new Error(body.error.message);
  return pick(body.result);
}

function pick(result: { isError?: boolean; content?: { type: string; text: string }[] } | undefined) {
  const first = result?.content?.[0];
  return { isError: result?.isError, text: first && "text" in first ? first.text : undefined };
}

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

describe("MCP present_pdf (update in place)", () => {
  it("replaces an existing deck and returns the same link when session_id + controller_token are given", async () => {
    const fake = new FakeSupabase([handoffRow()]);
    const app = appWith(fake);
    const res = await callPresent(app, {
      pdf_base64: realPdf.toString("base64"),
      filename: "v2.pdf",
      session_id: "HND001",
      controller_token: "handoff-token",
    });

    const result = toolResult(res);
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.text!);
    expect(payload.id).toBe("HND001");
    expect(payload.url).toMatch(/\/start\/HND001\?t=handoff-token$/);
    expect(payload.updated).toBe(true);

    // Same row, same token, new bytes — no extra slot consumed.
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].controller_token).toBe("handoff-token");
    expect(fake.rows[0].filename).toBe("v2");
    expect(fake.rows[0].total_slides).toBeGreaterThan(0);
  });

  it("errors without controller_token and leaves the presentation untouched", async () => {
    const fake = new FakeSupabase([handoffRow()]);
    const app = appWith(fake);
    const res = await callPresent(app, {
      pdf_base64: realPdf.toString("base64"),
      session_id: "HND001",
    });

    const result = toolResult(res);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/controller_token is required/i);
    expect(fake.rows[0].filename).toBe("Old deck");
    expect(fake.uploaded.size).toBe(0);
  });

  it("errors on a wrong token instead of overwriting", async () => {
    const fake = new FakeSupabase([handoffRow()]);
    const app = appWith(fake);
    const res = await callPresent(app, {
      pdf_base64: realPdf.toString("base64"),
      session_id: "HND001",
      controller_token: "wrong",
    });

    const result = toolResult(res);
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Not authorized");
    expect(fake.uploaded.size).toBe(0);
  });

  it("errors on an unknown session rather than creating one", async () => {
    const fake = new FakeSupabase([]);
    const app = appWith(fake);
    const res = await callPresent(app, {
      pdf_base64: realPdf.toString("base64"),
      session_id: "NOPE01",
      controller_token: "whatever",
    });

    const result = toolResult(res);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not found or expired/i);
    expect(fake.rows).toHaveLength(0);
  });
});
