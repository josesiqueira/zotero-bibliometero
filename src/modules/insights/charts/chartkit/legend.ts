/**
 * chartkit/legend.ts - interactive HTML legend (used beside the donuts).
 *
 * An HTML <ul> rather than SVG so it wraps/scrolls naturally and gets native
 * pointer events. Each row carries a swatch, a label (textContent: user data),
 * and a count. Hovering a row fires onHover(key|null) so the chart can highlight
 * the matching arc; the chart can call highlight(key) to drive the reverse
 * direction (arc hover -> legend row). Bidirectional, as specified.
 */

import type { ThemeInfo } from "../../types";

export interface LegendEntry {
  key: string;
  label: string;
  color: string;
  count: number;
  percent?: number;
}

export interface Legend {
  readonly el: HTMLElement;
  /** Visually emphasise one row (or clear with null). */
  highlight(key: string | null): void;
  applyTheme(theme: ThemeInfo): void;
  destroy(): void;
}

export function renderLegend(
  doc: Document,
  entries: LegendEntry[],
  theme: ThemeInfo,
  opts?: {
    onHover?: (key: string | null) => void;
    onClick?: (key: string) => void;
  },
): Legend {
  const list = doc.createElement("ul");
  list.style.listStyle = "none";
  list.style.margin = "0";
  list.style.padding = "0";
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.gap = "3px";
  list.style.fontSize = "11px";
  list.style.maxHeight = "100%";
  list.style.overflow = "auto";

  const rows = new Map<string, HTMLLIElement>();
  let curTheme = theme;

  for (const e of entries) {
    const li = doc.createElement("li");
    li.style.display = "flex";
    li.style.alignItems = "center";
    li.style.gap = "6px";
    li.style.padding = "2px 4px";
    li.style.borderRadius = "4px";
    li.style.cursor = opts?.onClick ? "pointer" : "default";
    li.style.transition = "background 0.1s ease";

    const swatch = doc.createElement("span");
    swatch.style.flex = "0 0 auto";
    swatch.style.width = "10px";
    swatch.style.height = "10px";
    swatch.style.borderRadius = "2px";
    swatch.style.background = e.color;
    li.appendChild(swatch);

    const label = doc.createElement("span");
    label.style.flex = "1 1 auto";
    label.style.overflow = "hidden";
    label.style.textOverflow = "ellipsis";
    label.style.whiteSpace = "nowrap";
    label.textContent = e.label; // user data
    li.appendChild(label);

    const count = doc.createElement("span");
    count.style.flex = "0 0 auto";
    count.style.opacity = "0.7";
    count.textContent =
      e.percent !== undefined
        ? `${e.count} (${Math.round(e.percent)}%)`
        : String(e.count);
    li.appendChild(count);

    li.addEventListener("mouseenter", () => opts?.onHover?.(e.key));
    li.addEventListener("mouseleave", () => opts?.onHover?.(null));
    if (opts?.onClick) {
      li.addEventListener("click", () => opts.onClick!(e.key));
    }
    rows.set(e.key, li);
    list.appendChild(li);
  }

  function highlightBg(): string {
    return curTheme.mode === "dark"
      ? "rgba(255,255,255,0.12)"
      : "rgba(0,0,0,0.07)";
  }

  function highlight(key: string | null): void {
    for (const [k, li] of rows) {
      li.style.background = k === key ? highlightBg() : "transparent";
    }
  }

  function applyTheme(t: ThemeInfo): void {
    curTheme = t;
    list.style.color = t.fg;
  }
  applyTheme(theme);

  function destroy(): void {
    try {
      list.remove();
    } catch {
      /* already detached */
    }
  }

  return { el: list, highlight, applyTheme, destroy };
}
