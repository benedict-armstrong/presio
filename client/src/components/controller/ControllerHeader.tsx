import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { PresioLogo } from "@/components/PresioLogo";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";

// Shared top bar for both the desktop and mobile controller. The right-hand
// `actions` slot is where the two surfaces differ: a button toolbar on desktop,
// a hamburger menu trigger on mobile.
export function ControllerHeader({
  id,
  local,
  blanked = false,
  showingCode = false,
  compact = false,
  actions,
}: {
  id: string;
  local: boolean;
  blanked?: boolean;
  /** Whether the join code / QR is currently shown on all viewers. */
  showingCode?: boolean;
  /** Tighter spacing + bare code (no "Code:" label) for the mobile header. */
  compact?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className={cn("border-b py-2 flex items-center justify-between", compact ? "px-3" : "px-4")}>
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
      </div>
      <div className="flex items-center gap-1">{actions}</div>
    </div>
  );
}
