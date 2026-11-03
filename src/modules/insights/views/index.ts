import { VizRegistry } from "../registry";
import type { VizFactory } from "../types";
import { CoauthorshipView } from "./coauthorshipView";
import { AuthorPaperView } from "./authorPaperView";
import { PubYearsChart } from "../charts/pubYearsChart";
import { TopSourcesChart } from "../charts/topSourcesChart";
import { TopAuthorsChart } from "../charts/topAuthorsChart";
import { CompositionChart } from "../charts/compositionChart";
import { SetView } from "./setView";
import catalog from "./catalog.json";

/**
 * The view catalog (catalog.json) is the single source of truth for which views
 * exist, their nav order, labels and tooltips. The documentation generator
 * (scripts/docs.mjs) reads the same file, and its check fails when a catalog id
 * has no factory here or a factory has no catalog entry.
 */
export const VIEW_CATALOG = catalog.views;

const FACTORIES: Record<string, VizFactory> = {
  coauthorship: () => new CoauthorshipView(),
  "author-paper": () => new AuthorPaperView(),
  "pubs-per-year": () => new PubYearsChart(),
  "top-sources": () => new TopSourcesChart(),
  "top-authors": () => new TopAuthorsChart(),
  composition: () => new CompositionChart(),
  set: () => new SetView(),
};

/** Hover text for a view's nav button, from the catalog. */
export function viewTooltip(id: string): string | undefined {
  return VIEW_CATALOG.find((v) => v.id === id)?.tooltip;
}

/** Register all views, in catalog order. Called once on startup (hub.register()). */
export function registerViews(): void {
  for (const view of VIEW_CATALOG) {
    const factory = FACTORIES[view.id];
    if (factory) VizRegistry.register(view.id, view.label, factory);
  }
}
