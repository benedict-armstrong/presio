import { QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authEnabled } from "@/lib/authMode";

// What the share surfaces show for a deck that is still local to this browser.
//
// There is no code to show: a local deck has no `sessions` row, so nothing has
// minted one — sharing is what creates it. This used to render the id blurred
// out behind the call to action, which stood in for a code that was never
// meaningful (and, now, never existed). An empty state says the true thing.
export function ShareEmptyState({
  loggedIn,
  syncing,
  syncError,
  onLogin,
  onSync,
}: {
  loggedIn: boolean;
  syncing: boolean;
  syncError: string;
  onLogin: () => void;
  onSync: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed px-4 py-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <QrCode size={40} className="text-muted-foreground/40" strokeWidth={1.5} />
        <p className="text-sm font-medium">No join code yet</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          {authEnabled
            ? "This deck lives in this browser. Syncing it online creates a code and QR that viewers can join from any device."
            : "This deck lives in this browser. Sharing it on your network creates a code and QR that other devices here can join."}
        </p>
      </div>

      {!authEnabled ? (
        // Offline build: no accounts, but the server can still host the deck
        // for other devices on the same network. Uploading it flips the
        // session to server-hosted so LAN viewers can fetch the PDF.
        <>
          <Button onClick={onSync} disabled={syncing}>
            {syncing ? "Sharing…" : "Share on this network"}
          </Button>
          {syncError && <p className="text-sm text-destructive text-center">{syncError}</p>}
        </>
      ) : loggedIn ? (
        <>
          <Button onClick={onSync} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync online to share"}
          </Button>
          {syncError && <p className="text-sm text-destructive text-center">{syncError}</p>}
        </>
      ) : (
        <Button onClick={onLogin} disabled={syncing}>Log in to share</Button>
      )}
    </div>
  );
}
