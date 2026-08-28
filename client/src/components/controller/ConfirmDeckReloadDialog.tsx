import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";

// Shown when the watcher sees the deck's file recompile. Applying is the same
// swap as "Replace PDF…", so it costs the same things — but here the presenter
// didn't ask for it, so the losses are spelled out rather than assumed known.
// Only ever shown in "prompt" mode; "auto" applies without asking.
export function ConfirmDeckReloadDialog({
  filename,
  annotatedSlides,
  notesEdited,
  busy,
  onConfirm,
  onClose,
}: {
  filename: string;
  /** How many slides carry drawings right now (0 = nothing to lose). */
  annotatedSlides: number;
  /** Whether speaker notes were edited in Presio since this deck was loaded. */
  notesEdited: boolean;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const losses: string[] = [];
  if (annotatedSlides > 0) {
    losses.push(
      `your drawings on ${annotatedSlides} ${annotatedSlides === 1 ? "slide" : "slides"}`
    );
  }
  if (notesEdited) losses.push("the speaker notes you edited here");

  return (
    <DialogOverlay onClose={onClose}>
      <div className="space-y-2 text-center">
        <h2 className="text-lg font-semibold">Deck updated on disk</h2>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{filename || "This deck"}</span> was
          recompiled. Showing it swaps the slides for you and everyone watching.
        </p>
        {losses.length > 0 && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            This clears {losses.join(" and ")}. The new file&apos;s own notes are used instead.
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
