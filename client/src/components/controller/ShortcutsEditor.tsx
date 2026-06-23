import { useState, useEffect } from "react";
import {
  KEYMAP_ACTIONS,
  KEYMAP_LABELS,
  formatBinding,
  type Keymap,
  type KeymapAction,
  type KeyBinding,
} from "@/lib/keymap";

export function ShortcutsEditor({
  keymap,
  onChange,
}: {
  keymap: Keymap;
  onChange: (km: Keymap) => void;
}) {
  const [recording, setRecording] = useState<{ action: KeymapAction; index: number } | null>(null);

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const binding: KeyBinding = { key: e.key };
      if (e.metaKey) binding.meta = true;
      const next = { ...keymap };
      const bindings = [...next[recording.action]];
      bindings[recording.index] = binding;
      next[recording.action] = bindings;
      onChange(next);
      setRecording(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording, keymap, onChange]);

  return (
    <div className="space-y-2">
      {KEYMAP_ACTIONS.map((action) => (
        <div key={action} className="flex items-center justify-between">
          <span className="text-sm">{KEYMAP_LABELS[action]}</span>
          <div className="flex items-center gap-1">
            {keymap[action].map((b, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setRecording({ action, index: i })}
                className={`px-2 py-1 text-xs font-mono rounded border min-w-[40px] text-center transition-colors ${recording?.action === action && recording.index === i
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-input hover:border-primary/50"
                  }`}
              >
                {recording?.action === action && recording.index === i
                  ? "..."
                  : formatBinding(b)}
              </button>
            ))}
            {keymap[action].length < 3 && (
              <button
                type="button"
                onClick={() => {
                  const next = { ...keymap, [action]: [...keymap[action], { key: "" }] };
                  onChange(next);
                  setRecording({ action, index: keymap[action].length });
                }}
                className="px-1.5 py-1 text-xs rounded border border-dashed border-input hover:border-primary/50 text-muted-foreground"
              >
                +
              </button>
            )}
            {keymap[action].length > 1 && !recording && (
              <button
                type="button"
                onClick={() => onChange({ ...keymap, [action]: keymap[action].slice(0, -1) })}
                className="px-1.5 py-1 text-xs rounded border border-input hover:border-destructive text-muted-foreground hover:text-destructive"
              >
                −
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
