import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PluginHost } from "@/lib/plugins/host";
import type { LoadedPlugin, PluginManifest, PluginSettingSpec } from "@/lib/plugins/manifest";
import { resolvePluginSettings, setPluginSetting, useSettingsDocument } from "@/lib/settings";
import { addPlugin, removePlugin, setPluginEnabled } from "@/lib/plugins/registry";
import { pluginLabel, type InstalledPlugin } from "@/lib/plugins/installed";
import { PluginButtons } from "./PresenterPlugins";

// Settings for plugins: one page per installed plugin (switch it on or off,
// see what it adds and may do, use its actions, edit its settings) and a page
// to add one by URL. The Settings dialog lists them in its sidebar.

const PERMISSION_LABELS: Record<string, string> = {
  deck: "Reads the deck: its pages and attachments",
  editDeck: "Saves changes into your deck",
};

const SURFACE_LABELS: Record<string, string> = {
  background: "Runs in the background while you present",
  tile: "A card on your dashboard",
  viewer: "A layer on every viewer's screen, including your audience's devices",
  slide: "A layer on the slide, on your current slide and every viewer's screen",
};

/** One plugin's page. */
export function PluginPage({
  plugin,
  host,
  running,
  onEnabled,
}: {
  plugin: InstalledPlugin;
  host: PluginHost;
  /** The plugin as it runs for this deck, if it does: its actions need it. */
  running?: LoadedPlugin;
  /** It was just switched on. */
  onEnabled?: (manifest: PluginManifest) => void;
}) {
  const { entry, manifest, error } = plugin;
  const settings = manifest ? Object.keys(manifest.contributes.settings) : [];
  // Its actions are on this page, so the list of what it adds leaves them out.
  const actions = manifest?.contributes.buttons.filter((b) => b.location === "settings") ?? [];
  const buttons = manifest?.contributes.buttons.filter((b) => b.location !== "settings") ?? [];
  const details = [
    manifest && `v${manifest.version}`,
    manifest?.author && `by ${manifest.author}`,
    entry.builtin ? "built in" : entry.url,
  ].filter(Boolean);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0 text-sm">
          <div className="font-medium">{entry.enabled ? "Enabled" : "Disabled"}</div>
          <div className="text-xs text-muted-foreground truncate">{details.join(" · ")}</div>
        </div>
        <Switch
          checked={entry.enabled}
          label={`Enable ${pluginLabel(plugin)}`}
          testId={`plugin-toggle-${manifest?.id ?? entry.url}`}
          onChange={(on) => {
            setPluginEnabled(entry.url, on);
            if (on && manifest) onEnabled?.(manifest);
          }}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {manifest && (
        <div className="space-y-1.5">
          <h4 className="text-sm font-medium">What it adds</h4>
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-0.5">
            {buttons.map((b) => (
              <li key={b.id}>
                A “{b.label}” button {b.location === "controller.currentSlide" ? "in the current slide's header" : "in the bottom bar"}
              </li>
            ))}
            {manifest.contributes.keybindings.map((k) => (
              <li key={k.command}>A keyboard shortcut: {k.label}</li>
            ))}
            {/* A background part that only serves its buttons or shortcuts
                says nothing those lines didn't already. */}
            {manifest.surfaces
              .filter((s) => s !== "background" || (buttons.length === 0 && manifest.contributes.keybindings.length === 0))
              .map((s) => (
                <li key={s}>{SURFACE_LABELS[s]}</li>
              ))}
            {manifest.permissions.map((p) => (
              <li key={p} className="text-amber-600 dark:text-amber-400">{PERMISSION_LABELS[p] ?? p}</li>
            ))}
          </ul>
        </div>
      )}

      {actions.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Actions</h4>
          <div className="flex flex-wrap gap-2">
            {running ? (
              <PluginButtons host={host} plugins={[running]} location="settings" />
            ) : (
              actions.map((b) => (
                <Button key={b.id} size="sm" variant="outline" disabled>
                  {b.label}
                </Button>
              ))
            )}
          </div>
          {!running && (
            <p className="text-xs text-muted-foreground">
              {entry.enabled ? "Available once it runs for this deck." : "Enable the plugin to use these."}
            </p>
          )}
        </div>
      )}

      {manifest && settings.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium">Settings</h4>
          <PluginSettingsForm manifest={manifest} />
        </div>
      )}

      {!entry.builtin && (
        <Button size="sm" variant="outline" onClick={() => removePlugin(entry.url)}>
          <Trash2 size={14} className="mr-1" />
          Remove plugin
        </Button>
      )}
    </div>
  );
}

