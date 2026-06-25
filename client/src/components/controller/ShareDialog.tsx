import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { SessionQRCode } from "@/components/SessionQRCode";
import { CopyField } from "@/components/CopyField";
import { SyncShareOverlay } from "@/components/SyncShareOverlay";

// Share overlay shared by desktop and mobile. For a local (not-yet-synced)
// session it prompts the presenter to sync online; otherwise it shows the QR
// code and the viewer/controller links.
export function ShareDialog({
  id,
  viewerUrl,
  controllerUrl,
  local,
  loggedIn,
  syncing,
  syncError,
  onLogin,
  onSync,
  onClose,
  maxWidth = "max-w-[50%]",
}: {
  id: string;
  viewerUrl: string;
  controllerUrl: string;
  local: boolean;
  loggedIn: boolean;
  syncing: boolean;
  syncError: string;
  onLogin: () => void;
  onSync: () => void;
  onClose: () => void;
  maxWidth?: string;
}) {
  return (
    <DialogOverlay onClose={onClose} maxWidth={maxWidth}>
      {local ? (
        <>
          <p className="text-sm text-muted-foreground text-center">
            This presentation is local to this browser. Sync it online to let
            viewers join from any device.
          </p>
          <br />
          <br />
          <SyncShareOverlay
            id={id}
            viewerUrl={viewerUrl}
            loggedIn={loggedIn}
            syncing={syncing}
            syncError={syncError}
            onLogin={onLogin}
            onSync={onSync}
          />
        </>
      ) : (
        <>
          <SessionQRCode sessionId={id} />
          <div className="space-y-2">
            <CopyField label="Viewer link" value={viewerUrl} />
            <CopyField label="Controller link" value={controllerUrl} />
          </div>
        </>
      )}
      <br />
      <br />
      <Button className="w-full" variant="ghost" onClick={onClose}>
        Close
      </Button>
    </DialogOverlay>
  );
}
