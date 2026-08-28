import { useState } from "react";
import { needsLanOverride, type LanStatus } from "@/lib/joinUrl";

// The manual escape hatch for the address other devices join at.
//
// It is deliberately not the primary path: the server resolves the address on
// its own (see lib/joinUrl.ts), so in the ordinary local deployment this
// collapses to a single line confirming where people will join, and the input
// only opens if the presenter asks for it. It presents itself when there's
// nothing shareable to show — the bridged-container case, where nothing inside
// the container can see the host's network — or when the resolved address
// failed its reachability check.
//
// Renders nothing when the page was opened on a host other devices can already
// reach, so hosted deploys never show it.

export function LanAddressField({
  value,
  onChange,
  status,
  origin,
  shareable,
}: {
  value: string;
  onChange: (address: string) => void;
  status: LanStatus;
  origin: string;
  shareable: boolean;
}) {
  // Deciding at mount is enough because window.location.hostname can't change
  // without a navigation.
  const [visible] = useState(() => needsLanOverride());
  const [expanded, setExpanded] = useState(false);
  if (!visible) return null;

  // Don't flash a prompt during the round-trip that usually answers it.
  if (status === "checking" && !expanded) return null;

  if (shareable && status === "ok" && !expanded) {
    return (
      <p className="text-xs text-muted-foreground">
        Other devices join at <span className="font-mono">{origin}</span>{" "}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Change
        </button>
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <label htmlFor="presio-lan-address" className="text-xs font-medium text-muted-foreground">
        This machine&apos;s network address{" "}
        <span className="font-normal">(so other devices can join)</span>
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
      {!shareable && value.trim() ? (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          Only this device can reach that address. Use the one other devices see this machine at.
        </p>
      ) : !shareable ? (
        <p className="text-xs text-muted-foreground">
          Presio couldn&apos;t work out this machine&apos;s address, so there&apos;s nothing to
          share yet — usually because it&apos;s running in a container with its own network. Enter
          the address here, or set <span className="font-mono">PRESIO_PUBLIC_HOST</span> on the
          container.
        </p>
      ) : status === "unreachable" ? (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          Nothing answered at <span className="font-mono">{origin}</span> from this machine. Check
          the address, or whether a firewall is blocking the port.
        </p>
      ) : null}
      <HowToFindIt />
    </div>
  );
}

// Finding a machine's own LAN address is the one part of this the presenter
// can't be walked through by the UI alone, so the commands live here rather
// than in a doc they'd have to go and find. Collapsed by default: it's only
// needed by whoever hasn't done it before.

function HowToFindIt() {
  const [open, setOpen] = useState(false);
  // The port that matters is the one serving this page, not the server's own:
  // under `npm run dev` the client is on Vite's port.
  const port = window.location.port;
  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="underline underline-offset-2 hover:text-foreground"
        aria-expanded={open}
      >
        How do I find it?
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          <p>
            It&apos;s the address of the machine running Presio — the host machine, if it&apos;s in
            a container — on the network the other devices are on, usually starting{" "}
            <span className="font-mono">192.168.</span>, <span className="font-mono">10.</span> or{" "}
            <span className="font-mono">172.</span>
            {port ? (
              <>
                . Add <span className="font-mono">:{port}</span> to whatever you find.
              </>
            ) : (
              "."
            )}
          </p>
          <ul className="space-y-0.5">
            <li>
              <span className="font-medium">macOS</span> —{" "}
              <span className="font-mono">ipconfig getifaddr en0</span> (Wi-Fi;{" "}
              <span className="font-mono">en1</span> if that&apos;s empty), or System Settings ›
              Network › the connected adapter.
            </li>
            <li>
              <span className="font-medium">Windows</span> —{" "}
              <span className="font-mono">ipconfig</span> in PowerShell, then the{" "}
              <span className="font-mono">IPv4 Address</span> of the adapter you&apos;re connected
              on.
            </li>
            <li>
              <span className="font-medium">Linux</span> —{" "}
              <span className="font-mono">hostname -I</span> (the first address), or{" "}
              <span className="font-mono">ip route get 1.1.1.1</span> and read the{" "}
              <span className="font-mono">src</span> address.
            </li>
          </ul>
          <p>
            Phones and laptops must be on the same network — a &ldquo;guest&rdquo; Wi-Fi or client
            isolation will block the connection even with the right address.
          </p>
        </div>
      )}
    </div>
  );
}
