/**
 * networkViewBase.ts - shared lifecycle for the two network views: load the
 * dataset, turn it into a NetModel, hand it to a NetworkView, show an empty or
 * error message when there is nothing to draw, and refresh in place.
 */

import type {
  ExportResult,
  NetModel,
  NetNode,
  VizContext,
  VizModule,
} from "../types";
import { NetworkView, type NetworkOptions } from "../network/NetworkView";
import { longDate } from "../charts/chartkit/figure";

export abstract class NetworkViewBase<D> implements VizModule {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly icon: string;
  readonly kind = "network" as const;

  protected ctx: VizContext | null = null;
  protected data: D | null = null;
  private inner: NetworkView | null = null;
  private container: HTMLElement | null = null;
  private message: HTMLElement | null = null;

  /** Load the dataset for the current scope. */
  protected abstract load(ctx: VizContext): Promise<D>;
  /** Dataset to network model (with initial positions). */
  protected abstract toModel(data: D): NetModel;
  /** Status line text when nothing is selected. */
  protected abstract summary(data: D): string;
  /** Status line text for a selected node. */
  protected abstract describe(
    node: NetNode,
    neighbours: NetNode[],
    data: D,
  ): string;
  /** Legend for the map and the exported figure. */
  protected abstract legend(
    data: D,
  ): ReturnType<NonNullable<NetworkOptions["legend"]>>;
  /** Message to show instead of an empty map. */
  protected abstract emptyMessage(data: D): string;
  /** Export title and file name stem. */
  protected abstract figureTitle(): { title: string; name: string };

  async mount(container: HTMLElement, ctx: VizContext): Promise<void> {
    this.ctx = ctx;
    this.container = container;
    try {
      this.data = await this.load(ctx);
    } catch (e) {
      ctx.log(`[${this.id}] load failed`, e);
      this.showMessage(
        "Could not read your library for this map. Switch views to try again.",
      );
      ctx.setStatus("Could not read the data for this view.", { warn: true });
      return;
    }
    if (!this.ctx) return; // destroyed while loading
    this.render();
  }

  private render(): void {
    const ctx = this.ctx;
    const data = this.data;
    if (!ctx || !this.container || data === null) return;
    const model = this.toModel(data);
    if (!model.nodes.length) {
      this.inner?.destroy();
      this.inner = null;
      this.showMessage(this.emptyMessage(data));
      ctx.setStatus(this.summary(data));
      return;
    }
    this.hideMessage();
    if (this.inner) {
      this.inner.setModel(model);
    } else {
      this.inner = new NetworkView(this.id, this.label, model, {
        onSelect: (node, near) => {
          if (!this.ctx || this.data === null) return;
          this.ctx.setStatus(
            node
              ? this.describe(node, near, this.data)
              : this.summary(this.data),
          );
        },
        legend: () =>
          this.data === null
            ? { entries: [], note: "" }
            : this.legend(this.data),
        figure: () => {
          const t = this.figureTitle();
          const scope = this.ctx?.scopeLabel?.() || "My Library";
          const what =
            this.data === null ? "" : this.summary(this.data).split(". ")[0];
          return {
            title: t.title,
            name: t.name,
            caption: `${scope}: ${what}. ${longDate()}. Zotero Bibliometero.`,
          };
        },
      });
      this.inner.mount(this.container, ctx);
    }
    ctx.setStatus(this.summary(data));
  }

  private showMessage(text: string): void {
    if (!this.container || !this.ctx) return;
    if (!this.message) {
      this.message = this.ctx.doc.createElement("div");
      this.message.className = "bm-empty";
      this.container.appendChild(this.message);
    }
    this.message.textContent = text;
  }

  private hideMessage(): void {
    this.message?.remove();
    this.message = null;
  }

  destroy(): void {
    this.inner?.destroy();
    this.inner = null;
    this.hideMessage();
    this.ctx = null;
    this.container = null;
  }

  onResize(width: number, height: number): void {
    this.inner?.onResize?.(width, height);
  }

  onThemeChange(): void {
    this.inner?.onThemeChange?.();
  }

  async onDataChange(): Promise<void> {
    if (!this.ctx) return;
    try {
      this.data = await this.load(this.ctx);
    } catch (e) {
      this.ctx?.log(`[${this.id}] refresh failed`, e);
      return;
    }
    this.render();
  }

  exportSVG(): Promise<ExportResult> {
    if (!this.inner) throw new Error("Nothing to export: the map is empty.");
    return this.inner.exportSVG();
  }

  exportPNG(): Promise<ExportResult> {
    if (!this.inner) throw new Error("Nothing to export: the map is empty.");
    return this.inner.exportPNG();
  }

  testHooks(): Record<string, (...args: any[]) => any> {
    return this.inner ? this.inner.testHooks() : {};
  }
}

/** Seed positions: group centres on a circle, members spiralled around them. */
export function seedByGroup(
  nodes: NetNode[],
  groupOf: (n: NetNode) => number,
): void {
  const groups = new Map<number, NetNode[]>();
  for (const n of nodes) {
    const g = groupOf(n);
    const list = groups.get(g);
    if (list) list.push(n);
    else groups.set(g, [n]);
  }
  const keys = Array.from(groups.keys()).sort((a, b) => a - b);
  const ring = 120 * Math.sqrt(keys.length);
  const golden = Math.PI * (3 - Math.sqrt(5));
  keys.forEach((g, gi) => {
    const a = (gi / Math.max(1, keys.length)) * Math.PI * 2;
    const cx = keys.length > 1 ? ring * Math.cos(a) : 0;
    const cy = keys.length > 1 ? ring * Math.sin(a) : 0;
    groups.get(g)!.forEach((n, i) => {
      const r = 18 * Math.sqrt(i + 0.5);
      n.x = cx + r * Math.cos(i * golden);
      n.y = cy + r * Math.sin(i * golden);
    });
  });
}
