/**
 * topAuthorsChart.ts - "top-authors" VizModule: authors ranked by how many
 * items they wrote, using the shared author identity (aggregate.ts), so the
 * counts match the co-authorship network.
 */

import type { VizContext } from "../types";
import type { RankedEntry } from "./chartkit/rankedBars";
import { RankedChart, type RankedLoad } from "./rankedChart";

export class TopAuthorsChart extends RankedChart {
  readonly id = "top-authors";
  readonly label = "Top authors";
  readonly icon =
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="5" cy="5" r="2.5" fill="context-stroke"/>' +
    '<rect x="9" y="3" width="6" height="2" fill="context-stroke"/>' +
    '<circle cx="5" cy="11" r="2.5" fill="context-stroke"/>' +
    '<rect x="9" y="10" width="4" height="2" fill="context-stroke"/></svg>';
  protected readonly noun = "authors";

  protected async load(ctx: VizContext, n: number): Promise<RankedLoad> {
    const d = await ctx.data.topAuthors(n);
    return {
      entries: d.entries.map((e) => ({
        label: e.label,
        value: e.count,
        key: e.key,
        itemIds: e.itemIds,
      })),
      total: d.totalAuthors,
      summary: `${d.totalAuthors} distinct author${d.totalAuthors === 1 ? "" : "s"}`,
    };
  }

  protected describe(e: RankedEntry): string {
    return `by ${e.label}`;
  }
}
