"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "cupcake" | "nord" | "dim";

export const THEMES: Theme[] = ["light", "dark", "cupcake", "nord", "dim"];
const DEFAULT_THEME: Theme = "light";
const STORAGE_KEY = "temco_theme";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  themes: Theme[];
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  themes: THEMES,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === "undefined") return DEFAULT_THEME;
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    return stored && THEMES.includes(stored) ? stored : DEFAULT_THEME;
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme: setThemeState, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
