import { useState } from "react";
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
  converting,
  shareUrlError,
  onShareUrl,
}: {
  id: string;
  viewerUrl: string;
  loggedIn: boolean;
  syncing: boolean;
  syncError: string;
  onLogin: () => void;
  onSync: () => void;
  // "Bring your own storage": convert this local session into a shareable one
  // backed by a PDF the presenter hosts themselves — no login or upload needed.
  converting: boolean;
  shareUrlError: string;
  onShareUrl: (url: string) => void;
}) {
  const [urlMode, setUrlMode] = useState(false);
  const [url, setUrl] = useState("");
  const busy = syncing || converting;

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
        {urlMode ? (
          <form
            className="w-full max-w-xs space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) onShareUrl(url.trim());
            }}
          >
            <input
              type="url"
              autoFocus
              placeholder="https://…/slides.pdf"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex gap-2">
              <Button type="submit" className="flex-1" disabled={busy || !url.trim()}>
                {converting ? "Sharing…" : "Share"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setUrlMode(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
            {shareUrlError && <p className="text-sm text-destructive text-center">{shareUrlError}</p>}
          </form>
        ) : (
          <>
            {loggedIn ? (
              <>
                <Button onClick={onSync} disabled={busy}>
                  {syncing ? "Syncing…" : "Sync online to share"}
                </Button>
                {syncError && <p className="text-sm text-destructive text-center">{syncError}</p>}
              </>
            ) : (
              <Button onClick={onLogin} disabled={busy}>Log in to share</Button>
            )}
            <button
              type="button"
              onClick={() => setUrlMode(true)}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4"
            >
              Host it yourself (paste a URL)
            </button>
          </>
        )}
      </div>
    </div>
  );
}
