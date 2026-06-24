import { VizRegistry } from "../registry";
import { CoauthorshipView } from "./coauthorshipView";
import { AuthorPaperView } from "./authorPaperView";
import { PubYearsChart } from "../charts/pubYearsChart";
import { TopSourcesChart } from "../charts/topSourcesChart";
import { TopAuthorsChart } from "../charts/topAuthorsChart";
import { CompositionChart } from "../charts/compositionChart";

/**
 * Register all six views, in sidebar order. Called once on startup (hub.register()).
 * The class names/paths here are the FROZEN integration points the coding agents
 * implement against.
 */
export function registerViews(): void {
  VizRegistry.register("coauthorship", "Co-authorship", () => new CoauthorshipView());
  VizRegistry.register("author-paper", "Author / paper", () => new AuthorPaperView());
  VizRegistry.register("pubs-per-year", "Publications / year", () => new PubYearsChart());
  VizRegistry.register("top-sources", "Top sources", () => new TopSourcesChart());
  VizRegistry.register("top-authors", "Top authors", () => new TopAuthorsChart());
  VizRegistry.register("composition", "Composition", () => new CompositionChart());
}
