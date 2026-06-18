import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { SessionQRCode } from "@/components/SessionQRCode";
import { CopyField } from "@/components/CopyField";
import { DownloadStrippedButton } from "@/components/DownloadStrippedButton";
import { endSession } from "@/lib/utils";

function MenuIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" x2="20" y1="12" y2="12" />
      <line x1="4" x2="20" y1="6" y2="6" />
      <line x1="4" x2="20" y1="18" y2="18" />
    </svg>
  );
}

export function MobileControllerMenu({
  id,
  pdf,
  pdfUrl,
  passphrase,
}: {
  id: string;
  pdf: PDFDocumentProxy;
  pdfUrl: string;
  passphrase: string | null;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [passphraseOpen, setPassphraseOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const controllerUrl = `${window.location.origin}/s/${id}?role=controller`;
  const viewerUrl = `${window.location.origin}/s/${id}?role=viewer`;

  return (
    <>
      <Button size="icon-sm" variant="ghost" onClick={() => setOpen(true)}>
        <MenuIcon />
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="absolute top-0 right-0 w-64 h-full bg-background border-l shadow-lg flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="text-sm font-semibold">Menu</span>
              <Button size="icon-sm" variant="ghost" onClick={() => setOpen(false)}>
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </Button>
            </div>
            <div className="flex-1 flex flex-col gap-1 p-2">
              <Button variant="ghost" className="justify-start" onClick={() => { setOpen(false); setShareOpen(true); }}>
                Share
              </Button>
              {passphrase && (
                <Button variant="ghost" className="justify-start" onClick={() => { setOpen(false); setPassphraseOpen(true); }}>
                  Passphrase
                </Button>
              )}
              <Button variant="ghost" className="justify-start" onClick={() => navigate(`/s/${id}?role=viewer`, { replace: true })}>
                Switch to Viewer
              </Button>
              {pdfUrl && (
                <Button variant="ghost" className="justify-start" asChild>
                  <a href={pdfUrl} download>Download PDF</a>
                </Button>
              )}
              <DownloadStrippedButton pdf={pdf} pdfUrl={pdfUrl} block />
              <div className="flex items-center justify-between px-4 py-2">
                <span className="text-sm">Theme</span>
                <ThemeToggle size="icon" />
              </div>
              <div className="mt-auto">
                <Button variant="destructive" className="w-full" onClick={() => { setOpen(false); setConfirmEnd(true); }}>
                  End Presentation
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {shareOpen && (
        <DialogOverlay onClose={() => setShareOpen(false)} maxWidth="max-w-[90%]">
          <SessionQRCode sessionId={id} />
          <div className="space-y-2">
            <CopyField label="Viewer link" value={viewerUrl} />
            <CopyField label="Controller link" value={controllerUrl} />
          </div>
          <Button className="w-full" variant="ghost" onClick={() => setShareOpen(false)}>
            Close
          </Button>
        </DialogOverlay>
      )}

      {passphraseOpen && passphrase && (
        <DialogOverlay onClose={() => setPassphraseOpen(false)} maxWidth="max-w-xs">
          <div className="text-center space-y-3">
            <h2 className="text-lg font-semibold">Controller Passphrase</h2>
            <p className="text-xs text-muted-foreground">
              Share this passphrase to grant controller access
            </p>
            <p className="text-2xl font-bold tracking-widest font-mono select-all">
              {passphrase}
            </p>
            <CopyField label="" value={passphrase} />
          </div>
          <Button className="w-full" variant="ghost" onClick={() => setPassphraseOpen(false)}>
            Close
          </Button>
        </DialogOverlay>
      )}

      {confirmEnd && (
        <DialogOverlay onClose={() => setConfirmEnd(false)}>
          <div className="space-y-2 text-center">
            <h2 className="text-lg font-semibold">End Presentation?</h2>
            <p className="text-sm text-muted-foreground">
              This will disconnect all viewers and permanently delete the
              presentation. This action cannot be undone.
            </p>
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" variant="outline" onClick={() => setConfirmEnd(false)}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              variant="destructive"
              onClick={async () => {
                await endSession(id);
                navigate("/", { replace: true });
              }}
            >
              End Presentation
            </Button>
          </div>
        </DialogOverlay>
      )}
    </>
  );
}
