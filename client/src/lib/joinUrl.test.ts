// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  composeOrigin,
  fetchLanOrigin,
  isLoopbackHostname,
  isShareableOrigin,
  lanOrigin,
  probeOrigin,
  resolveStatus,
} from "./joinUrl";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isLoopbackHostname", () => {
  it("recognizes every form a local page is served under", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHostname(host)).toBe(true);
    }
  });

  it("treats LAN and public hosts as already reachable", () => {
    for (const host of ["192.168.1.20", "presio.xyz", "mybox.local", "10.0.0.5"]) {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  });
});

describe("lanOrigin", () => {
  it("inherits the page's scheme for a bare host", () => {
    expect(lanOrigin("192.168.1.20:3001")).toBe("http://192.168.1.20:3001");
  });

  it("keeps an explicit scheme and strips trailing slashes", () => {
    expect(lanOrigin("https://mybox.local:8443//")).toBe("https://mybox.local:8443");
  });

  it("falls back to the page's own origin when nothing is set", () => {
    expect(lanOrigin("")).toBe(window.location.origin);
  });
});

describe("composeOrigin", () => {
  const loc = { protocol: "http:", port: "5173" };

  it("borrows the page's port, because that's what the QR has to reach", () => {
    // The server deliberately reports no port: under `npm run dev` it listens
    // on 3001 while the page the QR points at is served by Vite on 5173.
    expect(composeOrigin({ host: "192.168.1.20" }, loc)).toBe("http://192.168.1.20:5173");
  });

  it("respects a port the deployment configured explicitly", () => {
    expect(composeOrigin({ host: "192.168.1.20:3001" }, loc)).toBe("http://192.168.1.20:3001");
  });

  it("omits the port on a default-port page", () => {
    expect(composeOrigin({ host: "presio.local" }, { protocol: "https:", port: "" })).toBe(
      "https://presio.local"
    );
  });

  it("prefers a fully configured origin over any host", () => {
    expect(composeOrigin({ host: "192.168.1.20", origin: "https://talks.example.com/" }, loc)).toBe(
      "https://talks.example.com"
    );
  });

  it("returns null when the server had no answer", () => {
    expect(composeOrigin({ host: null, origin: null, reason: "containerized" }, loc)).toBeNull();
    expect(composeOrigin(null, loc)).toBeNull();
  });
});

describe("isShareableOrigin", () => {
  it("rejects loopback origins, which is what the share screen hides on", () => {
    // Handing these to another device sends it back to itself.
    for (const origin of ["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001"]) {
      expect(isShareableOrigin(origin)).toBe(false);
    }
  });

  it("accepts anything another device could reach", () => {
    expect(isShareableOrigin("http://192.168.1.20:3001")).toBe(true);
    expect(isShareableOrigin("https://presio.xyz")).toBe(true);
    expect(isShareableOrigin("http://mybox.local:3001")).toBe(true);
  });

  it("treats an unparseable origin as not shareable", () => {
    expect(isShareableOrigin("not a url")).toBe(false);
  });
});

describe("fetchLanOrigin", () => {
  it("treats the 404 from a hosted deployment as 'no answer'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await fetchLanOrigin()).toBeNull();
  });

  it("never throws when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await fetchLanOrigin()).toBeNull();
  });
});

describe("probeOrigin", () => {
  it("reports reachable when the connection is made", async () => {
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeOrigin("http://192.168.1.20:3001")).toBe(true);
    // no-cors keeps this independent of CORS and of what the target serves.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ mode: "no-cors" });
  });

  it("reports unreachable when it isn't — a firewall drop or a stale address", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await probeOrigin("http://192.168.1.20:3001")).toBe(false);
  });
});

describe("resolveStatus", () => {
  const base = { override: true, typed: "", detected: undefined, candidate: null, probe: null };

  it("short-circuits on a page other devices can already reach", () => {
    expect(resolveStatus({ ...base, override: false })).toBe("ok");
  });

  it("waits rather than warning while the lookup is in flight", () => {
    expect(resolveStatus(base)).toBe("checking");
  });

  it("asks for an address only once it knows it has none", () => {
    expect(resolveStatus({ ...base, detected: null })).toBe("unavailable");
  });

  it("reports a verified address as ok", () => {
    const candidate = "http://192.168.1.20:3001";
    expect(
      resolveStatus({
        ...base,
        detected: candidate,
        candidate,
        probe: { origin: candidate, reachable: true },
      })
    ).toBe("ok");
  });

  it("warns when the address it has failed verification", () => {
    const candidate = "http://192.168.1.20:3001";
    expect(
      resolveStatus({
        ...base,
        detected: candidate,
        candidate,
        probe: { origin: candidate, reachable: false },
      })
    ).toBe("unreachable");
  });

  it("ignores a result belonging to a previous candidate", () => {
    // Typing a new address must not inherit the old one's verdict.
    expect(
      resolveStatus({
        ...base,
        typed: "10.0.0.9",
        candidate: "http://10.0.0.9",
        probe: { origin: "http://192.168.1.20:3001", reachable: false },
      })
    ).toBe("checking");
  });
});
