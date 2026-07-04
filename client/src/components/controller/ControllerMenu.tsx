import type { Deck } from "@/lib/deck";
import { Menu, X, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DownloadStrippedButton } from "@/components/DownloadStrippedButton";

// Mobile slide-over menu. Purely presentational: every action is a callback the
// parent (ControllerView) wires to its single set of dialogs/handlers, so there
// is no duplicated Share/Confirm-End/end-session logic living down here.
export function ControllerMenu({
  open,
  onOpen,
  onClose,
  deck,
  hasPassphrase,
  canShowCode,
  showingCode,
  onShare,
  onToggleCode,
  onShowPassphrase,
  onSwitchToViewer,
  onEndClick,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  deck: Deck;
  hasPassphrase: boolean;
  /** Whether the "show join code on viewers" toggle applies (synced sessions only). */
  canShowCode: boolean;
  showingCode: boolean;
  onShare: () => void;
  onToggleCode: () => void;
  onShowPassphrase: () => void;
  onSwitchToViewer: () => void;
  onEndClick: () => void;
}) {
  // Run an action after dismissing the drawer.
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <>
      <Button size="icon-sm" variant="ghost" onClick={onOpen}>
        <Menu size={20} />
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <div className="absolute top-0 right-0 w-64 h-full bg-background border-l shadow-lg flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="text-sm font-semibold">Menu</span>
              <Button size="icon-sm" variant="ghost" onClick={onClose}>
                <X size={18} />
              </Button>
            </div>
            <div className="flex-1 flex flex-col gap-1 p-2">
              <Button variant="ghost" className="justify-start" onClick={act(onShare)}>
                Share
              </Button>
              {canShowCode && (
                <Button variant="ghost" className="justify-start" onClick={act(onToggleCode)}>
                  <QrCode size={16} className="mr-2" />
                  {showingCode ? "Hide Join Code" : "Show Join Code"}
                </Button>
              )}
              {hasPassphrase && (
                <Button variant="ghost" className="justify-start" onClick={act(onShowPassphrase)}>
                  Passphrase
                </Button>
              )}
              <Button variant="ghost" className="justify-start" onClick={act(onSwitchToViewer)}>
                Switch to Viewer
              </Button>
              <Button variant="ghost" className="justify-start" asChild>
                <a href={deck.url} download>Download PDF</a>
              </Button>
              <DownloadStrippedButton deck={deck} block />
              <div className="flex items-center justify-between px-4 py-2">
                <span className="text-sm">Theme</span>
                <ThemeToggle size="icon" />
              </div>
              <div className="mt-auto">
                <Button variant="destructive" className="w-full" onClick={act(onEndClick)}>
                  End Presentation
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
