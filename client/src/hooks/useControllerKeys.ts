import { useEffect } from "react";
import { isEditableTarget, matchesBinding, pluginBindings, type Keymap } from "@/lib/keymap";
import type { PluginHost } from "@/lib/plugins/host";
import type { PluginHostState } from "@/lib/plugins/usePluginHost";
import { useLatestRef } from "./useLatestRef";

export interface ControllerKeys {
  keymap: Keymap;
  currentSlide: number;
  totalSlides: number;
  onGoTo: (slide: number) => void;
  onBlankToggle: () => void;
  jump: {
    pendingJump: string | null;
    armJump: (digits: string) => void;
    commitJump: (digits: string) => void;
    cancelJump: () => void;
  };
  plugins: PluginHostState["plugins"];
  pluginHost: PluginHost;
}

/**
 * The controller's keyboard shortcuts: Presio's own bindings, then running
 * plugins' keybindings. Subscribed once; everything it acts on is read at
 * keypress time, so a slide change or a typed digit doesn't re-subscribe it.
 */
export function useControllerKeys(keys: ControllerKeys) {
  const ref = useLatestRef(keys);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const { keymap, currentSlide, totalSlides, onGoTo, onBlankToggle, jump, plugins, pluginHost } = ref.current;
      // While armed, every keystroke belongs to the jump: digits accumulate,
      // Enter commits, and anything else cancels rather than firing its own
      // shortcut halfway through a page number.
      if (jump.pendingJump !== null) {
        // A bare modifier press isn't a decision either way.
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
        e.preventDefault();
        if (/^[0-9]$/.test(e.key)) jump.armJump(jump.pendingJump + e.key);
        else if (e.key === "Enter") jump.commitJump(jump.pendingJump);
        else jump.cancelJump();
        return;
      }
      if (matchesBinding(e, keymap.jumpToSlide)) {
        e.preventDefault();
        jump.armJump("");
      } else if (matchesBinding(e, keymap.firstSlide)) {
        e.preventDefault();
        onGoTo(1);
      } else if (matchesBinding(e, keymap.lastSlide)) {
        e.preventDefault();
        onGoTo(totalSlides);
      } else if (matchesBinding(e, keymap.nextSlide)) {
        e.preventDefault();
        onGoTo(currentSlide + 1);
      } else if (matchesBinding(e, keymap.prevSlide)) {
        e.preventDefault();
        onGoTo(currentSlide - 1);
      } else if (matchesBinding(e, keymap.toggleBlank)) {
        onBlankToggle();
      } else if (!e.repeat) {
        // Plugins' keybindings, after Presio's own: a key both claim is ours.
        for (const plugin of plugins) {
          const { id: pluginId, contributes } = plugin.manifest;
          const hit = contributes.keybindings.find((kb) => matchesBinding(e, pluginBindings(keymap, pluginId, kb)));
          if (hit) {
            e.preventDefault();
            pluginHost.runCommand(pluginId, hit.command);
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [ref]);
}
