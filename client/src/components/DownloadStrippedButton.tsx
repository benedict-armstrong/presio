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

interface Props {
  deck: Deck;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  /** Render full-width (mobile menu style). */
  block?: boolean;
}

// Renders a "Download without attachments" split button, but only if the PDF
// has any embedded files. The main button strips the attachments on click and
// triggers a browser download; the attached dropdown (opening upward, the
// button lives in bottom bars) offers the same download with or without the
// presenter's drawings burned into the pages.
export function DownloadStrippedButton({
  deck,
  className,
  variant = "ghost",
  size = "sm",
  block,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!deck.hasAttachments) return null;

  const hasDrawing = hasAnyStrokes(deck.annotations);

  const download = async (withDrawings: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let { blob } = await stripAttachments(deck.url);
      if (withDrawings) {
        const bytes = await renderAnnotatedPdf(
          new Uint8Array(await blob.arrayBuffer()),
          deck.annotations
        );
        const buf = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer;
        blob = new Blob([buf], { type: "application/pdf" });
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const base = deck.url.split("/").pop()?.split("?")[0] || "slides.pdf";
      const stem = base.replace(/\.pdf$/i, "");
      a.download = `${stem}-no-attachments${withDrawings ? "-drawings" : ""}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a tick before revoking; Safari has been finicky.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to strip PDF");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={block ? "w-full flex flex-col gap-1" : "flex flex-col items-end gap-0.5"}>
      <ButtonGroup className={block ? "w-full" : undefined}>
        <Button
          type="button"
          variant={variant}
          size={size}
          onClick={() => download(false)}
          disabled={busy}
          className={(block ? "flex-1 justify-start " : "") + (className ?? "")}
        >
          {busy ? "Stripping…" : "Download without attachments"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant={variant}
              size={size}
              disabled={busy}
              aria-label="More download options"
              className="px-1.5"
            >
              <ChevronUp size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end">
            <DropdownMenuItem onSelect={() => download(false)}>
              Without drawings
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!hasDrawing} onSelect={() => download(true)}>
              With drawings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
