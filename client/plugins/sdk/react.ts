// React glue for built-in plugins: re-render on whatever presio reports, and
// mount the plugin into the document build.ts gives it.

import { useCallback, useEffect, useReducer, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./base.css";

/** presio, re-rendering the caller whenever the slide, context (session,
 *  role, theme), settings or storage change. */
export function usePresio(): Presio {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const offs = [
      presio.slide.onChange(rerender),
      presio.onContextChange(rerender),
      presio.settings.onChange(rerender),
      presio.storage.onChange(rerender),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  return presio;
}

/**
 * One presio.storage value, and a setter that re-renders straight away:
 * storage.onChange only reports other surfaces' changes, not this one's own.
 */
export function useStorage<T>(key: string): [T | undefined, (value: T | undefined) => void] {
  const [value, setValue] = useState(() => presio.storage.get(key) as T | undefined);
  useEffect(() => presio.storage.onChange((all) => setValue(all[key] as T | undefined)), [key]);
  const set = useCallback(
    (next: T | undefined) => {
      presio.storage.set(key, next);
      setValue(next);
    },
    [key]
  );
  return [value, set];
}

/** The current time, updated every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(interval);
  }, [ms]);
  return now;
}

export function mount(node: ReactNode) {
  const theme = () => (document.documentElement.className = presio.theme);
  theme();
  presio.onContextChange(theme);
  createRoot(document.getElementById("root")!).render(node);
}
