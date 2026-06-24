/**
 * authorPaperView.ts - VizModule id "author-paper".
 *
 * Fetches BipartiteData, converts it to a NetModel (papers + authors as nodes,
 * authorship as edges), and delegates everything to an inner NetworkView.
 * Paper nodes are openable items (kind "item"); author nodes are not.
 */

import type {
  BipartiteData,
  ExportResult,
  NetEdge,
  NetModel,
  NetNode,
  VizContext,
  VizModule,
} from "../types";
import { NetworkView } from "../network/NetworkView";

const DEFAULT_CAP = 400;

export class AuthorPaperView implements VizModule {
  readonly id = "author-paper";
  readonly label = "Author / paper";
  readonly icon =
    '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="4" cy="8" r="2" fill="context-stroke"/><rect x="10" y="3" width="4" height="4" fill="context-stroke"/><rect x="10" y="9" width="4" height="4" fill="context-stroke"/><line x1="4" y1="8" x2="11" y2="5" stroke="context-stroke"/><line x1="4" y1="8" x2="11" y2="11" stroke="context-stroke"/></svg>';
  readonly kind = "network" as const;

  private inner: NetworkView | null = null;
  private ctx: VizContext | null = null;
  private container: HTMLElement | null = null;

  async mount(container: HTMLElement, ctx: VizContext): Promise<void> {
    this.ctx = ctx;
    this.container = container;
    const cap = this.cap(ctx);
    let data: BipartiteData;
    try {
      data = await ctx.data.bipartite(cap);
    } catch (e) {
      ctx.log("[Bibliometero] bipartite fetch failed", e);
      ctx.setStatus("Could not load author/paper data.", { warn: true });
      return;
    }
    const model = toNetModel(data);
    this.inner = new NetworkView(this.id, this.label, model);
    await this.inner.mount(container, ctx);
    this.report(ctx, data);
  }

  destroy(): void {
    if (this.inner) this.inner.destroy();
    this.inner = null;
  }

  onResize(width: number, height: number): void {
    this.inner?.onResize?.(width, height);
  }

  onThemeChange(): void {
    this.inner?.onThemeChange?.();
  }

  async onDataChange(): Promise<void> {
    if (!this.ctx || !this.inner) return;
    const ctx = this.ctx;
    try {
      const data = await ctx.data.bipartite(this.cap(ctx));
      this.inner.setModel(toNetModel(data));
      this.report(ctx, data);
    } catch (e) {
      ctx.log("[Bibliometero] bipartite refresh failed", e);
    }
  }

  exportSVG(): Promise<ExportResult> {
    return this.inner!.exportSVG();
  }

  exportPNG(): Promise<ExportResult> {
    return this.inner!.exportPNG();
  }

  testHooks(): Record<string, (...args: any[]) => any> {
    return this.inner ? this.inner.testHooks() : {};
  }

  private cap(ctx: VizContext): number {
    return ctx.prefs.get<number>("cap", DEFAULT_CAP);
  }

  private report(ctx: VizContext, data: BipartiteData): void {
    const note = data.truncated
      ? ` (showing the ${data.papers.length} most co-authored of ${data.totalPapers}; switch to a Curated set to see all of yours)`
      : "";
    ctx.setStatus(
      `${data.papers.length} papers · ${data.authors.length} authors · ${data.edges.length} links${note}`,
      { warn: data.truncated },
    );
  }
}

/** BipartiteData -> NetModel. */
function toNetModel(data: BipartiteData): NetModel {
  // Paper degree (edge count) drives radius.
  const degree = new Map<number, number>();
  for (const e of data.edges) {
    degree.set(e.paperId, (degree.get(e.paperId) || 0) + 1);
  }
  const paperNodes: NetNode[] = data.papers.map((p) => ({
    id: "i:" + p.id,
    itemId: p.id,
    label: p.label,
    kind: "item",
    openable: true,
    weight: Math.max(1, degree.get(p.id) || 0),
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
  }));
  const authorNodes: NetNode[] = data.authors.map((a) => ({
    id: "a:" + a.id,
    label: a.label,
    kind: "author",
    openable: false,
    weight: 1,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
  }));
  const edges: NetEdge[] = data.edges.map((e) => ({
    source: "i:" + e.paperId,
    target: "a:" + e.authorId,
    weight: 1,
  }));
  return {
    nodes: [...paperNodes, ...authorNodes],
    edges,
    truncated: data.truncated,
    total: data.totalPapers,
  };
}
