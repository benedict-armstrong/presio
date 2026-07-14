import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import type { InspectedAttachment } from "@/lib/inspectAttachments";
import { ValidityBadge } from "./ValidityBadge";

interface Props {
  attachment: InspectedAttachment;
  linkedBinary?: InspectedAttachment;
  onClose: () => void;
}

export function AttachmentModal({ attachment, linkedBinary, onClose }: Props) {
  const blobUrlRef = useRef<string | null>(null);
  const binaryBlobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      if (binaryBlobUrlRef.current) URL.revokeObjectURL(binaryBlobUrlRef.current);
    };
  }, []);

  function openRaw() {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    const blob = new Blob([attachment.content.slice()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function openBinary() {
    if (!linkedBinary) return;
    if (binaryBlobUrlRef.current) URL.revokeObjectURL(binaryBlobUrlRef.current);
    const ext = linkedBinary.filename.split(".").pop()?.toLowerCase() ?? "";
    const mime = ext === "gif" ? "image/gif" : ext === "mp4" ? "video/mp4" : "video/webm";
    const blob = new Blob([linkedBinary.content.slice()], { type: mime });
    const url = URL.createObjectURL(blob);
    binaryBlobUrlRef.current = url;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const isMime = attachment.kind === "media-json";
  const isNotes = attachment.kind === "notes";

  const prettyJson = (() => {
    try {
      return JSON.stringify(attachment.parsed, null, 2);
    } catch {
      return null;
    }
  })();

  return (
    <DialogOverlay onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <ValidityBadge validity={attachment.validity} />
            <h2 className="text-sm font-medium font-mono truncate">{attachment.filename}</h2>
          </div>
          {attachment.slide !== undefined && (
            <p className="text-xs text-muted-foreground mt-0.5">Slide {attachment.slide}</p>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} className="shrink-0 -mt-1 -mr-2">
          ✕
        </Button>
      </div>

      {attachment.issues.length > 0 && (
        <div className="space-y-1">
          {attachment.issues.map((issue, i) => (
            <div
              key={i}
              className={`rounded px-2.5 py-1.5 text-xs ${
                issue.level === "error"
                  ? "bg-red-500/10 text-red-700 dark:text-red-400"
                  : "bg-amber-500/10 text-amber-800 dark:text-amber-400"
              }`}
            >
              <span className="font-medium">{issue.level === "error" ? "Error" : "Warning"}:</span>{" "}
              {issue.message}
            </div>
          ))}
        </div>
      )}

      {isNotes && attachment.previewText !== undefined && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Notes preview</p>
          <div className="rounded bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap">
            {attachment.previewText || <span className="text-muted-foreground italic">(empty)</span>}
          </div>
        </div>
      )}

      {isMime && prettyJson && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Placement data</p>
          <pre className="rounded bg-muted/50 px-3 py-2 text-xs overflow-x-auto">{prettyJson}</pre>
        </div>
      )}

      <div className="flex gap-2 flex-wrap pt-1">
        {isNotes && prettyJson && (
          <Button size="sm" variant="outline" onClick={openRaw}>
            Open raw JSON
          </Button>
        )}
        {isMime && (
          <Button size="sm" variant="outline" onClick={openRaw}>
            Open raw JSON
          </Button>
        )}
        {linkedBinary && (
          <Button size="sm" variant="outline" onClick={openBinary}>
            Open media file
          </Button>
        )}
      </div>
    </DialogOverlay>
  );
}
