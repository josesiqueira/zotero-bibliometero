/**
 * Bibliometero Insights — FROZEN CONTRACT.
 *
 * Every view and the hub compile against these types. Do not change a signature
 * without updating doc/INSIGHTS_PLAN.md and every implementor. New optional fields
 * are fine; renaming/removing is a breaking change.
 */

/* ----------------------------------------------------------------------------
 * Scope & theme
 * ------------------------------------------------------------------------- */

export type VizScope = "library" | "view" | "selection";

export interface ThemeInfo {
  /** Resolved concrete theme (never "auto"). */
  mode: "light" | "dark";
  bg: string; // surface background
  fg: string; // primary text / strong strokes
  muted: string; // secondary text / gridlines / axes
  accent: string; // primary series / selection ring
  border: string;
  grid: string; // chart gridlines
  /** Ordered, colour-blind-safe categorical palette (donuts, multi-series, node types). */
  series: string[];
}

/* ----------------------------------------------------------------------------
 * Dataset shapes (produced by data/aggregate.ts; consumed by views)
 * ------------------------------------------------------------------------- */

/** Canonical author identity shared by views 1, 2, 5 so they always agree. */
export interface AuthorKey {
  key: string; // merge key, e.g. "smith|j" or "n:world health organization"
  label: string; // display label, e.g. "Smith, J." or "World Health Organization"
}

// 1. Co-authorship network
export interface CoAuthorNode {
  id: string; // == AuthorKey.key
  label: string;
  paperCount: number;
  degree: number;
  /** Research group (0 = largest); -1 for authors in groups too small to colour. */
  group: number;
  itemIds: number[];
}
export interface CoAuthorEdge {
  source: string;
  target: string;
  weight: number; // shared-paper count
}
export interface CoAuthorGroup {
  index: number;
  /** Named after the member with the most items, e.g. "Floridi, Luciano". */
  label: string;
  size: number;
}
export interface CoAuthorshipData {
  nodes: CoAuthorNode[];
  edges: CoAuthorEdge[];
  groups: CoAuthorGroup[];
  /** Authors need at least this many items in scope to be shown. */
  minPapers: number;
  totalAuthors: number;
  /** Items whose author list is too long to draw links for (still counted). */
  largeTeamPapers: number;
  truncated: boolean;
}

// 2. Author-to-paper bipartite
export interface BipartitePaperNode {
  id: number; // real Zotero item id (positive)
  key: string;
  /** Short label: "Floridi 2021". */
  label: string;
  title: string;
  itemType: string;
  year: number | null;
}
export interface BipartiteAuthorNode {
  id: string; // "author:" + AuthorKey.key
  label: string;
  paperCount: number;
  itemIds: number[];
}
export interface BipartiteEdge {
  paperId: number;
  authorId: string;
}
export interface BipartiteData {
  papers: BipartitePaperNode[];
  authors: BipartiteAuthorNode[];
  edges: BipartiteEdge[];
  /** Authors need at least this many items in scope to be shown. */
  minPapers: number;
  truncated: boolean;
  totalPapers: number;
}

// 3. Publications per year
export interface YearBucket {
  year: number | null; // null bucket = unparseable/missing year
  count: number;
  itemIds: number[]; // the items counted in this bucket (drill-down)
}
export interface PublicationsPerYearData {
  buckets: YearBucket[]; // ascending by year; null bucket last
  minYear: number | null;
  maxYear: number | null;
  missing: number;
  total: number;
}

// 4. Top sources
export interface SourceEntry {
  name: string;
  count: number;
  itemIds: number[];
}
export interface TopSourcesData {
  entries: SourceEntry[]; // ranked desc, sliced to topN
  total: number; // distinct sources before truncation
  missing: number; // items with no source
}

// 5. Top authors by item count
export interface AuthorCountEntry {
  key: string;
  label: string;
  count: number;
  itemIds: number[];
}
export interface TopAuthorsData {
  entries: AuthorCountEntry[]; // ranked desc, sliced to topN
  totalAuthors: number;
}

// 6. Item-type & collection composition
export interface CompositionSegment {
  key: string;
  label: string; // localized for item types
  count: number;
  itemIds: number[];
}
export interface CompositionData {
  byType: CompositionSegment[]; // ranked desc
  byCollection: CompositionSegment[]; // ranked desc (long tail aggregated as "__other")
  uncategorized: number; // items in zero collections
  uncategorizedIds: number[]; // their ids (drill-down)
  total: number;
}

