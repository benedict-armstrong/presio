import { useState } from "react";
import { needsLanOverride } from "@/lib/joinUrl";

// Editable field for this machine's LAN address, shown on share surfaces only
// when Presio is being viewed over localhost/loopback (see lib/joinUrl.ts).
// Every change rewrites the join links and QR codes on screen immediately; the
// value persists across sessions. Renders nothing when the page was opened by
// a host other devices can already reach — hosted deploys are untouched.

export function LanAddressField({
  value,
  onChange,
}: {
  value: string;
  onChange: (address: string) => void;
}) {
  // Mounted once per share surface; deciding at mount is enough because
  // window.location.hostname can't change without a navigation.
  const [visible] = useState(() => needsLanOverride());
  if (!visible) return null;
  return (
    <div className="space-y-1">
      <label htmlFor="presio-lan-address" className="text-xs font-medium text-muted-foreground">
        This machine&apos;s network address{" "}
        <span className="font-normal">(so other devices can scan)</span>
      </label>
      <input
        id="presio-lan-address"
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="e.g. 192.168.1.20:3001"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}
