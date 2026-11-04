"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * The theme mechanism (P0): light-first tokens on :root, a dark variant on
 * [data-theme="dark"], and a prefers-color-scheme path for the default.
 *
 * Three states, exactly:
 *   "system" (default) — NO data-theme attribute on <html>; the CSS media
 *                        query decides, so the app follows the OS live.
 *   "light" / "dark"   — data-theme stamped; the explicit choice beats the OS
 *                        in BOTH directions (the media block is guarded with
 *                        :not([data-theme="light"])).
 *
 * The choice persists in localStorage under THEME_KEY and is re-applied
 * before first paint by the inline boot script in app/layout.tsx — this hook
 * only has to keep the attribute and the stored value in step after that.
 */
export type ThemePref = "system" | "light" | "dark";

export const THEME_KEY = "geo-theme";

function apply(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

function stored(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system"; // storage blocked: the default still works
  }
}

export function useTheme(): { pref: ThemePref; setPref: (p: ThemePref) => void } {
  // Server render and first client render must agree (hydration), so start
  // from "system" and read the real preference in an effect.
  const [pref, setPrefState] = useState<ThemePref>("system");

  useEffect(() => {
    setPrefState(stored());
  }, []);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    apply(p);
    try {
      if (p === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, p);
    } catch {
      // storage blocked: the attribute is set, the choice just won't persist
    }
  }, []);

  return { pref, setPref };
}
