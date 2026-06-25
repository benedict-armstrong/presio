import { useState, useEffect } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { extractSpeakerNotes } from "@/lib/pdf";
import { Button } from "@/components/ui/button";
import { marked } from "marked";
import DOMPurify from "dompurify";

export function SpeakerNotesCard({
  pdf,
  currentSlide,
  editable,
  onSave,
  onRequestLogin,
}: {
  pdf: PDFDocumentProxy;
  currentSlide: number;
  editable: boolean;
  onSave: (slide: number, notes: string) => Promise<void>;
  onRequestLogin: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setEditing(false);
    setError("");
    extractSpeakerNotes(pdf, currentSlide).then(setNotes);
  }, [pdf, currentSlide]);

  const startEdit = () => {
    if (!editable) {
      onRequestLogin();
      return;
    }
    setDraft(notes);
    setError("");
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const next = draft.trim();
      await onSave(currentSlide, next);
      setNotes(next);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save notes");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="h-full flex flex-col gap-2">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add speaker notes (markdown supported)…"
          className="flex-1 min-h-0 w-full resize-none rounded-md border bg-background p-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col"
      onClick={startEdit}
      title={editable ? "Click to edit speaker notes" : "Log in to edit speaker notes"}
    >
      <div className={`flex-1 overflow-y-auto min-h-0 ${editable ? "cursor-text" : ""}`}>
        {notes ? (
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(notes) as string) }}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {editable ? "Click to add speaker notes." : "No speaker notes for this slide."}
          </p>
        )}
      </div>
    </div>
  );
}
