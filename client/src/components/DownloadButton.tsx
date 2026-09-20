import { ChevronUp, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDeckDownload } from "@/lib/useDeckDownload";
import type { Deck } from "@/lib/deck";

interface Props {
  deck: Deck;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  /** Render full-width (menu style). */
  block?: boolean;
}

// Split "Download PDF" button. The main action downloads the deck with
// everything in it: the presenter's drawings burned into the pages and any
// embedded attachments kept. The dropdown (opening upward — the button lives
// in bottom bars and menus) offers the same file minus the drawings (i.e. the
// original upload) or minus the attachments (presio's notes/media sidecars).
export function DownloadButton({
  deck,
  className,
  variant = "ghost",
  size = "sm",
  block,
}: Props) {
  const { busy, error, hasDrawing, download } = useDeckDownload(deck);

  return (
    <div className={block ? "w-full flex flex-col gap-1" : "flex flex-col items-end gap-0.5"}>
      <ButtonGroup className={block ? "w-full" : undefined}>
        <Button
          type="button"
          variant={variant}
          size={size}
          onClick={() => download("everything")}
          disabled={busy}
          data-testid="download-pdf"
          className={(block ? "flex-1 justify-start " : "") + (className ?? "")}
        >
          {/* In a menu the label sits in a column of icon + text rows, so it
              needs one too; the bottom bar's inline button reads fine without. */}
          {block && <Download size={16} className="mr-2" />}
          {busy ? "Preparing…" : "Download PDF"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant={variant}
              size={size}
              disabled={busy}
              aria-label="More download options"
              data-testid="download-menu"
              className="px-1.5"
            >
              <ChevronUp size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end">
            <DropdownMenuItem
              disabled={!hasDrawing}
              data-testid="download-no-drawings"
              onSelect={() => download("no-drawings")}
            >
              Without drawings
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!deck.hasAttachments}
              data-testid="download-no-attachments"
              onSelect={() => download("no-attachments")}
            >
              Without attachments
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
