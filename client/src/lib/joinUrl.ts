// Join URLs (QR codes + copyable controller/viewer links) are built from
// window.location.origin, which breaks in local deployments: the presenter
// opens Presio via http://localhost:3001, a phone scans the QR, and resolves
// localhost to itself. Browsers can't discover their own LAN address (WebRTC
// ICE probing yields opaque mDNS names on most platforms), so the presenter
// types this machine's address once — persisted in localStorage — and every
// share surface rewrites its links/QR to point at it.
//
// The override only matters when the current page itself is loopback; hosted
// deploys (presio.xyz etc.) are always opened by their real host, so they
// never trigger the UI or rewrite the URLs.

import { useCallback, useState } from "react";
import { lsGetString, lsSetString, lsRemove, STORAGE_KEYS } from "@/lib/storage";

/** Whether this hostname is only reachable from this same device. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    /^127(\.\d+){3}$/.test(hostname) ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/** Whether the share links need rewriting for other devices to reach them,
 *  i.e. the presenter is viewing Presio over localhost/loopback. */
export function needsLanOverride(): boolean {
  return typeof window !== "undefined" && isLoopbackHostname(window.location.hostname);
}

const getLanAddress = () => lsGetString(STORAGE_KEYS.lanAddress);

function setLanAddress(value: string) {
  const trimmed = value.trim();
  if (trimmed) lsSetString(STORAGE_KEYS.lanAddress, trimmed);
  else lsRemove(STORAGE_KEYS.lanAddress);
}

/** The origin share links should point at: the stored LAN address if the
 *  presenter set one, otherwise the page's own origin. Accepts bare hosts
 *  ("192.168.1.20", "mybox.local:3001" — protocol inherited from the current
 *  page) or full URLs; trailing slashes are stripped. */
export function lanOrigin(address = getLanAddress()): string {
  if (!address) return window.location.origin;
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(address)
    ? address
    : `${window.location.protocol}//${address}`;
  return withProto.replace(/\/+$/, "");
}

export function joinUrl(id: string, role: "viewer" | "controller"): string {
  return `${lanOrigin()}/s/${id}?role=${role}`;
}

/** LAN-address state + the join URLs derived from it, for components that show
 *  both the field and the rewritten links/QR together. Reads are live per
 *  render, so surfaces that just display URLs pick up a saved value without
 *  subscribing. */
export function useJoinUrls(id: string) {
  const [address, setAddressState] = useState(() => getLanAddress());
  const setAddress = useCallback((value: string) => {
    setAddressState(value);
    setLanAddress(value);
  }, []);
  const origin = lanOrigin(address);
  return {
    address,
    setAddress,
    viewerUrl: `${origin}/s/${id}?role=viewer`,
    controllerUrl: `${origin}/s/${id}?role=controller`,
  };
}
