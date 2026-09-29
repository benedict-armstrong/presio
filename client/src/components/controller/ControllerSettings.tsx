import { Check, FileJson, Keyboard, KeyRound, LayoutGrid, Plus, Puzzle, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/CopyField";
import { AccountControl } from "@/components/AccountControl";
import { SettingsFileSection } from "@/components/SettingsFileSection";
import { ShortcutsEditor } from "@/components/controller/ShortcutsEditor";
import { SettingsDialog } from "@/components/controller/SettingsDialog";
import { AddPluginPage, PluginPage } from "@/components/plugins/PluginSettings";
import { authEnabled } from "@/lib/authMode";
import { DEFAULT_KEYMAP, type Keymap } from "@/lib/keymap";
import { LAYOUT_PRESETS, type LayoutForm } from "@/lib/controllerLayout";
import { pluginLabel, pluginPageId, type InstalledPlugin } from "@/lib/plugins/installed";
import type { PluginManifest } from "@/lib/plugins/manifest";
import type { PluginHostState } from "@/lib/plugins/usePluginHost";
import type { ControllerLayoutState } from "@/hooks/useControllerLayout";
import type { PassphraseState } from "@/hooks/usePassphrase";

type PluginShortcuts = NonNullable<React.ComponentProps<typeof ShortcutsEditor>["plugins"]>;

/** The controller's Settings dialog: account, layout, shared control, shortcuts, plugins. */
export function ControllerSettings({
  onClose,
  activeId,
  onActiveChange,
  appVersion,
  layout,
  layoutKeys,
  cardLabel,
  passphrase,
  keymap,
  setKeymap,
  pluginShortcuts,
  installedPlugins,
  plugins,
  showPluginTile,
}: {
  onClose: () => void;
  /** Which page is showing; kept by the caller across opens. */
  activeId: string | undefined;
  onActiveChange: (id: string) => void;
  /** Which build is serving this, for the footer; null shows none. */
  appVersion: string | null;
  layout: ControllerLayoutState;
  /** Every card the Layout page can toggle. */
  layoutKeys: string[];
  cardLabel: (key: string) => string;
  /** Null when there's no co-presenter to hand control to (a local deck). */
  passphrase: PassphraseState | null;
  keymap: Keymap;
  setKeymap: (keymap: Keymap) => void;
  /** Enabled plugins' shortcuts in order: an earlier one wins a shared key. */
  pluginShortcuts: PluginShortcuts;
  installedPlugins: InstalledPlugin[];
  plugins: PluginHostState;
  /** Switching on a plugin with a tile is asking to see it. */
  showPluginTile: (manifest: PluginManifest) => void;
}) {
  return (
    <SettingsDialog
      onClose={onClose}
      activeId={activeId}
      onActiveChange={onActiveChange}
      footer={
        appVersion && (
          <p className="text-xs font-mono text-muted-foreground" data-testid="app-version">
            {appVersion}
          </p>
        )
      }
      categories={[
        ...(authEnabled
          ? [{ id: "account", label: "Account", icon: User, content: <AccountControl variant="section" /> }]
          : []),
        {
          id: "layout",
          label: "Layout",
          icon: LayoutGrid,
          description: "Which cards the dashboard shows, and how they're arranged.",
          content: (
            <div className="space-y-2">
              <div className="space-y-0.5">
                {layoutKeys.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => layout.toggleCard(key)}
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent transition-colors text-left"
                  >
                    <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${layout.visible.has(key) ? "bg-primary border-primary text-primary-foreground" : "border-input"
                      }`}>
                      {layout.visible.has(key) && <Check size={11} strokeWidth={3} />}
                    </span>
                    {cardLabel(key)}
                  </button>
                ))}
              </div>
              <div className="space-y-1.5 pt-1">
                <label
                  htmlFor="layout-preset"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Preset
                </label>
                <select
                  id="layout-preset"
                  // "Custom" isn't a preset you can pick — it is what the field
                  // reads once the cards have been dragged away from one.
                  value={layout.activePreset ?? "custom"}
                  onChange={(e) => layout.applyPreset(e.target.value as LayoutForm)}
                  className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {layout.activePreset === undefined && (
                    <option value="custom" disabled>
                      Custom
                    </option>
                  )}
                  {LAYOUT_PRESETS.map((preset) => (
                    <option key={preset.form} value={preset.form} title={preset.hint}>
                      {preset.label}
                      {preset.form === layout.form ? " (default for this screen)" : ""}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {LAYOUT_PRESETS.find((p) => p.form === layout.activePreset)?.hint ??
                    "Your own arrangement — pick a preset to start over."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={layout.savePreferred}>
                  Save as preferred
                </Button>
                {layout.hasPreferred && (
                  <Button size="sm" variant="outline" onClick={layout.restorePreferred}>
                    Restore preferred
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={layout.reset}>
                  Reset to default
                </Button>
              </div>
            </div>
          ),
        },
        ...(passphrase
          ? [{
            id: "control",
            label: "Shared control",
            icon: KeyRound,
            description: "Share this passphrase to grant controller access.",
            content: (
              <>
                {passphrase.passphrase ? (
                  <CopyField label="" value={passphrase.passphrase} />
                ) : (
                  <div className="space-y-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={passphrase.busy}
                      onClick={passphrase.request}
                    >
                      {passphrase.busy ? "Creating…" : "Create passphrase"}
                    </Button>
                    {passphrase.error && (
                      <p className="text-xs text-destructive">{passphrase.error}</p>
                    )}
                  </div>
                )}
              </>
            ),
          }]
          : []),
        {
          id: "shortcuts",
          label: "Keyboard shortcuts",
          icon: Keyboard,
          action: (
            <Button size="sm" variant="ghost" onClick={() => setKeymap(DEFAULT_KEYMAP)}>
              Reset defaults
            </Button>
          ),
          content: (
            <ShortcutsEditor
              keymap={keymap}
              onChange={setKeymap}
              plugins={pluginShortcuts}
            />
          ),
        },
        {
          id: "file",
          label: "Settings file",
          icon: FileJson,
          description: "All of these settings, plugins' included, as one settings.json — to back up or use in another browser.",
          content: <SettingsFileSection />,
        },
        // One page per installed plugin, then one to add another.
        ...installedPlugins.map((plugin) => ({
          id: pluginPageId(plugin.entry.url),
          group: "Plugins",
          label: pluginLabel(plugin),
          icon: Puzzle,
          dimmed: !plugin.entry.enabled,
          description: plugin.manifest?.description,
          content: (
            <PluginPage
              plugin={plugin}
              host={plugins.host}
              running={plugins.plugins.find((p) => p.url === plugin.entry.url)}
              onEnabled={showPluginTile}
              shortcutsBefore={pluginShortcuts.slice(0, Math.max(0, pluginShortcuts.findIndex((p) => p.id === plugin.manifest?.id)))}
            />
          ),
        })),
        {
          id: "add-plugin",
          group: "Plugins",
          label: "Add plugin",
          icon: Plus,
          description:
            "Load a plugin from its URL — its own site, or your dev server while you build one. Plugins can do anything Presio can, so only add ones you trust.",
          content: (
            <AddPluginPage
              onAdded={(url, manifest) => {
                showPluginTile(manifest);
                onActiveChange(pluginPageId(url));
              }}
            />
          ),
        },
      ]}
    />
  );
}
