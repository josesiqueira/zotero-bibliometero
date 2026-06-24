/**
 * chartkit/scale.ts - tiny, dependency-free scale + tick helpers.
 *
 * Pure functions: no DOM, no Zotero. Used by axis.ts and the charts to map data
 * values to pixel positions and to compute "nice" round axis bounds/ticks.
 */

/** Maps a numeric domain [d0, d1] onto a pixel range [r0, r1]. */
export interface LinearScale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
}

/**
 * Continuous linear scale. Defensive against a zero-width domain (returns the
 * range midpoint so geometry never produces NaN).
 */
export function linearScale(
  domain: [number, number],
  range: [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const fn = ((value: number): number => {
    if (span === 0) return (r0 + r1) / 2;
    const t = (value - d0) / span;
    return r0 + t * (r1 - r0);
  }) as LinearScale;
  fn.domain = domain;
  fn.range = range;
  return fn;
}

/** One discrete band (category) on a band scale. */
export interface Band {
  start: number; // band left/top edge in px
  center: number; // band centre in px
  width: number; // band thickness in px
}

/** Discrete band scale (categorical axis), like d3.scaleBand. */
export interface BandScale {
  (key: string): Band | undefined;
  bandwidth: number;
  step: number;
  keys: string[];
}

/**
 * Band scale over `keys` across pixel range [r0, r1]. `padding` (0..1) is the
 * fraction of each step left as gap. Defensive against empty keys.
 */
export function bandScale(
  keys: string[],
  range: [number, number],
  padding = 0.2,
): BandScale {
  const [r0, r1] = range;
  const n = keys.length;
  const total = r1 - r0;
  const pad = Math.min(0.95, Math.max(0, padding));
  const step = n > 0 ? total / n : 0;
  const bandwidth = step * (1 - pad);
  const index = new Map<string, number>();
  keys.forEach((k, i) => index.set(k, i));
  const fn = ((key: string): Band | undefined => {
    const i = index.get(key);
    if (i === undefined) return undefined;
    const start = r0 + i * step + (step - bandwidth) / 2;
    return { start, center: start + bandwidth / 2, width: bandwidth };
  }) as BandScale;
  fn.bandwidth = bandwidth;
  fn.step = step;
  fn.keys = keys;
  return fn;
}

/**
 * Round a maximum up to a visually "nice" value (1, 2, 2.5, 5 x 10^k) so the
 * top gridline sits on a clean number. Returns at least 1 for non-positive max.
 */
export function niceMax(max: number): number {
  if (!isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const pow = Math.pow(10, exp);
  const frac = max / pow;
  let niceFrac: number;
  if (frac <= 1) niceFrac = 1;
  else if (frac <= 2) niceFrac = 2;
  else if (frac <= 2.5) niceFrac = 2.5;
  else if (frac <= 5) niceFrac = 5;
  else niceFrac = 10;
  return niceFrac * pow;
}

/**
 * Produce up to ~`count` evenly spaced "nice" tick values across [0, max].
 * Ticks are integer-friendly for small counts (typical for item-count charts).
 */
export function niceTicks(max: number, count = 5): number[] {
  const top = niceMax(max);
  if (top <= 0) return [0];
  const rawStep = top / Math.max(1, count);
  const exp = Math.floor(Math.log10(rawStep));
  const pow = Math.pow(10, exp);
  const frac = rawStep / pow;
  let niceFrac: number;
  if (frac <= 1) niceFrac = 1;
  else if (frac <= 2) niceFrac = 2;
  else if (frac <= 2.5) niceFrac = 2.5;
  else if (frac <= 5) niceFrac = 5;
  else niceFrac = 10;
  const step = niceFrac * pow;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step * 0.5; v += step) {
    // Round away floating dust so labels read cleanly.
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return ticks;
}
