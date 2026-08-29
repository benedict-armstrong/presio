import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { DeckWatchMode, DeckWatchStatus } from "@/lib/deckWatcher";
import { PresioLogo } from "@/components/PresioLogo";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
import { DeckControl } from "@/components/controller/DeckControl";

// Shared top bar for both the desktop and mobile controller. The right-hand
// `actions` slot is where the two surfaces differ: a button toolbar on desktop,
// a hamburger menu trigger on mobile.
export function ControllerHeader({
  id,
  local,
  blanked = false,
  showingCode = false,
  compact = false,
  filename = "",
  deckWatchMode = null,
  deckWatchStatus,
  onReplaceDeck,
  onDropDeck,
  onDeckWatchModeChange,
  onDeckWatchApply,
  onDeckWatchResume,
  remoteDeckUpdate = false,
  onRemoteDeckApply,
  actions,
}: {
  id: string;
  local: boolean;
  blanked?: boolean;
  /** Whether the join code / QR is currently shown on all viewers. */
  showingCode?: boolean;
  /** The deck on screen. Shown (and clickable, to swap it) whenever the
   * controller passes a replace handler. */
  filename?: string;
  /** Live-reload preference, or null when this deck can't be watched (a synced
   * deck, or a browser without the File System Access API). */
  deckWatchMode?: DeckWatchMode | null;
  /** Deck file watching status (lib/deckWatcher). */
  deckWatchStatus?: DeckWatchStatus | null;
  onReplaceDeck?: () => void;
  /** A PDF dropped onto the deck name — same swap, without the picker. */
  onDropDeck?: (file: File, handle?: FileSystemFileHandle) => void;
  onDeckWatchModeChange?: (mode: DeckWatchMode) => void;
  onDeckWatchApply?: () => void;
  onDeckWatchResume?: () => void;
  /** A URL-backed deck's source PDF was republished — offer the new version. */
  remoteDeckUpdate?: boolean;
  onRemoteDeckApply?: () => void;
  /** Tighter spacing + bare code (no "Code:" label) for the mobile header. */
  compact?: boolean;
  actions?: ReactNode;
}) {
  const deck = onReplaceDeck && onDeckWatchModeChange && onDeckWatchApply && onDeckWatchResume && (
    <DeckControl
      filename={filename}
      mode={deckWatchMode}
      status={deckWatchStatus ?? null}
      remoteUpdate={remoteDeckUpdate}
      onReplace={onReplaceDeck}
      onDropDeck={onDropDeck}
      onSetMode={onDeckWatchModeChange}
      onApply={onDeckWatchApply}
      onResume={onDeckWatchResume}
      onRemoteApply={onRemoteDeckApply}
    />
  );

  return (
    <div
      className={cn(
        "relative border-b py-2 flex items-center justify-between",
        compact ? "px-3" : "px-4"
      )}
    >
      <div className={cn("flex items-center", compact ? "gap-2" : "gap-3")}>
        <Link
          to="/"
          className="flex items-center gap-1.5 text-sm font-semibold hover:text-muted-foreground transition-colors"
        >
          <PresioLogo className="h-4 w-auto" />
          Presio
        </Link>
        <span className="text-muted-foreground/40">|</span>
        {!local &&
          (compact ? (
            <span className="font-mono font-bold tracking-widest text-sm select-all">{id}</span>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">Code:</span>
              <span className="font-mono font-bold tracking-widest select-all">{id}</span>
            </>
          ))}
        <ConnectionIndicator local={local} />
        {local && (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-500">Local</span>
        )}
        {blanked && (
          <span className="text-xs font-medium text-destructive px-1.5 py-0.5 rounded bg-destructive/10">
            Blanked
          </span>
        )}
        {showingCode && (
          <span className="text-xs font-medium text-primary px-1.5 py-0.5 rounded bg-primary/10">
            Code shown
          </span>
        )}
        {compact && deck}
      </div>
      {/* Desktop centres the deck on the bar itself rather than in the gap
          between its neighbours, so it doesn't drift as the code or the
          badges change width. Out of flow, so the wrapper can't swallow
          clicks meant for the clusters underneath — only the control itself
          takes pointer events. Mobile has no room for a third column, so it
          stays inline in the left cluster above. */}
      {!compact && deck && (
        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2">
          <div className="pointer-events-auto">{deck}</div>
        </div>
      )}
      <div className="flex items-center gap-1">{actions}</div>
    </div>
  );
}
