import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type express from "express";

/**
 * baseUrl reads its configuration once at module load, so each case has to set
 * the env and re-import rather than calling a setter.
 */
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URLS;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  return import("./lib/baseUrl.js");
}

/** Only the two fields baseUrl() touches. */
const req = (host: string, protocol = "https") =>
  ({ protocol, get: (h: string) => (h.toLowerCase() === "host" ? host : undefined) }) as unknown as express.Request;

const ORIGINAL = { ...process.env };

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("baseUrl", () => {
  it("returns the entry matching the request's host", async () => {
    const { baseUrl } = await load({ PUBLIC_BASE_URLS: "https://presio.ch,https://presio.xyz" });
    expect(baseUrl(req("presio.ch"))).toBe("https://presio.ch");
    expect(baseUrl(req("presio.xyz"))).toBe("https://presio.xyz");
  });

  it("falls back to the first entry for an unlisted host rather than echoing it", async () => {
    const { baseUrl } = await load({ PUBLIC_BASE_URLS: "https://presio.ch,https://presio.xyz" });
    // A spoofed Host must not end up in a generated link.
    expect(baseUrl(req("evil.example"))).toBe("https://presio.ch");
  });

  it("matches the host case-insensitively", async () => {
    const { baseUrl } = await load({ PUBLIC_BASE_URLS: "https://presio.ch,https://presio.xyz" });
    expect(baseUrl(req("PRESIO.XYZ"))).toBe("https://presio.xyz");
  });

  it("still accepts the single-value PUBLIC_BASE_URL alias", async () => {
    const { baseUrl } = await load({ PUBLIC_BASE_URL: "https://presio.xyz" });
    expect(baseUrl(req("presio.xyz"))).toBe("https://presio.xyz");
    expect(baseUrl(req("presio.ch"))).toBe("https://presio.xyz");
  });

  it("prefers PUBLIC_BASE_URLS when both are set", async () => {
    const { baseUrl } = await load({
      PUBLIC_BASE_URLS: "https://presio.ch",
      PUBLIC_BASE_URL: "https://old.example",
    });
    expect(baseUrl(req("presio.ch"))).toBe("https://presio.ch");
  });

  it("drops a malformed entry loudly and keeps the valid ones", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { baseUrl } = await load({ PUBLIC_BASE_URLS: "https://presio.ch,not a url,https://presio.xyz" });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("not a url"));
    expect(baseUrl(req("presio.xyz"))).toBe("https://presio.xyz");
    expect(baseUrl(req("presio.ch"))).toBe("https://presio.ch");
  });

  it("normalises entries to bare origins and ignores blanks", async () => {
    const { baseUrl } = await load({ PUBLIC_BASE_URLS: " https://presio.ch/some/path , , https://presio.xyz/ " });
    expect(baseUrl(req("presio.ch"))).toBe("https://presio.ch");
    expect(baseUrl(req("presio.xyz"))).toBe("https://presio.xyz");
  });

  it("keeps a non-default port as part of the host match", async () => {
    const { baseUrl } = await load({ PUBLIC_BASE_URLS: "http://localhost:3001" });
    expect(baseUrl(req("localhost:3001", "http"))).toBe("http://localhost:3001");
  });

  it("falls back to the request origin when nothing is configured", async () => {
    const { baseUrl } = await load({});
    // Local / LAN use: the hostname isn't knowable at startup.
    expect(baseUrl(req("192.168.1.20:3001", "http"))).toBe("http://192.168.1.20:3001");
  });
});

describe("canonicalBaseUrl", () => {
  it("is always the first entry, whichever domain was asked", async () => {
    const { canonicalBaseUrl } = await load({ PUBLIC_BASE_URLS: "https://presio.ch,https://presio.xyz" });
    expect(canonicalBaseUrl(req("presio.ch"))).toBe("https://presio.ch");
    expect(canonicalBaseUrl(req("presio.xyz"))).toBe("https://presio.ch");
  });

  it("falls back to the request origin when nothing is configured", async () => {
    const { canonicalBaseUrl } = await load({});
    expect(canonicalBaseUrl(req("localhost:3001", "http"))).toBe("http://localhost:3001");
  });
});
