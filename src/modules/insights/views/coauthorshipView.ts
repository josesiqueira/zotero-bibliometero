/**
 * coauthorshipView.ts - VizModule id "coauthorship".
 *
 * Answers "which research groups recur in my reading, and who is central in
 * each?". Shows authors with at least N items (N chosen in aggregate.ts so the
 * map stays readable), linked when they share items, coloured by research
 * group. Clicking an author highlights their co-authors and explains them on
 * the status line; double-clicking selects their items.
 */

import type {
  CoAuthorshipData,
  NetEdge,
  NetModel,
  NetNode,
  VizContext,
} from "../types";
import { NetworkViewBase, seedByGroup } from "./networkViewBase";
import { MAX_LINKED_AUTHORS } from "../data/aggregate";

const DEFAULT_CAP = 150;

export class CoauthorshipView extends NetworkViewBase<CoAuthorshipData> {
  readonly id = "coauthorship";
  readonly label = "Co-authorship";
  readonly icon =
    '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="4" cy="4" r="2" fill="context-stroke"/><circle cx="12" cy="6" r="2" fill="context-stroke"/><circle cx="7" cy="12" r="2" fill="context-stroke"/><line x1="4" y1="4" x2="12" y2="6" stroke="context-stroke"/><line x1="4" y1="4" x2="7" y2="12" stroke="context-stroke"/></svg>';

  protected load(ctx: VizContext): Promise<CoAuthorshipData> {
    return ctx.data.coauthorship(ctx.prefs.get<number>("cap", DEFAULT_CAP));
  }

  protected toModel(data: CoAuthorshipData): NetModel {
    const groupName = new Map(data.groups.map((g) => [g.index, g.label]));
    const nodes: NetNode[] = data.nodes.map((n) => ({
      id: "a:" + n.id,
      label: n.label,
      kind: "author",
      openable: false,
      weight: Math.max(1, n.paperCount),
      group: n.group,
      itemIds: n.itemIds,
      details: [
        `${n.paperCount} item${n.paperCount === 1 ? "" : "s"}, ${n.degree} co-author${n.degree === 1 ? "" : "s"} on this map`,
        n.group >= 0 ? `Group: ${groupName.get(n.group)}` : "Small group",
      ],
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    }));
    seedByGroup(nodes, (n) => ((n.group ?? -1) < 0 ? 99 : n.group!));
    const edges: NetEdge[] = data.edges.map((e) => ({
      source: "a:" + e.source,
      target: "a:" + e.target,
      weight: Math.max(1, e.weight),
    }));
    return {
      nodes,
      edges,
      truncated: data.truncated,
      total: data.totalAuthors,
    };
  }

  protected summary(d: CoAuthorshipData): string {
    const groups = d.groups.length;
    const hidden = d.totalAuthors - d.nodes.length;
    const head = `${d.nodes.length} authors with ${d.minPapers}+ items, in ${groups} group${groups === 1 ? "" : "s"}`;
    const why =
      hidden > 0
        ? ` ${hidden} other authors are not shown (fewer items, or no co-author on the map).`
        : "";
    const big =
      d.largeTeamPapers > 0
        ? ` ${d.largeTeamPapers} items with more than ${MAX_LINKED_AUTHORS} authors add no links.`
        : "";
    return `${head}.${why}${big} Click an author to see their co-authors.`;
  }

  protected describe(
    node: NetNode,
    near: NetNode[],
    d: CoAuthorshipData,
  ): string {
    const items = node.itemIds?.length ?? 0;
    const group = d.groups.find((g) => g.index === node.group);
    const names = near
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4)
      .map((n) => n.label)
      .join("; ");
    const more = near.length > 4 ? ` and ${near.length - 4} more` : "";
    return (
      `${node.label}: ${items} item${items === 1 ? "" : "s"}` +
      (group ? `, ${group.label} group` : "") +
      `. Co-authors here: ${names || "none"}${more}. Double-click to select their items.`
    );
  }

  protected legend(d: CoAuthorshipData) {
    const entries = d.groups.map((g) => ({
      label: `${g.label} (${g.size})`,
      group: g.index,
    }));
    if (d.nodes.some((n) => n.group < 0))
      entries.push({ label: "Smaller groups", group: -1 });
    return { entries, note: "Size: items. Lines: shared items." };
  }

  protected emptyMessage(d: CoAuthorshipData): string {
    return d.totalAuthors === 0
      ? "No authors in this view."
      : `No two authors with ${d.minPapers}+ items share an item here, so there is no co-authorship to draw. Top authors lists who appears most.`;
  }

  protected figureTitle() {
    return {
      title: "Co-authorship network",
      name: "bibliometero-coauthorship",
    };
  }
}
