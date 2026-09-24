import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";

// Shown when the watcher sees the deck's file recompile. Applying is the same
// swap as "Replace PDF…", so it costs the same things — but here the presenter
// didn't ask for it, so the losses are spelled out rather than assumed known.
// Only ever shown in "prompt" mode; "auto" applies without asking.
export function ConfirmDeckReloadDialog({
  filename,
  source,
  deckEdited,
  busy,
  onConfirm,
  onClose,
}: {
  filename: string;
  /** Where the change came from: the file on disk, or the deck's source URL. */
  source: "watch" | "remote";
  /** Whether edits were saved into this deck in Presio since it was loaded. */
  deckEdited: boolean;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {

  return (
    <DialogOverlay onClose={onClose}>
      <div className="space-y-2 text-center">
        <h2 className="text-lg font-semibold">
          {source === "watch" ? "Deck updated on disk" : "New version published"}
        </h2>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{filename || "This deck"}</span>{" "}
          {source === "watch"
            ? "was recompiled."
            : "changed at its source link."}{" "}
          Showing it swaps the slides for you and everyone watching.
        </p>
        {deckEdited && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            This clears the edits you saved into it here. The new file&apos;s own notes are used instead.
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button className="flex-1" variant="outline" disabled={busy} onClick={onClose}>
          Not now
        </Button>
        <Button className="flex-1" autoFocus disabled={busy} onClick={onConfirm}>
          {busy ? "Updating…" : "Show new version"}
        </Button>
      </div>
    </DialogOverlay>
  );
}
