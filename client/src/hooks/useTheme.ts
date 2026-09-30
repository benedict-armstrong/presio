import { createContext, useContext } from "react";
import type { ThemeSetting } from "@/lib/settings";

export const ThemeContext = createContext<{
  theme: ThemeSetting;
  setTheme: (t: ThemeSetting) => void;
}>({ theme: "system", setTheme: () => {} });

export const useTheme = () => useContext(ThemeContext);
