import { useState, useCallback, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfData, renderPage } from "@/lib/pdf";
import { inspectAttachments, type DeckReport, type InspectedAttachment } from "@/lib/inspectAttachments";
import { PresioLogo } from "@/components/PresioLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ValidityBadge, ValidityDot } from "./ValidityBadge";
import { AttachmentModal } from "./AttachmentModal";
import "@/lib/pdf"; // ensure worker is configured

type ModalState = {
  attachment: InspectedAttachment;
  linkedBinary?: InspectedAttachment;
} | null;

export default function CheckerPage() {
  const [filename, setFilename] = useState<string | null>(null);
  const [report, setReport] = useState<DeckReport | null>(null);
  const [thumbs, setThumbs] = useState<Map<number, HTMLCanvasElement>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);

  // Destroy old PDF on new upload
  useEffect(() => {
    return () => { pdfRef.current?.destroy(); };
  }, []);

  const loadFile = useCallback(async (file: File) => {
    if (file.type !== "application/pdf" && !file.name.endsWith(".pdf")) {
      setError("Please upload a PDF file.");
      return;
    }
    setError("");
    setLoading(true);
    setReport(null);
    setThumbs(new Map());
    setFilename(null);
    pdfRef.current?.destroy();

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdf = await loadPdfData(bytes);
      pdfRef.current = pdf;

      const deck = await inspectAttachments(pdf);
      setReport(deck);
      setFilename(file.name);

      // Render thumbnails progressively
      for (let p = 1; p <= pdf.numPages; p++) {
        renderPage(pdf, p, { targetWidth: 400 })
          .then((canvas) => {
            setThumbs((prev) => new Map(prev).set(p, canvas));
          })
          .catch(() => { /* ignore individual render failures */ });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load PDF");
    } finally {
      setLoading(false);
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  }, [loadFile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragging(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragging(false);
  }, []);

  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
    e.target.value = "";
  }, [loadFile]);

  function openAttachment(attachment: InspectedAttachment, linkedBinary?: InspectedAttachment) {
    if (attachment.kind === "media-binary") {
      // Open binary directly
      const ext = attachment.filename.split(".").pop()?.toLowerCase() ?? "";
      const mime = ext === "gif" ? "image/gif" : ext === "mp4" ? "video/mp4" : "video/webm";
      const blob = new Blob([attachment.content.slice()], { type: mime });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return;
    }
    setModal({ attachment, linkedBinary });
  }

  function findLinkedBinary(mediaJson: InspectedAttachment): InspectedAttachment | undefined {
    const m = mediaJson.parsed as Record<string, unknown> | undefined;
    if (!m?.filename || !report) return undefined;
    return report.binaries.get(m.filename as string);
  }

  const reset = useCallback(() => {
    pdfRef.current?.destroy();
    pdfRef.current = null;
    setReport(null);
    setThumbs(new Map());
    setFilename(null);
    setError("");
  }, []);

  const hasReport = report !== null;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2.5">
          <PresioLogo className="h-6 w-6" />
          <span className="text-sm font-medium tracking-tight">Presio</span>
          <span className="text-muted-foreground text-sm">/</span>
          <span className="text-sm text-muted-foreground">Sidecar checker</span>
        </div>
        <div className="flex items-center gap-1">
          <Link
            to="/"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors mr-1"
          >
            Back to app
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 flex flex-col">
        {!hasReport ? (
          /* Upload screen */
          <div className="flex-1 flex flex-col items-center justify-center p-6 gap-6">
            <div className="text-center space-y-1.5 max-w-sm">
              <h1 className="text-xl font-semibold tracking-tight">Inspect sidecar attachments</h1>
              <p className="text-sm text-muted-foreground">
                Upload a Presio PDF to see per-page thumbnails and validate embedded speaker notes and media sidecars.{" "}
                <a
                  href="https://github.com/benedict-armstrong/presio-typst-package"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4 hover:text-foreground transition-colors"
                >
                  Typst package
                </a>
              </p>
            </div>

            <label
              className={`w-full max-w-sm cursor-pointer rounded-xl border-2 border-dashed transition-colors flex flex-col items-center justify-center gap-3 p-10 text-center select-none ${
                dragging
                  ? "border-foreground bg-muted/50"
                  : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30"
              } ${loading ? "pointer-events-none opacity-50" : ""}`}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
            >
              <input
                type="file"
                accept=".pdf,application/pdf"
                className="sr-only"
                onChange={onFileSelect}
                disabled={loading}
              />
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (
                <>
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-muted-foreground"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium">Drop a PDF here</p>
                    <p className="text-xs text-muted-foreground mt-0.5">or click to browse</p>
                  </div>
                </>
              )}
            </label>

            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}

            <p className="text-xs text-muted-foreground">
              The PDF never leaves your browser.
            </p>
          </div>
        ) : (
          /* Overview screen */
          <div className="flex-1 flex flex-col">
            {/* Summary bar */}
            <div className="border-b px-4 py-3 flex items-center gap-3 flex-wrap">
              <button
                onClick={reset}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors mr-1"
              >
                ← New file
              </button>
              <span className="text-sm font-medium truncate max-w-[20ch]">{filename}</span>
              <span className="text-xs text-muted-foreground">{report.pageCount} pages</span>
              <div className="flex items-center gap-2 ml-auto flex-wrap">
                <SummaryChip label="total" count={report.summary.total} />
                {report.summary.valid > 0 && (
                  <SummaryChip label="valid" count={report.summary.valid} validity="valid" />
                )}
                {report.summary.warning > 0 && (
                  <SummaryChip label="warning" count={report.summary.warning} validity="warning" />
                )}
                {report.summary.invalid > 0 && (
                  <SummaryChip label="invalid" count={report.summary.invalid} validity="invalid" />
                )}
                {report.summary.total === 0 && (
                  <span className="text-xs text-muted-foreground">No sidecar attachments found</span>
                )}
              </div>
            </div>

            {/* Page grid */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
                {report.pages.map((pr) => {
                  const thumb = thumbs.get(pr.page);
                  const pageValidity =
                    pr.notes === null && pr.media.length === 0
                      ? null
                      : (() => {
                          const all = [...(pr.notes ? [pr.notes] : []), ...pr.media];
                          if (all.some((a) => a.validity === "invalid")) return "invalid" as const;
                          if (all.some((a) => a.validity === "warning")) return "warning" as const;
                          return "valid" as const;
                        })();

                  return (
                    <div key={pr.page} className="flex flex-col gap-2">
                      {/* Thumbnail */}
                      <div className="relative rounded-lg overflow-hidden bg-muted border aspect-video flex items-center justify-center">
                        {thumb ? (
                          <img
                            src={thumb.toDataURL()}
                            alt={`Page ${pr.page}`}
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">…</span>
                        )}
                        <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                          <span className="text-[10px] bg-black/50 text-white px-1.5 py-0.5 rounded">
                            {pr.page}
                          </span>
                        </div>
                        {pageValidity && (
                          <div className="absolute top-1.5 right-1.5">
                            <ValidityDot validity={pageValidity} />
                          </div>
                        )}
                      </div>

                      {/* Attachment buttons */}
                      {(pr.notes !== null || pr.media.length > 0) && (
                        <div className="flex flex-col gap-1">
                          {pr.notes && (
                            <AttachmentButton
                              label="Notes"
                              validity={pr.notes.validity}
                              issues={pr.notes.issues}
                              onClick={() => openAttachment(pr.notes!)}
                            />
                          )}
                          {pr.media.map((mj, i) => {
                            const m = mj.parsed as Record<string, unknown> | undefined;
                            const id = typeof m?.id === "string" ? m.id.slice(0, 20) : `media-${i + 1}`;
                            const binary = findLinkedBinary(mj);
                            return (
                              <AttachmentButton
                                key={i}
                                label={`Media: ${id}`}
                                validity={mj.validity}
                                issues={mj.issues}
                                onClick={() => openAttachment(mj, binary)}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Orphans */}
              {report.orphans.length > 0 && (
                <div className="mt-8 space-y-2">
                  <h2 className="text-sm font-medium">Unattached files ({report.orphans.length})</h2>
                  {report.orphans.map((a, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <ValidityBadge validity={a.validity} />
                      <span className="text-xs font-mono text-muted-foreground truncate">{a.filename}</span>
                      <button
                        className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground shrink-0"
                        onClick={() => openAttachment(a)}
                      >
                        Inspect
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {modal && (
        <AttachmentModal
          attachment={modal.attachment}
          linkedBinary={modal.linkedBinary}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function SummaryChip({
  label,
  count,
  validity,
}: {
  label: string;
  count: number;
  validity?: "valid" | "warning" | "invalid";
}) {
  const color = validity === "valid"
    ? "text-green-700 dark:text-green-400"
    : validity === "warning"
    ? "text-amber-800 dark:text-amber-400"
    : validity === "invalid"
    ? "text-red-700 dark:text-red-400"
    : "text-muted-foreground";
  return (
    <span className={`text-xs ${color}`}>
      <span className="font-medium">{count}</span> {label}
    </span>
  );
}

function AttachmentButton({
  label,
  validity,
  issues,
  onClick,
}: {
  label: string;
  validity: "valid" | "warning" | "invalid";
  issues: { level: "error" | "warning"; message: string }[];
  onClick: () => void;
}) {
  const firstIssue = issues[0];
  return (
    <button
      onClick={onClick}
      title={firstIssue ? `${firstIssue.level}: ${firstIssue.message}` : undefined}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs text-left w-full transition-colors hover:bg-muted/80 ${
        validity === "invalid"
          ? "bg-red-500/10 text-red-700 dark:text-red-400 hover:bg-red-500/20"
          : validity === "warning"
          ? "bg-amber-500/10 text-amber-800 dark:text-amber-400 hover:bg-amber-500/20"
          : "bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20"
      }`}
    >
      <ValidityDot validity={validity} />
      <span className="truncate">{label}</span>
      {issues.length > 0 && (
        <span className="ml-auto shrink-0 opacity-60">{issues.length}</span>
      )}
    </button>
  );
}
