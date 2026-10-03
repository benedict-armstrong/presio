import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportSettings, importSettings } from "@/lib/settings";
import { saveFile } from "@/lib/saveFile";

/**
 * Settings → Settings file: every preference (Presio's and plugins') as one
 * settings.json, to back up or carry to another browser.
 */
export function SettingsFileSection() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  const download = () => saveFile(new Blob([exportSettings()], { type: "application/json" }), "settings.json");

  const load = async (file: File) => {
    try {
      importSettings(await file.text());
      setMessage({ error: false, text: "Settings imported." });
    } catch (e) {
      setMessage({ error: true, text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={download} data-testid="settings-export">
          <Download size={14} className="mr-1" />
          Export
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload size={14} className="mr-1" />
          Import
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          data-testid="settings-import-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void load(file);
            e.target.value = "";
          }}
        />
      </div>
      {message && (
        <p className={`text-xs ${message.error ? "text-destructive" : "text-muted-foreground"}`}>{message.text}</p>
      )}
    </section>
  );
}
