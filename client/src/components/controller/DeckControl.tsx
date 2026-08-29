import { useCallback, useState, type DragEvent } from "react";
import { FileText, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DeckWatchMode, DeckWatchStatus } from "@/lib/deckWatcher";

// The controller header's deck cluster: what is being presented, and — where
// the browser can watch a file on disk — what happens when it changes.
//
// Two controls, because they're two different questions:
//   • the filename swaps the deck by hand (click to pick a new PDF, or drop
//     one straight onto it)
//   • the chip beside it is live reload: off -> watching -> auto -> off
//
// Everything here is local-deck only; a synced deck has no file on this
// machine to watch, and passing `mode: null` renders just the filename.

const chipBase =
  "text-xs font-medium px-1.5 py-0.5 rounded transition-colors whitespace-nowrap";

interface Chip {
  label: string;
  title: string;
  className: string;
  /** What clicking does — "none" renders plain text instead of a button. */
  action: "none" | "resume" | "apply" | "remote" | "cycle";
  icon?: boolean;
}

function modeChip(mode: DeckWatchMode, status: DeckWatchStatus | null): Chip {
  // Trouble states outrank the mode: there is no point saying "watching" when
  // the grant lapsed or the file went away.
  if (status === "needs-permission") {
    return {
      label: "Resume watching",
      title: "Access to the deck file lapsed — click to resume watching it for recompiles",
      className: "text-amber-600 dark:text-amber-500 bg-amber-500/10 hover:bg-amber-500/20",
      action: "resume",
    };
  }
  if (status === "stopped") {
    return {
      label: "Watch stopped",
      title: "The deck file was moved or deleted — watching stopped",
      className: "text-muted-foreground bg-muted",
      action: "none",
    };
  }
  if (status === "updated") {
    return {
      label: "Deck updated",
      title: "A recompiled version of this deck is ready — click to show it to everyone",
      className: "text-primary bg-primary/10 hover:bg-primary/20",
      action: "apply",
    };
  }
  if (mode === "off") {
    return {
      label: "Live reload off",
      title: "Not watching the deck file — click to watch it for recompiles",
      className: "text-muted-foreground bg-muted hover:bg-muted-foreground/20",
      action: "cycle",
    };
  }
  if (mode === "auto") {
    return {
      label: "Auto reload",
      title: "Recompiles are applied as soon as they land — click to turn live reload off",
      className: "text-emerald-600 dark:text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20",
      action: "cycle",
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
  remoteUpdate = false,
  onReplace,
  onDropDeck,
  onCycleMode,
  onResume,
  onApply,
  onRemoteApply,
}: {
  filename: string;
  /** null when this deck can't be watched (synced deck, or no File System
   *  Access API) — the filename still shows and still swaps the deck. */
  mode: DeckWatchMode | null;
  status: DeckWatchStatus | null;
  /** A URL-backed deck's source PDF was republished. Reported by the server-side
   *  poller rather than the file watcher, but it means the same thing to the
   *  presenter, so it reads as the same chip. */
  remoteUpdate?: boolean;
  onReplace: () => void;
  /** A PDF was dropped on the filename. The handle rides along where the
   *  platform offers one, so a dropped deck stays watchable. */
  onDropDeck?: (file: File, handle?: FileSystemFileHandle) => void;
  onCycleMode: () => void;
  onResume: () => void;
  onApply: () => void;
  onRemoteApply?: () => void;
}) {
  // Dragging a recompiled PDF onto the deck name is the same swap as clicking
  // it, minus the picker. Only armed when a drop handler is wired.
  const [dragging, setDragging] = useState(false);
  const onDragOver = useCallback(
    (e: DragEvent<HTMLButtonElement>) => {
      if (!onDropDeck) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    [onDropDeck]
  );
  const onDrop = useCallback(
    (e: DragEvent<HTMLButtonElement>) => {
      if (!onDropDeck) return;
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file?.type !== "application/pdf") return;
      // Grab the File System Access handle synchronously, before the event is
      // recycled, so a dropped deck stays watchable. Only trusted for a
      // single-item drop: with several, items[0] may not be this file.
      const items = e.dataTransfer.items;
      const item = items.length === 1 ? items[0] : undefined;
      const getHandle = item?.getAsFileSystemHandle?.bind(item);
      if (getHandle) {
        getHandle()
          .then((h) => onDropDeck(file, h?.kind === "file" ? (h as FileSystemFileHandle) : undefined))
          .catch(() => onDropDeck(file));
      } else {
        onDropDeck(file);
      }
    },
    [onDropDeck]
  );

  // Stored names drop the extension (see Home's upload path); the header shows
  // it back, because ".pdf" is what makes this read as the file on disk.
  const label = filename ? (/\.pdf$/i.test(filename) ? filename : `${filename}.pdf`) : "Untitled deck";

  const chip: Chip | null = remoteUpdate
    ? {
        label: "Deck updated",
        title: "A newer version of this deck was published at its source URL — click to show it to everyone",
        className: "text-primary bg-primary/10 hover:bg-primary/20",
        action: "remote",
      }
    : mode
      ? modeChip(mode, status)
      : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onReplace}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        title={`${label} — click to swap in a different PDF${onDropDeck ? ", or drop one here" : ""}`}
        className={cn(
          // h-8 and px-2.5 match the header buttons; md and up widens the
          // padding so the drop target reads as a target, not just another
          // button.
          "flex h-8 min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md border border-dashed px-2.5 text-xs transition-colors md:px-4",
          dragging
            ? "border-primary/60 bg-primary/10 text-foreground"
            : "border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        <FileText size={12} className="shrink-0" />
        <span className="truncate">{label}</span>
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
                  : chip.action === "remote"
                    ? onRemoteApply
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
