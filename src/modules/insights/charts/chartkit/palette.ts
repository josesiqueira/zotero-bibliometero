/**
 * chartkit/palette.ts - colour-blind-safe categorical palette.
 *
 * The Okabe-Ito 8-colour qualitative palette is the de-facto standard for
 * accessible categorical encoding. ThemeInfo.series may already carry one; when
 * a view passes theme.series we use it, otherwise we fall back to this. Either
 * way colorForKey assigns deterministically by index so a category keeps its
 * colour across re-renders and theme switches.
 */

/** Okabe-Ito qualitative palette (8 hues, omitting black). */
export const OKABE_ITO: string[] = [
  "#0072B2", // blue
  "#E69F00", // orange
  "#009E73", // bluish green
  "#D55E00", // vermillion
  "#CC79A7", // reddish purple
  "#56B4E9", // sky blue
  "#F0E442", // yellow
  "#999999", // grey (long-tail / "other")
];

/** Resolve the working palette: prefer the theme's series, else Okabe-Ito. */
export function resolvePalette(series?: string[] | null): string[] {
  return series && series.length > 0 ? series : OKABE_ITO;
}

/**
 * Deterministic colour for a category at position `index`. Wraps around the
 * palette; for indices past the palette length it darkens/lightens via a simple
 * lightness rotation so adjacent wrapped colours still differ.
 */
export function colorForKey(
  index: number,
  series?: string[] | null,
): string {
  const palette = resolvePalette(series);
  const n = palette.length;
  if (n === 0) return "#888888";
  const base = palette[index % n];
  const cycle = Math.floor(index / n);
  if (cycle === 0) return base;
  // Past one full cycle, shift lightness so wrapped colours are distinguishable.
  return shiftLightness(base, cycle % 2 === 1 ? 0.18 : -0.18);
}

/** Shift a #rrggbb colour toward white (amount>0) or black (amount<0). */
function shiftLightness(hex: string, amount: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const mix = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  const r = Math.round(rgb[0] + (mix - rgb[0]) * t);
  const g = Math.round(rgb[1] + (mix - rgb[1]) * t);
  const b = Math.round(rgb[2] + (mix - rgb[2]) * t);
  return (
    "#" +
    [r, g, b]
      .map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0"))
      .join("")
  );
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
