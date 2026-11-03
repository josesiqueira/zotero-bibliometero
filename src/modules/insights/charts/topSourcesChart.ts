/**
 * topSourcesChart.ts - "top-sources" VizModule: the journals, proceedings,
 * series and repositories that hold the most items (see extract.ts for which
 * field counts as the source of each item type).
 */

import type { VizContext } from "../types";
import type { RankedEntry } from "./chartkit/rankedBars";
import { RankedChart, type RankedLoad } from "./rankedChart";

export class TopSourcesChart extends RankedChart {
  readonly id = "top-sources";
  readonly label = "Top sources";
  readonly icon =
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="1" y="2" width="13" height="2.5" fill="context-stroke"/>' +
    '<rect x="1" y="6.75" width="9" height="2.5" fill="context-stroke"/>' +
    '<rect x="1" y="11.5" width="5" height="2.5" fill="context-stroke"/></svg>';
  protected readonly noun = "sources";

  protected async load(ctx: VizContext, n: number): Promise<RankedLoad> {
    const d = await ctx.data.topSources(n);
    const missing = d.missing > 0 ? `, ${d.missing} items have no source` : "";
    return {
      entries: d.entries.map((e) => ({
        label: e.name,
        value: e.count,
        key: e.name,
        itemIds: e.itemIds,
      })),
      total: d.total,
      summary: `${d.total} distinct source${d.total === 1 ? "" : "s"}${missing}`,
    };
  }

  protected describe(e: RankedEntry): string {
    return `in ${e.label}`;
  }
}
