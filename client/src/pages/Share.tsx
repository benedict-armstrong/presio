import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QRCodeSVG } from "qrcode.react";
import { idbGet } from "@/lib/localStore";
import { useAuth } from "@/lib/useAuth";
import { useClaim } from "@/lib/useClaim";
import { LoginDialog } from "@/components/LoginDialog";
import { SyncShareOverlay } from "@/components/SyncShareOverlay";

export default function Share() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const loggedIn = !!user;
  const { syncing, syncError, sync } = useClaim(id!);

  const [local, setLocal] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  const controllerUrl = `${window.location.origin}/s/${id}?role=controller`;
  const viewerUrl = `${window.location.origin}/s/${id}?role=viewer`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // A PDF in IndexedDB means this is a local session on this device.
        const rec = await idbGet(id!);
        if (rec) {
          if (!cancelled) {
            setLocal(true);
            document.title = `${rec.filename} - Share`;
          }
          return;
        }
        const res = await fetch(`/api/sessions/${id}`);
        if (!res.ok) return;
        const session = await res.json();
        if (!cancelled) {
          setLocal(!!session.local);
          document.title = `${session.filename} - Share`;
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; document.title = "Presio"; };
  }, [id]);

  // Opening the viewer window from this click keeps it within the user gesture,
  // which avoids popup blockers. The controller also re-opens it as a fallback.
  const start = (role: "controller" | "viewer") => {
    window.open(viewerUrl, `presio-viewer-${id}`);
    navigate(`/s/${id}?role=${role}`);
  };

  const syncOnline = async () => {
    if (await sync()) setLocal(false);
  };

  const showOverlay = local;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="pt-6 space-y-6">
          <div className="text-center space-y-4">
            {showOverlay ? (
              <SyncShareOverlay
                id={id!}
                viewerUrl={viewerUrl}
                loggedIn={loggedIn}
                syncing={syncing}
                syncError={syncError}
                onLogin={() => setLoginOpen(true)}
                onSync={syncOnline}
              />
            ) : (
              <>
                <div className="flex justify-center">
                  <QRCodeSVG value={viewerUrl} size={180} className="rounded" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Session Code</p>
                  <p className="text-5xl font-bold tracking-widest font-mono select-all">
                    {id}
                  </p>
                </div>
              </>
            )}

            <p className="text-sm text-muted-foreground">
              {local
                ? "This presentation stays in your browser. Viewers can join in another window or tab on this device and browser — log in and sync to share online."
                : "Share this code or scan the QR to join as a viewer"}
            </p>
          </div>

          {!local && (
            <div className="space-y-3">
              <CopyRow label="Controller link" url={controllerUrl} />
              <CopyRow label="Viewer link" url={viewerUrl} />
            </div>
          )}

          {showOverlay ? (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => start("controller")}
              >
                {loggedIn ? "Keep it local" : "Continue without login"}
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => start("controller")}>
                Start Presentation
              </Button>
              <Button className="flex-1" variant="outline" onClick={() => start("viewer")}>
                Open as Viewer
              </Button>
            </div>
          )}

          <div className="text-center">
            <Link
              to="/"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
            >
              Back to Home
            </Link>
          </div>
        </CardContent>
      </Card>

      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
    </div>
  );
}

function CopyRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex gap-2">
        <code className="flex-1 text-xs bg-muted rounded px-3 py-2 overflow-x-auto select-all">
          {url}
        </code>
        <Button
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
