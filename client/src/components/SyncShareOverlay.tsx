import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";

// The blurred code/QR with a login-or-sync call to action, shared by the share
// screen and the controller's Share dialog so they look identical.
export function SyncShareOverlay({
  id,
  viewerUrl,
  loggedIn,
  syncing,
  syncError,
  onLogin,
  onSync,
}: {
  id: string;
  viewerUrl: string;
  loggedIn: boolean;
  syncing: boolean;
  syncError: string;
  onLogin: () => void;
  onSync: () => void;
}) {
  return (
    <div className="relative">
      <div className="blur-sm pointer-events-none select-none">
        <div className="flex justify-center">
          <QRCodeSVG value={viewerUrl} size={180} className="rounded" />
        </div>
        <div className="space-y-1 mt-4 text-center">
          <p className="text-sm text-muted-foreground">Session Code</p>
          <p className="text-5xl font-bold tracking-widest font-mono select-all">{id}</p>
        </div>
      </div>

      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4">
        {loggedIn ? (
          <>
            <Button onClick={onSync} disabled={syncing}>
              {syncing ? "Syncing…" : "Sync online to share"}
            </Button>
            {syncError && <p className="text-sm text-destructive text-center">{syncError}</p>}
          </>
        ) : (
          <Button onClick={onLogin}>Log in to share</Button>
        )}
      </div>
    </div>
  );
}
