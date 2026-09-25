import { useSyncExternalStore } from "react";
import {
  BarChart3,
  Bell,
  Check,
  Download,
  Eye,
  Hand,
  Megaphone,
  MessageSquare,
  PenLine,
  QrCode,
  Sparkles,
  Star,
  Timer,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PluginHost } from "@/lib/plugins/host";
import type { ButtonContribution, ButtonLocation, LoadedPlugin } from "@/lib/plugins/manifest";
import { PluginFrame } from "./PluginFrame";

// The presenter's side of plugins, drawn by Presio from what each plugin
// declares: its tile, its hidden background frame, and its buttons.

const ICONS: Record<string, LucideIcon> = {
  "qr-code": QrCode,
  "bar-chart": BarChart3,
  message: MessageSquare,
  users: Users,
  timer: Timer,
  bell: Bell,
  star: Star,
  sparkles: Sparkles,
  hand: Hand,
  check: Check,
  eye: Eye,
  megaphone: Megaphone,
  pen: PenLine,
  download: Download,
  upload: Upload,
};

/** A plugin's dashboard card. */
export function PluginTile({ host, plugin }: { host: PluginHost; plugin: LoadedPlugin }) {
  return <PluginFrame host={host} plugin={plugin} surface="tile" className="w-full h-full" />;
}

/** Background surfaces: mounted for as long as the deck is open, never shown. */
export function PluginBackgrounds({ host, plugins }: { host: PluginHost; plugins: LoadedPlugin[] }) {
  return (
    <div className="hidden" aria-hidden>
      {plugins
        .filter((p) => p.manifest.surfaces.includes("background"))
        .map((plugin) => (
          <PluginFrame key={plugin.hash} host={host} plugin={plugin} surface="background" />
        ))}
    </div>
  );
}

/** Every plugin's contributed buttons for one place in the interface. */
export function PluginButtons({
  host,
  plugins,
  location,
}: {
  host: PluginHost;
  plugins: LoadedPlugin[];
  location: ButtonLocation;
}) {
  return (
    <>
      {plugins.map((plugin) =>
        plugin.manifest.contributes.buttons.some((b) => b.location === location) ? (
          <PluginButtonGroup key={plugin.hash} host={host} plugin={plugin} location={location} />
        ) : null
      )}
    </>
  );
}

/**
 * Press a plugin's button. One that asks for a file is picked here, by
 * Presio: the click is Presio's, and a plugin's frame couldn't open a file
 * picker on it.
 */
function press(host: PluginHost, pluginId: string, button: ButtonContribution) {
  if (!button.accept) return host.pressButton(pluginId, button.id);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = button.accept;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    host.pressButton(pluginId, button.id, { name: file.name, type: file.type, bytes });
  };
  input.click();
}

function PluginButtonGroup({ host, plugin, location }: { host: PluginHost; plugin: LoadedPlugin; location: ButtonLocation }) {
  const { id, name } = plugin.manifest;
  const states = useSyncExternalStore(host.subscribeButtons, () => host.buttonStates(id));
  return (
    <>
      {plugin.manifest.contributes.buttons
        .filter((b) => b.location === location)
        .map((button) => {
          const state = states[button.id] ?? {};
          const Icon = button.icon ? ICONS[button.icon] : undefined;
          const title = `${button.tooltip ?? state.label ?? button.label} (${name})`;
          if (location === "controller.currentSlide") {
            // A card header's small icon action; the label is its tooltip.
            return (
              <button
                key={button.id}
                type="button"
                disabled={state.disabled}
                aria-pressed={state.active}
                aria-label={state.label ?? button.label}
                data-testid={`plugin-button-${id}-${button.id}`}
                title={title}
                onClick={() => press(host, id, button)}
                className={cn(
                  "inline-flex items-center justify-center h-5 min-w-5 px-0.5 rounded transition-colors disabled:opacity-40",
                  state.active ? "text-foreground bg-accent" : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )}
              >
                {Icon ? <Icon size={13} /> : <span className="text-[11px]">{state.label ?? button.label}</span>}
              </button>
            );
          }
          if (location === "settings") {
            return (
              <Button
                key={button.id}
                variant="outline"
                size="sm"
                disabled={state.disabled}
                data-testid={`plugin-button-${id}-${button.id}`}
                title={button.tooltip}
                onClick={() => press(host, id, button)}
              >
                {Icon && <Icon size={14} className="mr-1" />}
                {state.label ?? button.label}
              </Button>
            );
          }
          return (
            <Button
              key={button.id}
              variant={state.active ? "default" : "ghost"}
              size="sm"
              disabled={state.disabled}
              aria-pressed={state.active}
              data-testid={`plugin-button-${id}-${button.id}`}
              title={title}
              onClick={() => press(host, id, button)}
            >
              {Icon && <Icon size={14} className="mr-1" />}
              {state.label ?? button.label}
            </Button>
          );
        })}
    </>
  );
}
