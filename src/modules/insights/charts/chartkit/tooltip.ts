/**
 * chartkit/tooltip.ts - absolutely-positioned, pointer-transparent tooltip.
 *
 * Mirrors the graphView tooltip visual language (dark pill, soft shadow) but is
 * self-contained: it sets its own inline styles so it needs no external CSS and
 * works identically in every chart. Labels are USER DATA, so every line is set
 * via textContent, never innerHTML.
 *
 * The tooltip lives inside a positioned host (the chart container, which the
 * charts mark position:relative) and is clamped inside that host's box.
 */

import type { ThemeInfo } from "../../types";

export interface Tooltip {
  /** Show with the given lines at host-local (x, y), clamped inside the host. */
  show(lines: TooltipLine[], x: number, y: number): void;
  hide(): void;
  /** Re-read colours from a (possibly new) theme. */
  applyTheme(theme: ThemeInfo): void;
  /** Remove the element from the DOM. */
  destroy(): void;
  readonly el: HTMLElement;
}

export interface TooltipLine {
  text: string;
  /** "muted" renders the small uppercase caption row (e.g. a type label). */
  variant?: "strong" | "normal" | "muted";
}

/**
 * Create a tooltip appended to `host`. The host should be position:relative so
 * the tooltip's absolute offsets are host-local.
 */
export function createTooltip(
  doc: Document,
  host: HTMLElement,
  theme: ThemeInfo,
): Tooltip {
  const el = doc.createElement("div");
  el.style.position = "absolute";
  el.style.pointerEvents = "none";
  el.style.maxWidth = "280px";
  el.style.padding = "5px 8px";
  el.style.borderRadius = "6px";
  el.style.fontSize = "11px";
  el.style.lineHeight = "1.35";
  el.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.35)";
  el.style.zIndex = "10";
  el.style.display = "none";
  el.style.whiteSpace = "normal";
  el.style.overflowWrap = "anywhere";
  host.appendChild(el);

  function applyTheme(t: ThemeInfo): void {
    // Dark pill in both modes (matches graphView), readable over any chart bg.
    el.style.background =
      t.mode === "dark" ? "rgba(20, 20, 24, 0.94)" : "rgba(40, 40, 46, 0.94)";
    el.style.color = "#f5f5f5";
  }
  applyTheme(theme);

  function show(lines: TooltipLine[], x: number, y: number): void {
    el.textContent = "";
    for (const line of lines) {
      const row = doc.createElement("div");
      row.textContent = line.text;
      if (line.variant === "muted") {
        row.style.opacity = "0.7";
        row.style.fontSize = "10px";
        row.style.textTransform = "uppercase";
        row.style.letterSpacing = "0.03em";
      } else if (line.variant === "strong") {
        row.style.fontWeight = "600";
      }
      el.appendChild(row);
    }
    el.style.display = "block";
    // Clamp inside the host box; flip to the left of the cursor near the edge.
    const hostW = host.clientWidth || 0;
    const hostH = host.clientHeight || 0;
    const tipW = el.offsetWidth || 0;
    const tipH = el.offsetHeight || 0;
    let left = x + 14;
    if (left + tipW > hostW) left = Math.max(4, x - tipW - 14);
    let top = y + 14;
    if (top + tipH > hostH) top = Math.max(4, y - tipH - 14);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function hide(): void {
    el.style.display = "none";
  }

  function destroy(): void {
    try {
      el.remove();
    } catch {
      /* already detached */
    }
  }

  return { show, hide, applyTheme, destroy, el };
}
