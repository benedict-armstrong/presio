import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DNS is the gate the URL safety check turns on, so drive it directly rather
// than depending on what the test machine can resolve.
const resolved = new Map<string, string[]>();
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string, _opts?: unknown) => {
    const addrs = resolved.get(host);
    if (!addrs) throw new Error("ENOTFOUND");
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));

const { isPublicAddress, isSafeRemoteUrl, metaFromHeaders, fetchRemotePdfMeta } = await import(
  "./remotePdf.js"
);

const realFetch = globalThis.fetch;
beforeEach(() => {
  resolved.clear();
  resolved.set("cdn.example.com", ["93.184.216.34"]);
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

type StubResponse = { status: number; headers?: Record<string, string> };

/**
 * Stub `fetch` with a per-URL routing table (so a redirect target answers
 * differently from its source, and HEAD and GET see the same host), recording
 * every request that was actually made.
 */
function stubFetch(routes: Record<string, StubResponse>, fallback?: StubResponse) {
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, method: init?.method ?? "GET" });
    const spec = routes[href] ?? fallback;
    if (!spec) throw new Error(`unexpected fetch: ${href}`);
    return new Response(null, { status: spec.status, headers: spec.headers });
  }) as typeof fetch;
  return calls;
}

describe("isPublicAddress", () => {
  it("rejects loopback, private, link-local and multicast v4", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("rejects loopback, unique-local, link-local and IPv4-mapped v6", () => {
    for (const ip of [
      "::1",
      "0:0:0:0:0:0:0:1", // the same address, written long
      "::",
      "fd00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("accepts ordinary public addresses", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("rejects anything that isn't an IP address", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});

describe("isSafeRemoteUrl", () => {
  it("accepts an https URL resolving to a public address", async () => {
    expect(await isSafeRemoteUrl("https://cdn.example.com/deck.pdf")).toBe(true);
  });

  it("rejects a name resolving to a private address", async () => {
    resolved.set("internal.example.com", ["10.0.0.5"]);
    expect(await isSafeRemoteUrl("https://internal.example.com/deck.pdf")).toBe(false);
  });

  it("rejects a name resolving to the cloud metadata address", async () => {
    resolved.set("evil.example.com", ["169.254.169.254"]);
    expect(await isSafeRemoteUrl("https://evil.example.com/")).toBe(false);
  });

  it("rejects a name that answers with a private address alongside a public one", async () => {
    resolved.set("split.example.com", ["93.184.216.34", "127.0.0.1"]);
    expect(await isSafeRemoteUrl("https://split.example.com/")).toBe(false);
  });

  it("rejects private IP literals without consulting DNS", async () => {
    expect(await isSafeRemoteUrl("https://127.0.0.1:8443/")).toBe(false);
    expect(await isSafeRemoteUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(await isSafeRemoteUrl("https://[::1]/")).toBe(false);
  });

  it("rejects anything that isn't https, and unresolvable names", async () => {
    expect(await isSafeRemoteUrl("http://cdn.example.com/deck.pdf")).toBe(false);
    expect(await isSafeRemoteUrl("file:///etc/passwd")).toBe(false);
    expect(await isSafeRemoteUrl("not a url")).toBe(false);
    expect(await isSafeRemoteUrl("https://nowhere.example.com/")).toBe(false);
  });
});

describe("metaFromHeaders", () => {
  it("reads the validators a host sends", () => {
    const h = new Headers({
      etag: '"abc"',
      "last-modified": "Wed, 27 Aug 2026 10:00:00 GMT",
      "content-length": "48213",
    });
    expect(metaFromHeaders(h, false)).toEqual({
      etag: '"abc"',
      lastModified: "Wed, 27 Aug 2026 10:00:00 GMT",
      contentLength: "48213",
    });
  });

  it("uses empty strings for validators the host omits", () => {
    expect(metaFromHeaders(new Headers(), false)).toEqual({
      etag: "",
      lastModified: "",
      contentLength: "",
    });
  });

  it("takes the total size out of Content-Range on a ranged probe", () => {
    // A 206's own Content-Length is the range size (1 byte), not the file's.
    const h = new Headers({ "content-length": "1", "content-range": "bytes 0-0/48213" });
    expect(metaFromHeaders(h, true).contentLength).toBe("48213");
  });

  it("keeps Content-Length when Content-Range is missing or unparseable", () => {
    expect(metaFromHeaders(new Headers({ "content-length": "1" }), true).contentLength).toBe("1");
    const odd = new Headers({ "content-length": "1", "content-range": "bytes 0-0/*" });
    expect(metaFromHeaders(odd, true).contentLength).toBe("1");
  });
});

describe("fetchRemotePdfMeta", () => {
  it("returns the validators from a HEAD, without a GET", async () => {
    const calls = stubFetch({
      "https://cdn.example.com/deck.pdf": {
        status: 200,
        headers: { etag: '"v1"', "content-length": "10" },
      },
    });
    const meta = await fetchRemotePdfMeta("https://cdn.example.com/deck.pdf");
    expect(meta).toEqual({ etag: '"v1"', lastModified: "", contentLength: "10" });
    expect(calls).toEqual([{ url: "https://cdn.example.com/deck.pdf", method: "HEAD" }]);
  });

  it("falls back to a one-byte ranged GET for hosts that reject HEAD", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      return method === "HEAD"
        ? new Response(null, { status: 405 }) // Method Not Allowed
        : new Response(null, {
            status: 206,
            headers: { etag: '"v1"', "content-range": "bytes 0-0/900" },
          });
    }) as typeof fetch;
    const meta = await fetchRemotePdfMeta("https://cdn.example.com/deck.pdf");
    expect(meta?.contentLength).toBe("900");
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("refuses a URL pointing at a private host outright", async () => {
    const calls = stubFetch({}, { status: 200 });
    expect(await fetchRemotePdfMeta("https://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(calls).toEqual([]); // never even connected
  });

  it("re-validates each redirect hop, so a public host can't bounce to a private one", async () => {
    resolved.set("attacker.example.com", ["93.184.216.34"]);
    const calls = stubFetch(
      {
        "https://attacker.example.com/deck.pdf": {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data/" },
        },
      },
      // Would hand back a validator if the redirect were ever followed.
      { status: 200, headers: { etag: '"leaked"' } }
    );
    expect(await fetchRemotePdfMeta("https://attacker.example.com/deck.pdf")).toBeNull();
    // Only the attacker's own host was ever contacted (once for HEAD, once for
    // the GET fallback); the metadata address was refused before connecting.
    expect(new Set(calls.map((c) => c.url))).toEqual(
      new Set(["https://attacker.example.com/deck.pdf"])
    );
  });

  it("follows a redirect that stays on a public https host", async () => {
    resolved.set("links.example.com", ["93.184.216.34"]);
    const calls = stubFetch({
      "https://links.example.com/d": {
        status: 301,
        headers: { location: "https://cdn.example.com/deck.pdf" },
      },
      "https://cdn.example.com/deck.pdf": { status: 200, headers: { etag: '"v2"' } },
    });
    const meta = await fetchRemotePdfMeta("https://links.example.com/d");
    expect(meta?.etag).toBe('"v2"');
    expect(calls[1].url).toBe("https://cdn.example.com/deck.pdf");
  });

  it("gives up on an endless redirect chain", async () => {
    resolved.set("loop.example.com", ["93.184.216.34"]);
    const calls = stubFetch({
      "https://loop.example.com/x": {
        status: 302,
        headers: { location: "https://loop.example.com/x" },
      },
    });
    expect(await fetchRemotePdfMeta("https://loop.example.com/x")).toBeNull();
    // Bounded, not endless: a handful of hops for HEAD and again for GET.
    expect(calls.length).toBeLessThanOrEqual(10);
  });

  it("returns null when the host errors or is unreachable", async () => {
    stubFetch({}, { status: 500 });
    expect(await fetchRemotePdfMeta("https://cdn.example.com/deck.pdf")).toBeNull();

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await fetchRemotePdfMeta("https://cdn.example.com/deck.pdf")).toBeNull();
  });

  it("never downloads a body", async () => {
    const cancel = vi.fn(async () => {});
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ etag: '"v1"' }),
        body: { cancel },
      }) as unknown as Response) as typeof fetch;
    await fetchRemotePdfMeta("https://cdn.example.com/deck.pdf");
    expect(cancel).toHaveBeenCalled();
  });
});