/* ----------------------------------------------------------------------------
 * Network model (canvas renderer + force sim consume this)
 * ------------------------------------------------------------------------- */

export type NodeKind = "item" | "author" | "tag";

export interface NetNode {
  id: string; // string ids unify item ("i:123") and author ("a:smith|j") spaces
  itemId?: number; // present when kind === "item" (for openItem)
  label: string;
  kind: NodeKind;
  openable: boolean; // item nodes: single-click opens
  weight: number; // drives radius (paperCount / degree)
  /** Colour group (co-authorship research group); -1 or absent = neutral. */
  group?: number;
  /** Fixed fill colour (overrides group and kind), e.g. a paper's year colour. */
  color?: string;
  /** Item ids behind this node (an author's items), for select-on-double-click. */
  itemIds?: number[];
  /** Extra tooltip lines. */
  details?: string[];
  // layout (filled by the sim)
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}
export interface NetEdge {
  source: string;
  target: string;
  weight: number;
}
export interface NetModel {
  nodes: NetNode[];
  edges: NetEdge[];
  truncated: boolean;
  total: number;
}

/* ----------------------------------------------------------------------------
 * Export
 * ------------------------------------------------------------------------- */

export interface ExportResult {
  /** SVG markup for kind:"svg"; omitted for PNG. */
  text?: string;
  /** PNG bytes for kind:"png"; omitted for SVG. */
  blob?: Blob;
  /** Filename without extension, e.g. "bibliometero-coauthorship". */
  suggestedName: string;
  /** "svg" | "png" */
  format: "svg" | "png";
}

/* ----------------------------------------------------------------------------
 * VizContext — environment handed to every view at mount
 * ------------------------------------------------------------------------- */

export interface VizDataAccessors {
  /** Regular items in the active scope. */
  items(): Promise<Zotero.Item[]>;
  perYear(): Promise<PublicationsPerYearData>;
  topSources(limit: number): Promise<TopSourcesData>;
  topAuthors(limit: number): Promise<TopAuthorsData>;
  composition(): Promise<CompositionData>;
  coauthorship(cap: number): Promise<CoAuthorshipData>;
  bipartite(cap: number): Promise<BipartiteData>;
}

export interface VizPrefs {
  get<T = unknown>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export interface VizContext {
  win: _ZoteroTypes.MainWindow;
  doc: Document;
  /** Current resolved theme. Re-read inside onThemeChange. */
  theme(): ThemeInfo;
  /** Current scope (library/view/selection). */
  scope(): VizScope;
  data: VizDataAccessors;
  /** Open an item in the library (tab-switch + select + view). */
  openItem(itemId: number): void;
  /** Select an item in the tree without opening. */
  selectItem(itemId: number): void;
  /**
   * Drill-down: select exactly these items in the item list (in the library the
   * panel shows) and report it on the status line. `what` names the selection,
   * e.g. "published in 2021".
   */
  showItems?(itemIds: number[], what: string): void;
  /** Drill-down: navigate to a Zotero collection by id. */
  openCollection?(collectionID: number): void;
  /** What the data is, for captions: "My Library" or "Curated set in My Library". */
  scopeLabel?(): string;
  /** View-namespaced prefs (backed by `bibliometero.view.<id>.<key>`). */
  prefs: VizPrefs;
  /** Write the shared status line (counts / truncation note). */
  setStatus(text: string, opts?: { warn?: boolean }): void;
  /** A topbar element a view may fill with its own controls (Top-N etc.). */
  controlsSlot: HTMLElement;
  log(...args: unknown[]): void;
}

/* ----------------------------------------------------------------------------
 * VizModule — one per view
 * ------------------------------------------------------------------------- */

export type VizKind = "network" | "chart" | "manage";

export interface VizModule {
  readonly id: string; // stable; also prefs namespace
  readonly label: string;
  readonly icon: string; // inline SVG markup (context-stroke recolour)
  readonly kind: VizKind;

  /** Build DOM into container. The host guarantees destroy() before any re-mount. */
  mount(container: HTMLElement, ctx: VizContext): void | Promise<void>;
  /** Remove all DOM/listeners/observers/rAF/timers created in mount. */
  destroy(): void;

  onResize?(width: number, height: number): void;
  onThemeChange?(): void;
  onDataChange?(): void;

  exportSVG(): Promise<ExportResult>;
  exportPNG(): Promise<ExportResult>;

  /** Optional read-only test hooks surfaced to the live harness (positions, settle, pointer). */
  testHooks?(): Record<string, (...args: any[]) => any>;
}

export type VizFactory = () => VizModule;
