/**
 * coauthorshipView.ts - VizModule id "coauthorship".
 *
 * Fetches CoAuthorshipData, converts it to a NetModel (authors -> nodes,
 * shared-paper counts -> edge weights), and delegates everything to an inner
 * NetworkView. Author nodes are NOT openable (clicking highlights, never opens).
 */

import type {
  CoAuthorshipData,
  ExportResult,
  NetEdge,
  NetModel,
  NetNode,
  VizContext,
  VizModule,
} from "../types";
import { NetworkView } from "../network/NetworkView";

const DEFAULT_CAP = 400;

export class CoauthorshipView implements VizModule {
  readonly id = "coauthorship";
  readonly label = "Co-authorship";
  readonly icon =
    '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="4" cy="4" r="2" fill="context-stroke"/><circle cx="12" cy="6" r="2" fill="context-stroke"/><circle cx="7" cy="12" r="2" fill="context-stroke"/><line x1="4" y1="4" x2="12" y2="6" stroke="context-stroke"/><line x1="4" y1="4" x2="7" y2="12" stroke="context-stroke"/></svg>';
  readonly kind = "network" as const;

  private inner: NetworkView | null = null;
  private ctx: VizContext | null = null;
  private container: HTMLElement | null = null;

  async mount(container: HTMLElement, ctx: VizContext): Promise<void> {
    this.ctx = ctx;
    this.container = container;
    const cap = this.cap(ctx);
    let data: CoAuthorshipData;
    try {
      data = await ctx.data.coauthorship(cap);
    } catch (e) {
      ctx.log("[Bibliometero] coauthorship fetch failed", e);
      ctx.setStatus("Could not load co-authorship data.", { warn: true });
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
      const data = await ctx.data.coauthorship(this.cap(ctx));
      this.inner.setModel(toNetModel(data));
      this.report(ctx, data);
    } catch (e) {
      ctx.log("[Bibliometero] coauthorship refresh failed", e);
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

  private report(ctx: VizContext, data: CoAuthorshipData): void {
    const note = data.truncated
      ? ` (showing top ${data.nodes.length} of ${data.totalAuthors})`
      : "";
    ctx.setStatus(
      `${data.nodes.length} authors · ${data.edges.length} co-authorship links${note}`,
      { warn: data.truncated },
    );
  }
}

/** CoAuthorshipData -> NetModel. */
function toNetModel(data: CoAuthorshipData): NetModel {
  const nodes: NetNode[] = data.nodes.map((n) => ({
    id: "a:" + n.id,
    label: n.label,
    kind: "author",
    openable: false,
    weight: Math.max(1, n.paperCount),
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
  }));
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
