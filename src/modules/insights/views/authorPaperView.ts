/**
 * authorPaperView.ts - VizModule id "author-paper".
 *
 * Answers "which of my items come from the same people?". Shows authors who
 * appear on several items (repeat authors) and the items they link, with items
 * coloured by publication year. Clicking an item opens it; clicking an author
 * highlights their items; double-clicking an author selects them.
 */

import type {
  BipartiteData,
  NetEdge,
  NetModel,
  NetNode,
  VizContext,
} from "../types";
import { NetworkViewBase, seedByGroup } from "./networkViewBase";

const DEFAULT_CAP = 400;

/**
 * The middle of viridis, a colour-blind-safe sequential scale (older = blue,
 * newer = green). Its darkest and lightest ends are left out so every item
 * stays visible on both the light and the dark background.
 */
const VIRIDIS = ["#3b528b", "#2c728e", "#21918c", "#3fbc73", "#a0da39"];

function yearColor(year: number | null, min: number, max: number): string {
  if (year === null) return "#9a9a9a";
  const t = max > min ? (year - min) / (max - min) : 1;
  const pos = t * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(pos));
  return mix(VIRIDIS[i]!, VIRIDIS[i + 1]!, pos - i);
}

function mix(a: string, b: string, t: number): string {
  const p = (h: string, o: number) => parseInt(h.slice(o, o + 2), 16);
  const c = [1, 3, 5].map((o) => Math.round(p(a, o) + (p(b, o) - p(a, o)) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

export class AuthorPaperView extends NetworkViewBase<BipartiteData> {
  readonly id = "author-paper";
  readonly label = "Author / paper";
  readonly icon =
    '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="4" cy="8" r="2" fill="context-stroke"/><rect x="10" y="3" width="4" height="4" fill="context-stroke"/><rect x="10" y="9" width="4" height="4" fill="context-stroke"/><line x1="4" y1="8" x2="11" y2="5" stroke="context-stroke"/><line x1="4" y1="8" x2="11" y2="11" stroke="context-stroke"/></svg>';

  protected load(ctx: VizContext): Promise<BipartiteData> {
    return ctx.data.bipartite(ctx.prefs.get<number>("cap", DEFAULT_CAP));
  }

  private yearRange(d: BipartiteData): [number, number] {
    const years = d.papers
      .map((p) => p.year)
      .filter((y): y is number => y !== null);
    return years.length ? [Math.min(...years), Math.max(...years)] : [0, 0];
  }

  protected toModel(d: BipartiteData): NetModel {
    const [min, max] = this.yearRange(d);
    const papers: NetNode[] = d.papers.map((p) => ({
      id: "i:" + p.id,
      itemId: p.id,
      label: p.label,
      kind: "item",
      openable: true,
      weight: 0.4,
      color: yearColor(p.year, min, max),
      details: [p.title],
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    }));
    const authors: NetNode[] = d.authors.map((a) => ({
      id: "a:" + a.id,
      label: a.label,
      kind: "author",
      openable: false,
      weight: Math.max(1, a.paperCount),
      itemIds: a.itemIds,
      details: [`${a.paperCount} items in this view`],
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    }));
    const nodes = [...authors, ...papers];
    seedByGroup(nodes, () => 0);
    const edges: NetEdge[] = d.edges.map((e) => ({
      source: "i:" + e.paperId,
      target: "a:" + e.authorId,
      weight: 1,
    }));
    return { nodes, edges, truncated: d.truncated, total: d.totalPapers };
  }

  protected summary(d: BipartiteData): string {
    const other = d.totalPapers - d.papers.length;
    const head = `${d.papers.length} items linked by ${d.authors.length} repeat authors (${d.minPapers}+ items each)`;
    const rest =
      other > 0
        ? ` ${other} items have no repeat author and are not shown.`
        : "";
    return `${head}.${rest} Click an item to select it in your library, or an author to highlight their items.`;
  }

  protected describe(node: NetNode, near: NetNode[]): string {
    if (node.kind === "author") {
      return `${node.label}: ${near.length} item${near.length === 1 ? "" : "s"} on this map. Double-click to select them in your library.`;
    }
    return `${node.details?.[0] ?? node.label}`;
  }

  protected legend(d: BipartiteData) {
    const [min, max] = this.yearRange(d);
    const entries: Array<{ label: string; color?: string; group?: number }> = [
      { label: "Author (size: items)", group: 1 },
    ];
    if (min && max) {
      entries.push({
        label: `Item from ${min}`,
        color: yearColor(min, min, max),
      });
      if (max > min)
        entries.push({
          label: `Item from ${max}`,
          color: yearColor(max, min, max),
        });
    }
    if (d.papers.some((p) => p.year === null))
      entries.push({
        label: "Item with no date",
        color: yearColor(null, 0, 0),
      });
    return { entries, note: "Item colour: publication year." };
  }

  protected emptyMessage(d: BipartiteData): string {
    return d.totalPapers === 0
      ? "No items in this view."
      : "No author appears on more than one item here, so there are no shared authors to draw.";
  }

  protected figureTitle() {
    return {
      title: "Items linked by shared authors",
      name: "bibliometero-author-paper",
    };
  }
}
