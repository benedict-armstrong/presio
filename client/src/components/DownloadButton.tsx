import { useState } from "react";
import { ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { stripAttachments } from "@/lib/stripAttachments";
import { renderAnnotatedPdf } from "@/lib/annotatedPdf";
import { hasAnyStrokes } from "@/lib/annotations";
import type { Deck } from "@/lib/deck";

export type DownloadMode = "everything" | "no-drawings" | "no-attachments";

// Shared download logic: assembles the requested PDF variant from the deck
// and hands it to the browser. Used by the split button below and by the
// narrow-footer overflow menu.
export function useDeckDownload(deck: Deck) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasDrawing = hasAnyStrokes(deck.annotations);
  const stem = (deck.filename || "slides").replace(/\.pdf$/i, "");

  const download = async (mode: DownloadMode) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let bytes = await deck.pdf.getData();
      let name = `${stem}.pdf`;
      if (mode === "no-attachments" && deck.hasAttachments) {
        bytes = await stripAttachments(bytes);
        name = `${stem}-no-attachments.pdf`;
      }
      if (mode !== "no-drawings" && hasDrawing) {
        bytes = await renderAnnotatedPdf(bytes, deck.annotations);
      }
      // Coerce to a plain ArrayBuffer slice so Blob's BlobPart typing is happy.
      const buf = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a tick before revoking; Safari has been finicky.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, hasDrawing, download };
}

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
