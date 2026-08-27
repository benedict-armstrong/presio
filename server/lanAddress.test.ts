import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import type os from "node:os";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "./app.js";
import { FakeSupabase } from "./test/fakeSupabase.js";
import { registerLanAddressRoute } from "./routes/lanAddress.js";
import {
  addressFromEnv,
  defaultRouteAddress,
  isolatedContainer,
  isReachableFromLan,
} from "./lib/lanAddress.js";

const fakeIo = { in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;

type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

const iface = (address: string, internal = false) =>
  [{ address, internal, family: "IPv4", netmask: "", mac: "", cidr: null }] as os.NetworkInterfaceInfo[];

// What a container with its own network namespace sees: itself and nothing else.
const bridged: Interfaces = { lo: iface("127.0.0.1", true), eth0: iface("172.17.0.2") };
// What a container sharing the host's stack sees — including the host's own
// docker bridges, which only exist in the host's namespace.
const hostNetwork: Interfaces = {
  lo: iface("127.0.0.1", true),
  ens160: iface("10.13.0.31"),
  "br-03f14833d2e1": iface("10.0.1.1"),
  tailscale0: iface("100.88.111.41"),
};

describe("addressFromEnv", () => {
  it("takes a bare host as the authority, port and all", () => {
    expect(addressFromEnv({ PRESIO_PUBLIC_HOST: " 192.168.1.20:3001/ " })).toEqual({
      host: "192.168.1.20:3001",
      origin: null,
      source: "env",
    });
  });

  it("normalizes a full URL to an origin", () => {
    expect(addressFromEnv({ PRESIO_PUBLIC_HOST: "https://talks.example.com/x" })).toEqual({
      host: null,
      origin: "https://talks.example.com",
      source: "env",
    });
  });

  it("falls back to PUBLIC_BASE_URL, which hosted deploys already set", () => {
    expect(addressFromEnv({ PUBLIC_BASE_URL: "https://presio.xyz" })?.origin).toBe(
      "https://presio.xyz"
    );
  });

  it("prefers the more specific variable when both are set", () => {
    expect(
      addressFromEnv({ PRESIO_PUBLIC_HOST: "10.0.0.5", PUBLIC_BASE_URL: "https://presio.xyz" })?.host
    ).toBe("10.0.0.5");
  });

  it("ignores an unset or malformed value rather than serving it", () => {
    expect(addressFromEnv({})).toBeNull();
    expect(addressFromEnv({ PRESIO_PUBLIC_HOST: "  " })).toBeNull();
    expect(addressFromEnv({ PRESIO_PUBLIC_HOST: "http://:::" })).toBeNull();
  });
});

describe("isolatedContainer", () => {
  it("declines to answer from a container with its own network namespace", () => {
    // Every address here is the container's; a phone can reach none of them.
    expect(isolatedContainer(bridged, true)).toBe(true);
  });

  it("answers from a container sharing the host's network stack", () => {
    // Seeing the host's docker bridge proves the namespace is the host's.
    expect(isolatedContainer(hostNetwork, true)).toBe(false);
  });

  it("answers when not containerized at all", () => {
    expect(isolatedContainer(bridged, false)).toBe(false);
  });
});

describe("isReachableFromLan", () => {
  it("accepts an ordinary LAN address", () => {
    expect(isReachableFromLan("10.13.0.31", hostNetwork)).toBe(true);
  });

  it("rejects addresses no other device could use", () => {
    expect(isReachableFromLan(null, hostNetwork)).toBe(false);
    expect(isReachableFromLan("0.0.0.0", hostNetwork)).toBe(false);
    expect(isReachableFromLan("127.0.0.1", hostNetwork)).toBe(false);
    expect(isReachableFromLan("169.254.10.2", hostNetwork)).toBe(false);
  });

  it("rejects a route that leaves through a docker bridge", () => {
    // Reachable from containers on this host, useless to a phone.
    expect(isReachableFromLan("10.0.1.1", hostNetwork)).toBe(false);
  });
});

describe("defaultRouteAddress", () => {
  it("returns a single address, not the list of equals interfaces give", async () => {
    // Connecting a UDP socket sends no packets — this is a routing-table lookup.
    // CI runners always have a default route; assert the shape, not the value.
    const address = await defaultRouteAddress();
    expect(address === null || /^\d+\.\d+\.\d+\.\d+$/.test(address)).toBe(true);
  });
});

describe("GET /api/lan-address", () => {
  it("is not exposed on a hosted deployment", async () => {
    // The answer would be meaningless there (the site is reached on its real
    // domain) and handing anonymous callers the origin's internal addressing is
    // a disclosure with no upside. NODE_ENV is "test" here, so devOrLocal is
    // false and the route falls through to the /api JSON 404.
    const app = createApp({
      supabase: new FakeSupabase([]) as unknown as SupabaseClient,
      io: fakeIo,
    });
    const res = await request(app).get("/api/lan-address");
    expect(res.status).toBe(404);
  });

  it("answers in development and PRESIO_MODE=local", async () => {
    const app = express();
    registerLanAddressRoute(app, { enabled: true });
    const res = await request(app).get("/api/lan-address");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("source");
  });
});