/** The page for adding a plugin by URL. */
export function AddPluginPage({ onAdded }: { onAdded?: (url: string, manifest: PluginManifest) => void }) {
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const add = async () => {
    setAdding(true);
    setError("");
    try {
      const added = await addPlugin(url);
      setUrl("");
      onAdded?.(added.url, added.plugin.manifest);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && url) void add(); }}
          placeholder="https://… or http://localhost:5174/"
          data-testid="plugin-url-input"
          className={`flex-1 min-w-0 ${fieldClass}`}
        />
        <Button size="sm" disabled={!url || adding} onClick={add}>
          {adding ? "Adding…" : "Add"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-primary" : "bg-muted-foreground/35"}`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-background shadow transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`}
      />
    </button>
  );
}

/** A plugin's contributed settings, as a form generated from their specs. */
function PluginSettingsForm({ manifest }: { manifest: PluginManifest }) {
  const doc = useSettingsDocument();
  const specs = manifest.contributes.settings;
  const values = resolvePluginSettings(manifest.id, specs, doc);
  return (
    <div className="space-y-4" data-testid={`plugin-settings-${manifest.id}`}>
      {Object.entries(specs).map(([name, spec]) => (
        <SettingField
          key={name}
          id={`${manifest.id}.${name}`}
          spec={spec}
          value={values[name]}
          onChange={(v) => setPluginSetting(manifest.id, name, spec, v)}
        />
      ))}
    </div>
  );
}

const fieldClass =
  "h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function SettingField({
  id,
  spec,
  value,
  onChange,
}: {
  /** The full settings key, shown so it can be found in settings.json. */
  id: string;
  spec: PluginSettingSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = (
    <span className="block min-w-0">
      {spec.description && <span className="block text-sm">{spec.description}</span>}
      <span className="block text-xs font-mono text-muted-foreground">{id}</span>
    </span>
  );

  if (spec.type === "boolean") {
    return (
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          className="mt-1"
          checked={value === true}
          data-testid={`setting-${id}`}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }

  return (
    <label className="block space-y-1.5">
      {label}
      {spec.type === "enum" ? (
        <select
          value={String(value)}
          data-testid={`setting-${id}`}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full ${fieldClass}`}
        >
          {spec.values.map((v, i) => (
            <option key={v} value={v}>{spec.labels?.[i] ?? v}</option>
          ))}
        </select>
      ) : spec.type === "number" ? (
        <input
          type="number"
          // Keyed by the stored value, so an outside change (an import) shows
          // up, while typing stays uncontrolled until the number is valid.
          key={String(value)}
          defaultValue={value === null ? "" : String(value)}
          min={spec.minimum}
          max={spec.maximum}
          data-testid={`setting-${id}`}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            if (raw === "" && spec.default === null) onChange(null);
            else if (raw !== "" && Number.isFinite(Number(raw))) onChange(Number(raw));
          }}
          className={`w-full ${fieldClass}`}
        />
      ) : (
        <input
          type="text"
          key={String(value)}
          defaultValue={String(value ?? "")}
          maxLength={spec.maxLength}
          data-testid={`setting-${id}`}
          onBlur={(e) => onChange(e.target.value)}
          className={`w-full ${fieldClass}`}
        />
      )}
    </label>
  );
}
