import { useEffect, useState } from "react";

const read = (): "light" | "dark" =>
  typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";

/**
 * The theme actually on screen, with "system" resolved. ThemeProvider toggles
 * `dark` on <html>, so this watches that class rather than
 * prefers-color-scheme — the in-app toggle has to win.
 */
export function useResolvedTheme(): "light" | "dark" {
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(read());
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
