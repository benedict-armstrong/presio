import type { DeckWatchStatus } from "@/lib/deckWatcher";

// One status pill for the controller's header cluster, driven by the deck
// watcher (deckWatcher.ts). Only rendered when the browser can watch files;
// states: watching (idle) -> deck updated (click to apply) -> resume watching
// (permission lost after a reload) -> watch stopped (file moved or deleted).
export function DeckWatchPill({
  status,
  onApply,
  onResume,
}: {
  status: DeckWatchStatus;
  onApply: () => void;
  onResume: () => void;
}) {
  if (status === "updated") {
    return (
      <button
        type="button"
        onClick={onApply}
        title="A recompiled version of this deck was detected on disk — click to show it to everyone"
        className="text-xs font-medium text-primary px-1.5 py-0.5 rounded bg-primary/10 hover:bg-primary/20 transition-colors"
      >
        Deck updated
      </button>
    );
  }
  if (status === "needs-permission") {
    return (
      <button
        type="button"
        onClick={onResume}
        title="Access to the deck file lapsed — click to resume watching it for recompiles"
        className="text-xs font-medium text-amber-600 dark:text-amber-500 px-1.5 py-0.5 rounded bg-amber-500/10 hover:bg-amber-500/20 transition-colors"
      >
        Resume watching
      </button>
    );
  }
  if (status === "stopped") {
    return (
      <span
        title="The deck file was moved or deleted — watching stopped"
        className="text-xs font-medium text-muted-foreground px-1.5 py-0.5 rounded bg-muted"
      >
        Watch stopped
      </span>
    );
  }
  return (
    <span
      title="Watching this deck's file on disk for recompiles"
      className="text-xs font-medium text-emerald-600 dark:text-emerald-500"
    >
      Watching
    </span>
  );
}
