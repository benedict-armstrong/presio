import { useState, useEffect } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { AArrowDown, AArrowUp } from "lucide-react";
import { extractSpeakerNotes } from "@/lib/pdf";
import { Button } from "@/components/ui/button";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Bounds and step for the notes font-size multiplier.
export const NOTES_SCALE_MIN = 0.75;
export const NOTES_SCALE_MAX = 2.5;
export const NOTES_SCALE_STEP = 0.125;

export function SpeakerNotesCard({
  pdf,
  currentSlide,
  editable,
  onSave,
  onRequestLogin,
  fontScale = 1,
}: {
  pdf: PDFDocumentProxy;
  currentSlide: number;
  editable: boolean;
  onSave: (slide: number, notes: string) => Promise<void>;
  onRequestLogin: () => void;
  /** Multiplier on the default notes text size. */
  fontScale?: number;
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
          style={{ fontSize: `${0.875 * fontScale}rem` }}
          className="flex-1 min-h-0 w-full resize-none rounded-md border bg-background p-2 font-mono outline-none focus:ring-1 focus:ring-ring"
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
            data-testid="speaker-notes"
            className="prose prose-sm dark:prose-invert max-w-none"
            style={{ fontSize: `${0.875 * fontScale}rem` }}
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

// Toolbar action for the notes card: shrink/grow the notes text.
export function NotesSizeAction({
  scale,
  onChange,
}: {
  scale: number;
  onChange: (scale: number) => void;
}) {
  const btn =
    "inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40";
  return (
    <>
      <button
        type="button"
        title="Smaller notes text"
        data-testid="notes-smaller"
        disabled={scale <= NOTES_SCALE_MIN}
        onClick={() => onChange(Math.max(NOTES_SCALE_MIN, scale - NOTES_SCALE_STEP))}
        className={btn}
      >
        <AArrowDown size={13} />
      </button>
      <button
        type="button"
        title="Larger notes text"
        data-testid="notes-larger"
        disabled={scale >= NOTES_SCALE_MAX}
        onClick={() => onChange(Math.min(NOTES_SCALE_MAX, scale + NOTES_SCALE_STEP))}
        className={btn}
      >
        <AArrowUp size={13} />
      </button>
    </>
  );
}
