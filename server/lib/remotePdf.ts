// Probing the PDF behind a URL-backed presentation for *whether it changed*,
// without downloading it.
//
// This is the one place the server dereferences a URL a visitor supplied
// (`POST /api/sessions/external` takes any well-formed https URL, from anyone),
// so it is also the app's whole SSRF surface. Two rules keep it narrow:
//
//   1. Every hop must resolve entirely to public addresses. A name that
//      resolves to anything loopback/private/link-local is refused, so the
//      probe can't be aimed at a cloud metadata endpoint or an internal service.
//   2. Redirects are followed by hand, https-only, and re-validated at every
//      hop — `redirect: "follow"` would let an attacker-controlled public host
//      bounce the request straight to 169.254.169.254.
//
// Residual risk worth knowing about: validation happens just before the
// connection, not as part of it, so a name that changes answers between the
// two (DNS rebinding) can still slip past. Closing that needs a connect-time
// hook (an undici dispatcher, which would be a new dependency). What leaks in
// that window is bounded to the three validator headers below — never a body.

import { lookup } from "node:dns/promises";
import net from "node:net";

/** Cheap change-detection metadata for a remote PDF: the host's validator
 *  headers, as available. Opaque strings only — the body is never downloaded. */
export interface RemotePdfMeta {
  etag: string;
  lastModified: string;
  contentLength: string;
}

const REMOTE_PROBE_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
// A probe holds a server socket for up to two timeouts (HEAD, then the ranged
// GET fallback). Cap how many can be in flight at once so a burst of polls
// against a slow host can't tie the process up.
const MAX_CONCURRENT_PROBES = 8;

// Address ranges a presentation's PDF can never legitimately live on.
const blocked = new net.BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4"); // carrier-grade NAT
blocked.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local — cloud metadata
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
blocked.addSubnet("192.0.2.0", 24, "ipv4"); // documentation
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
blocked.addSubnet("198.51.100.0", 24, "ipv4"); // documentation
blocked.addSubnet("203.0.113.0", 24, "ipv4"); // documentation
blocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4"); // reserved + broadcast
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6"); // loopback
blocked.addSubnet("fc00::", 7, "ipv6"); // unique-local
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast
blocked.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64
// IPv4-mapped forms (::ffff:127.0.0.1) need no rule of their own: BlockList
// already checks them against the IPv4 rules above. Adding ::ffff:0:0/96
// explicitly would be worse than redundant — it makes *every* plain IPv4
// address match, since BlockList maps those into the same range to compare.

/** Whether a literal IP address is one a public PDF host could have. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  if (family === 6) return !blocked.check(ip, "ipv6");
  return false;
}

/**
 * Whether this URL is safe for the server to dereference: https, and resolving
 * only to public addresses. Every address a name resolves to must be public —
 * a name answering with both a public and a private address is still an attack.
 */
export async function isSafeRemoteUrl(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, ""); // IPv6 literals arrive bracketed
  if (net.isIP(host)) return isPublicAddress(host);
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return false; // unresolvable: nothing to probe
  }
  return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address));
}

export function metaFromHeaders(h: Headers, ranged: boolean): RemotePdfMeta {
  let contentLength = h.get("content-length") ?? "";
  if (ranged) {
    // A 206's Content-Length is the range size, not the file size; the total
    // rides along in Content-Range ("bytes 0-0/48213").
    const total = h.get("content-range")?.split("/")[1];
    if (total && /^\d+$/.test(total)) contentLength = total;
  }
  return {
    etag: h.get("etag") ?? "",
    lastModified: h.get("last-modified") ?? "",
    contentLength,
  };
}

/** One request, following redirects by hand and re-validating each hop. */
async function probe(startUrl: string, method: "HEAD" | "GET"): Promise<Response | null> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isSafeRemoteUrl(url))) return null;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        ...(method === "GET" ? { headers: { Range: "bytes=0-0" } } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    // Release the (at most one-byte) body so the connection is not held open.
    try {
      await res.body?.cancel();
    } catch {
      // Already consumed or not cancelable — nothing to do.
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      try {
        url = new URL(location, url).toString();
      } catch {
        return null;
      }
      continue;
    }
    return res;
  }
  return null; // redirect loop or an unreasonably long chain
}

let inFlight = 0;

/**
 * Probe a remote PDF for its validator headers without downloading it: a HEAD
 * first, falling back to a one-byte ranged GET for hosts that reject HEAD.
 * Returns null when the URL is unsafe to fetch, the host is unreachable or
 * errors, or too many probes are already running — callers degrade to "no
 * change detection" rather than surfacing a failure.
 */
export async function fetchRemotePdfMeta(url: string): Promise<RemotePdfMeta | null> {
  if (inFlight >= MAX_CONCURRENT_PROBES) return null;
  inFlight++;
  try {
    const head = await probe(url, "HEAD");
    if (head?.ok) return metaFromHeaders(head.headers, false);
    // Some hosts and CDNs only route GET; retry with a ranged request.
    const get = await probe(url, "GET");
    if (get?.ok) return metaFromHeaders(get.headers, true);
    return null;
  } finally {
    inFlight--;
  }
}
