/**
 * theme.ts - resolved light/dark theming for the Insights hub.
 *
 * Single source of truth for: reading the `hub.theme` pref (auto/light/dark),
 * resolving "auto" against the window's prefers-color-scheme, mapping a concrete
 * mode to a ThemeInfo token set (shared by every view), and toggling the
 * `.bibliometero-theme-light` / `.bibliometero-theme-dark` modifier class on a
 * root element. A small attach helper wires a matchMedia listener so the hub can
 * repaint when the OS theme flips while on "auto".
 */

import type { ThemeInfo } from "./types";
import { getPrefRaw } from "../../utils/prefs";

export type ThemeMode = "light" | "dark";
export type ThemePref = "auto" | "light" | "dark";

/** Okabe-Ito colour-blind-safe categorical palette (shared series order). */
const OKABE_ITO = [
  "#0072b2", // blue
  "#e69f00", // orange
  "#009e73", // bluish green
  "#cc79a7", // reddish purple
  "#56b4e9", // sky blue
  "#d55e00", // vermillion
  "#f0e442", // yellow
  "#999999", // grey
];

const LIGHT: ThemeInfo = {
  mode: "light",
  bg: "#fafafa",
  fg: "#222222",
  muted: "#6b6b6b",
  accent: "#1a73e8",
  border: "rgba(0, 0, 0, 0.18)",
  grid: "rgba(0, 0, 0, 0.10)",
  series: OKABE_ITO.slice(),
};

const DARK: ThemeInfo = {
  mode: "dark",
  bg: "#1d1e22",
  fg: "#e6e6e6",
  muted: "#9a9a9a",
  accent: "#8ab4f8",
  border: "rgba(255, 255, 255, 0.18)",
  grid: "rgba(255, 255, 255, 0.12)",
  series: OKABE_ITO.slice(),
};

/** Read the `hub.theme` preference (auto/light/dark), defaulting to "auto". */
export function themePref(): ThemePref {
  try {
    const v = getPrefRaw("hub.theme");
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return "auto";
}

/** Resolve the concrete theme for a window, honouring "auto" via matchMedia. */
export function resolveTheme(win: _ZoteroTypes.MainWindow): ThemeMode {
  const pref = themePref();
  if (pref === "light") return "light";
  if (pref === "dark") return "dark";
  try {
    const mql = win.matchMedia("(prefers-color-scheme: dark)");
    return mql && mql.matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Toggle the theme modifier class on a root element. */
export function applyThemeClass(root: HTMLElement, mode: ThemeMode): void {
  root.classList.toggle("bibliometero-theme-dark", mode === "dark");
  root.classList.toggle("bibliometero-theme-light", mode === "light");
}

/** Token set for a concrete mode. Views read this via ctx.theme(). */
export function paletteFor(mode: ThemeMode): ThemeInfo {
  return mode === "dark" ? { ...DARK } : { ...LIGHT };
}

export interface ThemeWatcher {
  detach(): void;
}

/**
 * Register a matchMedia listener that fires `onChange` whenever the OS theme
 * flips while the pref is on "auto". Returns a detach handle. No-op (still
 * returns a handle) if matchMedia is unavailable.
 */
export function attachThemeWatcher(
  win: _ZoteroTypes.MainWindow,
  onChange: () => void,
): ThemeWatcher {
  let mql: MediaQueryList | null = null;
  let fn: (() => void) | null = null;
  try {
    mql = win.matchMedia("(prefers-color-scheme: dark)");
    if (mql) {
      fn = () => {
        if (themePref() === "auto") onChange();
      };
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", fn);
      } else if (typeof (mql as any).addListener === "function") {
        (mql as any).addListener(fn);
      }
    }
  } catch {
    mql = null;
    fn = null;
  }
  return {
    detach() {
      if (mql && fn) {
        try {
          if (typeof mql.removeEventListener === "function") {
            mql.removeEventListener("change", fn);
          } else if (typeof (mql as any).removeListener === "function") {
            (mql as any).removeListener(fn);
          }
        } catch {
          /* window already gone */
        }
      }
      mql = null;
      fn = null;
    },
  };
}
