import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";

// "End Presentation?" confirmation shared by desktop and mobile. Both surfaces
// route the actual teardown through the same `onConfirm` (Presentation's
// `endPresentation`), so the local-session cleanup (delete IndexedDB + close the
// viewer window) can't drift between the two.
export function ConfirmEndDialog({
  local,
  onConfirm,
  onClose,
}: {
  local: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <DialogOverlay onClose={onClose}>
      <div className="space-y-2 text-center">
        <h2 className="text-lg font-semibold">End Presentation?</h2>
        <p className="text-sm text-muted-foreground">
          {local
            ? "This will close the viewer window and delete the presentation from this browser. This action cannot be undone."
            : "This will disconnect all viewers and permanently delete the presentation. This action cannot be undone."}
        </p>
      </div>
      <div className="flex gap-2">
        <Button className="flex-1" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button className="flex-1" variant="destructive" onClick={onConfirm}>
          End Presentation
        </Button>
      </div>
    </DialogOverlay>
  );
}
