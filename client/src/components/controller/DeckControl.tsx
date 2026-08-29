import { useCallback, useState, type DragEvent, type ReactNode } from "react";
import { ChevronDown, FileText, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DeckWatchMode, DeckWatchStatus } from "@/lib/deckWatcher";

// The controller header's deck cluster: what is being presented, and — where
// the browser can watch a file on disk — what happens when it changes.
//
// One button group, three jobs:
//   • the filename swaps the deck by hand (click to pick a new PDF, or drop
//     one straight onto it)
//   • a light beside it reports live reload at a glance: pulsing green while
//     watching, a bolt on auto, grey when off. Clicking it picks the mode.
//   • a recompile that is ready to show is the one thing that can't wait in a
//     menu, so it appears as its own button and applies on click.
//
// Watching is local-deck only; a synced deck has no file on this machine to
// watch, and passing `mode: null` renders just the filename.

const MODES: { value: DeckWatchMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Ignore changes to the file" },
  { value: "prompt", label: "Watch and ask", hint: "Offer each recompile before it goes up" },
  { value: "auto", label: "Auto reload", hint: "Show recompiles as soon as they land" },
];

type Tone = "green" | "amber" | "muted";

const dotTone: Record<Tone, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  muted: "bg-muted-foreground/60",
};

// A pulse means "this is live right now" — reserved for watching, so a glance
// at a still dot is enough to know nothing is being watched.
function WatchDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0">
      {pulse && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
            dotTone[tone]
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", dotTone[tone])} />
    </span>
  );
}

// What the light says. Trouble outranks the mode: there is no point showing a
// healthy green pulse when the grant lapsed or the file went away.
function watchLight(
  mode: DeckWatchMode,
  status: DeckWatchStatus | null
): { icon: ReactNode; title: string; note?: string } {
  if (status === "needs-permission") {
    return {
      icon: <WatchDot tone="amber" />,
      title: "Access to the deck file lapsed — resume watching it for recompiles",
      note: "Access to this file lapsed.",
    };
  }
  if (status === "stopped") {
    return {
      icon: <WatchDot tone="muted" />,
      title: "The deck file was moved or deleted — watching stopped",
      note: "The file was moved or deleted.",
    };
  }
  if (mode === "auto") {
    return {
      icon: <Zap size={12} className="text-emerald-600 dark:text-emerald-500" />,
      title: "Auto reload: recompiles are applied as soon as they land",
    };
  }
  if (mode === "prompt") {
    return {
      icon: <WatchDot tone="green" pulse />,
      title: "Watching this deck's file for recompiles, and asking before swapping",
    };
  }
  return {
    icon: <WatchDot tone="muted" />,
    title: "Not watching the deck file for recompiles",
  };
}

export function DeckControl({
  filename,
  mode,
  status,
  remoteUpdate = false,
  onReplace,
  onDropDeck,
  onSetMode,
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
   *  presenter, so it reads as the same button. */
  remoteUpdate?: boolean;
  onReplace: () => void;
  /** A PDF was dropped on the filename. The handle rides along where the
   *  platform offers one, so a dropped deck stays watchable. */
  onDropDeck?: (file: File, handle?: FileSystemFileHandle) => void;
  onSetMode: (mode: DeckWatchMode) => void;
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

  // A watched recompile and a republished URL are different sources with the
  // same answer for the presenter, so they share one button.
  const pending = remoteUpdate || status === "updated";
  const applyPending = remoteUpdate ? onRemoteApply : onApply;
  const light = mode ? watchLight(mode, status) : null;

  return (
    <ButtonGroup className="min-w-0">
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

      {pending && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={applyPending}
          title={
            remoteUpdate
              ? "A newer version of this deck was published at its source URL — click to show it to everyone"
              : "A recompiled version of this deck is ready — click to show it to everyone"
          }
          className="h-8 border-primary/30 bg-primary/10 text-xs font-medium text-primary hover:bg-primary/20 hover:text-primary"
        >
          Deck updated
        </Button>
      )}

      {light && mode && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              title={`${light.title} — click to change`}
              className="h-8 gap-1 px-2 text-muted-foreground hover:text-foreground"
            >
              {light.icon}
              <ChevronDown size={12} className="opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {light.note ?? "Live reload"}
            </DropdownMenuLabel>
            {status === "needs-permission" && (
              <>
                <DropdownMenuItem onSelect={onResume}>Resume watching</DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuRadioGroup
              value={mode}
              onValueChange={(value) => onSetMode(value as DeckWatchMode)}
            >
              {MODES.map((m) => (
                <DropdownMenuRadioItem key={m.value} value={m.value} className="items-start">
                  <span className="flex flex-col gap-0.5">
                    <span>{m.label}</span>
                    <span className="text-xs text-muted-foreground">{m.hint}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </ButtonGroup>
  );
}
