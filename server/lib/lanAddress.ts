import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";

// Which address should a QR code point at when the presenter opened Presio over
// http://localhost:3001?
//
// The browser can't answer that — it has no way to see its own LAN address, and
// WebRTC ICE candidates are deliberately obfuscated to mDNS names. But the
// server is running on the very machine whose address we want, so it can just
// look. Share surfaces ask this endpoint and rewrite their join links with the
// answer, which is why a local presenter no longer has to type an IP.
//
// Two things make this harder than reading os.networkInterfaces():
//
//  1. Machines have several plausible addresses (a Wi-Fi NIC, docker bridges, a
//     Tailscale interface) and nothing in the interface list ranks them. We
//     resolve that by asking the routing table instead — see defaultRouteAddress.
//  2. In a container with its own network namespace (the default for
//     local.docker-compose.yml) every answer is about the container, not the
//     host, and would be useless to a phone. We detect that case and decline
//     rather than hand out a confidently wrong address — see isolatedContainer.

/** RFC 5737 TEST-NET-1: guaranteed never to be routed anywhere real. */
const PROBE_TARGET = "192.0.2.1";

/** Give up on the routing-table lookup well inside any request timeout. */
const PROBE_TIMEOUT_MS = 200;

export type LanAddressSource = "env" | "interface";

export interface LanAddress {
  /** Host to reach this machine on, possibly with a port. The client supplies
   *  its own scheme, and its own port when this carries none — in `npm run dev`
   *  the page lives on Vite's port, not the server's. Null when unknown. */
  host: string | null;
  /** A complete origin, when the deployment configured one and there is nothing
   *  for the client to fill in. Takes precedence over `host`. */
  origin: string | null;
  source: LanAddressSource | null;
  /** Why `host`/`origin` are null, for the client to explain to the presenter. */
  reason?: "containerized" | "no-route";
}

/** An explicitly configured address always wins: it's the only thing that can
 *  be right when the server genuinely can't see the address clients use (a
 *  bridged container, a tunnel, a port-forward). */
export function addressFromEnv(env: NodeJS.ProcessEnv = process.env): LanAddress | null {
  const raw = env.PRESIO_PUBLIC_HOST?.trim() || env.PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      return { host: null, origin: new URL(raw).origin, source: "env" };
    } catch {
      console.error(`Ignoring malformed PRESIO_PUBLIC_HOST/PUBLIC_BASE_URL: ${raw}`);
      return null;
    }
  }
  return { host: raw.replace(/\/+$/, ""), origin: null, source: "env" };
}

/**
 * Whether this process sits in its own network namespace, where every address
 * it can see belongs to the container rather than to the host a phone would
 * have to reach.
 *
 * The tell is the Docker bridge: dockerd creates docker0 (and a br-* per
 * user-defined network) in the *host's* namespace, so a container that can see
 * one is sharing the host's network stack and its addresses are the host's.
 * A bridged container sees only `lo` and its own `eth0`.
 */
export function isolatedContainer(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  containerized = inContainer()
): boolean {
  if (!containerized) return false;
  return !Object.keys(interfaces).some((name) => name === "docker0" || name.startsWith("br-"));
}

function inContainer(): boolean {
  if (fs.existsSync("/.dockerenv")) return true;
  try {
    return /docker|containerd|kubepods/.test(fs.readFileSync("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}

/**
 * The source address the OS would use to reach the outside world, i.e. the
 * machine's address on its primary network.
 *
 * Connecting a UDP socket sends no packets — it only fixes the socket's local
 * endpoint — so this is a pure routing-table lookup with no traffic, no
 * permissions and no dependency on the target existing. It's also the only
 * portable way to *rank* interfaces: os.networkInterfaces() reports a Wi-Fi
 * NIC, four docker bridges and a Tailscale address as equals, and picking the
 * wrong one produces a QR code that silently fails to load.
 */
export function defaultRouteAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: dgram.Socket;
    try {
      socket = dgram.createSocket("udp4");
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed, or never opened — the answer stands either way.
      }
      resolve(value);
    };
    // A machine with no route at all never fires the connect callback.
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    timer.unref?.();
    socket.on("error", () => finish(null));
    try {
      socket.connect(53, PROBE_TARGET, () => {
        try {
          finish(socket.address().address);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

/** Reject addresses no other device could use, including the case where the
 *  default route leaves through a docker bridge rather than a real NIC. */
export function isReachableFromLan(
  address: string | null,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): boolean {
  if (!address || address === "0.0.0.0") return false;
  if (address.startsWith("127.") || address.startsWith("169.254.")) return false;
  return !Object.entries(interfaces).some(
    ([name, addrs]) =>
      (name === "docker0" || name.startsWith("br-") || name.startsWith("veth")) &&
      addrs?.some((a) => a.address === address)
  );
}

export async function detectLanAddress(): Promise<LanAddress> {
  const configured = addressFromEnv();
  if (configured) return configured;
  if (isolatedContainer()) {
    return { host: null, origin: null, source: null, reason: "containerized" };
  }
  const address = await defaultRouteAddress();
  if (!isReachableFromLan(address)) {
    return { host: null, origin: null, source: null, reason: "no-route" };
  }
  return { host: address, origin: null, source: "interface" };
}
