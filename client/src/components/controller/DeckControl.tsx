import { FileText, Zap } from "lucide-react";
import type { DeckWatchMode, DeckWatchStatus } from "@/lib/deckWatcher";

// The controller header's deck cluster: what is being presented, and — where
// the browser can watch a file on disk — what happens when it changes.
//
// Two controls, because they're two different questions:
//   • the filename swaps the deck by hand (click to pick a new PDF)
//   • the chip beside it is live reload: off -> watching -> auto -> off
//
// Everything here is local-deck only; a synced deck has no file on this
// machine to watch, and passing `mode: null` renders just the filename.

const chipBase =
  "text-xs font-medium px-1.5 py-0.5 rounded transition-colors whitespace-nowrap";

function modeChip(mode: DeckWatchMode, status: DeckWatchStatus | null) {
  // Trouble states outrank the mode: there is no point saying "watching" when
  // the grant lapsed or the file went away.
  if (status === "needs-permission") {
    return {
      label: "Resume watching",
      title: "Access to the deck file lapsed — click to resume watching it for recompiles",
      className: "text-amber-600 dark:text-amber-500 bg-amber-500/10 hover:bg-amber-500/20",
      action: "resume" as const,
    };
  }
  if (status === "stopped") {
    return {
      label: "Watch stopped",
      title: "The deck file was moved or deleted — watching stopped",
      className: "text-muted-foreground bg-muted",
      action: "none" as const,
    };
  }
  if (status === "updated") {
    return {
      label: "Deck updated",
      title: "A recompiled version of this deck is ready — click to show it to everyone",
      className: "text-primary bg-primary/10 hover:bg-primary/20",
      action: "apply" as const,
    };
  }
  if (mode === "off") {
    return {
      label: "Live reload off",
      title: "Not watching the deck file — click to watch it for recompiles",
      className: "text-muted-foreground bg-muted hover:bg-muted-foreground/20",
      action: "cycle" as const,
    };
  }
  if (mode === "auto") {
    return {
      label: "Auto reload",
      title: "Recompiles are applied as soon as they land — click to turn live reload off",
      className: "text-emerald-600 dark:text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20",
      action: "cycle" as const,
      icon: true,
    };
  }
  return {
    label: "Watching",
    title:
      "Watching this deck's file for recompiles, and asking before swapping — click to apply them automatically",
    className: "text-emerald-600 dark:text-emerald-500 hover:bg-emerald-500/10",
    action: "cycle" as const,
  };
}

export function DeckControl({
  filename,
  mode,
  status,
  onReplace,
  onCycleMode,
  onResume,
  onApply,
}: {
  filename: string;
  /** null when this deck can't be watched (synced deck, or no File System
   *  Access API) — the filename still shows and still swaps the deck. */
  mode: DeckWatchMode | null;
  status: DeckWatchStatus | null;
  onReplace: () => void;
  onCycleMode: () => void;
  onResume: () => void;
  onApply: () => void;
}) {
  const chip = mode ? modeChip(mode, status) : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onReplace}
        title={`${filename || "This deck"} — click to swap in a different PDF`}
        className="flex min-w-0 max-w-[14rem] items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <FileText size={12} className="shrink-0" />
        <span className="truncate">{filename || "Untitled deck"}</span>
      </button>
      {chip &&
        (chip.action === "none" ? (
          <span title={chip.title} className={`${chipBase} ${chip.className}`}>
            {chip.label}
          </span>
        ) : (
          <button
            type="button"
            title={chip.title}
            onClick={
              chip.action === "resume"
                ? onResume
                : chip.action === "apply"
                  ? onApply
                  : onCycleMode
            }
            className={`${chipBase} ${chip.className} inline-flex items-center gap-1`}
          >
            {chip.icon && <Zap size={11} />}
            {chip.label}
          </button>
        ))}
    </span>
  );
}
