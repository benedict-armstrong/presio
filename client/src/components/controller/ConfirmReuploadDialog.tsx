import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";

// "Looks like a re-upload" prompt shown by the home screen when a dropped or
// browsed PDF matches a presentation this browser already knows about. Offers
// to swap the new bytes in under the same code (the default) or to create a
// separate presentation. Never shown for an explicit replace — the controller's
// "Replace PDF…" and the recents list' Replace button are already deliberate.
export function ConfirmReuploadDialog({
  filename,
  code,
  compared,
  onUpdate,
  onCreate,
  onClose,
}: {
  filename: string;
  code: string;
  /** Whether the file's bytes were actually compared against the stored copy
   * (local decks only). Synced/account decks match on name alone, so the copy
   * mustn't claim the content differs. */
  compared: boolean;
  onUpdate: () => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <DialogOverlay onClose={onClose}>
      <div className="space-y-2 text-center">
        <h2 className="text-lg font-semibold">
          Update &quot;{filename}&quot;?
        </h2>
        <p className="text-sm text-muted-foreground">
          You already have a presentation with this name
          {compared && " and the new file holds different content"}. Updating
          replaces it and keeps the code {code}, so the existing link stays
          live — or create it as a separate presentation.
        </p>
      </div>
      <div className="flex gap-2">
        <Button className="flex-1" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button className="flex-1" variant="outline" onClick={onCreate}>
          Create separate
        </Button>
        <Button className="flex-1" autoFocus onClick={onUpdate}>
          Update
        </Button>
      </div>
    </DialogOverlay>
  );
}
