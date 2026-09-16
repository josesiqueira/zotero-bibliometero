/*
 * Zotero Bibliometero - LIVE drill-down test harness.
 *
 * Runs INSIDE the running Zotero chrome process against the installed plugin.
 * Execute the entire contents of this file via the MCP bridge
 * (zotero_execute_js); it returns a structured pass/fail report object.
 * It is NOT a mocha file.
 *
 * WHAT THIS EXERCISES (the "filter to exactly these items" drill-down):
 * Clicking a chart bar / pie slice now filters the Zotero items list to EXACTLY
 * the items that bar counted. The implementation lives in
 *   src/modules/insights/context.ts
 *     revealItemsIn / getOrCreateDrilldownSearch / applySentinelConditions /
 *     cleanupDrilldownSearches / DRILLDOWN_SEARCH_NAME = "Bibliometero (drill-down)".
 * HOW IT WORKS: it reuses ONE managed saved-search row per library named
 * "Bibliometero (drill-down)". Zotero DROPS key / itemID conditions when a search
 * is persisted (runtime-only), so the saved search carries only a SENTINEL that
 * matches nothing (joinMode all + title is " __bibliometero_none__"). The real
 * exact filter is applied to the IN-MEMORY search behind the selected tree row:
 * clear conditions, joinMode any, then one "key is <itemKey>" per target item,
 * then itemsView.refresh().
 *
 * This harness drives real clicks on the SVG bars / arcs, reads back the filtered
 * items list, and independently recomputes the EXPECTED id set in plain JS using
 * the same pure logic (extractSource field priority, parseYear, normalized
 * last+initial author key, itemType equality) so it can assert shown === expected.
 *
 * It mirrors the structure and helpers of test/live/harness.js verbatim so it is
 * self-contained and runnable the same way (paste into zotero_execute_js).
 *
 * WRITING-STYLE NOTE: the DRILLDOWN_SEARCH_NAME in the plugin source contains a
 * Unicode triangular bullet between "Bibliometero" and "drill-down". This file
 * reads that name from the live plugin code path (it never hard-codes the bullet),
 * so it stays correct even if the exact separator glyph changes.
 */
const report = { passed: 0, failed: 0, checks: [] };
function check(name, fn) {
  try {
    const detail = fn();
    report.checks.push({ name, ok: true, detail: detail ?? "ok" });
    report.passed++;
  } catch (e) {
    report.checks.push({ name, ok: false, detail: String(e && e.message ? e.message : e) });
    report.failed++;
  }
}
async function acheck(name, fn) {
  try {
    const detail = await fn();
    report.checks.push({ name, ok: true, detail: detail ?? "ok" });
    report.passed++;
  } catch (e) {
    report.checks.push({ name, ok: false, detail: String(e && e.message ? e.message : e) });
    report.failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
/** Poll fn() until it returns truthy or the timeout elapses. */
async function waitFor(fn, timeoutMs, stepMs) {
  const step = stepMs || 100;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let ok = false;
    try {
      ok = await fn();
    } catch (e) {
      ok = false;
    }
    if (ok) return true;
    await sleep(step);
  }
  return false;
}

await Zotero.initializationPromise;
if (Zotero.uiReadyPromise) {
  try {
    await Zotero.uiReadyPromise;
  } catch (e) {}
}

const ID = "zotero-bibliometero@jose.local";
const inst = Zotero.ZoteroBibliometero;
const win = Zotero.getMainWindow();
const doc = win.document;

/* The single reusable saved-search row name the plugin manages. We do NOT want a
 * hard-coded Unicode bullet drift, so we discover it live: the only managed search
 * whose name starts with "Bibliometero" in the user library after a drill-down.
 * As a fallback before the first drill-down we use the documented constant. */
const DRILLDOWN_NAME_FALLBACK = "Bibliometero ▸ drill-down";
function findManagedSearches() {
  try {
    const libID = Zotero.Libraries.userLibraryID;
    return (Zotero.Searches.getByLibrary(libID) || []).filter(
      (s) => s && typeof s.name === "string" && /^Bibliometero\b/.test(s.name) && /drill-down/i.test(s.name),
    );
  } catch (e) {
    return [];
  }
}

/* ---------------------------------------------------------------------------
 * Pure expected-set logic, replicated from src/modules/insights/data/extract.ts
 * and src/modules/insights/data/aggregate.ts so we can compute the expected id
 * set independently of the plugin and assert the shown list matches one-to-one.
 * ------------------------------------------------------------------------- */

// Per-item-type source-field priority (extract.ts SOURCE_FIELDS).
const SOURCE_FIELDS = {
  journalArticle: ["publicationTitle"],
  conferencePaper: ["proceedingsTitle", "conferenceName", "publicationTitle"],
  bookSection: ["bookTitle", "publicationTitle"],
  book: ["publisher", "series"],
  report: ["institution", "publisher"],
  thesis: ["university", "publisher"],
  preprint: ["repository", "publicationTitle"],
  webpage: ["websiteTitle", "publicationTitle", "blogTitle"],
  blogPost: ["websiteTitle", "publicationTitle", "blogTitle"],
};
const DEFAULT_SOURCE_FIELDS = ["publicationTitle", "publisher"];
const MIN_YEAR = 1500;
const MAX_YEAR = 2199;

function extractSourceLive(item) {
  let itemType = "";
  try {
    itemType = item.itemType || "";
  } catch (e) {
    itemType = "";
  }
  const fields = SOURCE_FIELDS[itemType] || DEFAULT_SOURCE_FIELDS;
  for (const field of fields) {
    let val = "";
    try {
      const raw = item.getField ? item.getField(field, false, true) : "";
      if (raw) val = String(raw).trim();
    } catch (e) {
      val = "";
    }
    if (val) return val;
  }
  return "";
}

function clampYear(n) {
  if (!Number.isFinite(n)) return null;
  if (n < MIN_YEAR || n > MAX_YEAR) return null;
  return n;
}
function parseYearFromString(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const lead = /^(\d{4})/.exec(text);
  if (lead) {
    const y = clampYear(Number(lead[1]));
    if (y !== null) return y;
  }
  const re = /(\d{4})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const y = clampYear(Number(m[1]));
    if (y !== null) return y;
  }
  return null;
}
function parseYearLive(item) {
  let raw = "";
  try {
    const iso = item.getField ? item.getField("date", true) : "";
    if (iso) raw = String(iso);
  } catch (e) {}
  if (!raw) {
    try {
      const formatted = item.getField ? item.getField("date") : "";
      if (formatted) raw = String(formatted);
    } catch (e) {}
  }
  return parseYearFromString(raw);
}

// Author key normalization (aggregate.ts creatorToKey + normalizeCreators).
function creatorToKey(creator) {
  const name = (creator.name || "").trim();
  const last = (creator.lastName || "").trim();
  const first = (creator.firstName || "").trim();
  if (name && !last) return { key: "n:" + name.toLowerCase(), label: name };
  if (!last && !first) {
    if (name) return { key: "n:" + name.toLowerCase(), label: name };
    return null;
  }
  const initial = first ? first[0].toLowerCase() : "";
  const key = last.toLowerCase() + "|" + initial;
  const label = first ? last + ", " + first[0].toUpperCase() + "." : last;
  return { key, label };
}
function normalizeCreatorsLive(item) {
  let json = [];
  try {
    json = (item.getCreatorsJSON ? item.getCreatorsJSON() : []) || [];
  } catch (e) {
    json = [];
  }
  const out = [];
  const seen = new Set();
  for (const c of json) {
    if (!c) continue;
    const rec = {};
    if (typeof c.firstName === "string" && c.firstName) rec.firstName = c.firstName;
    if (typeof c.lastName === "string" && c.lastName) rec.lastName = c.lastName;
    if (typeof c.name === "string" && c.name) rec.name = c.name;
    if (!rec.firstName && !rec.lastName && !rec.name) continue;
    const k = creatorToKey(rec);
    if (!k) continue;
    if (seen.has(k.key)) continue;
    seen.add(k.key);
    out.push(k);
  }
  return out;
}

/** All regular (top-level, non-feed) items of the user library. */
async function getRegularItems() {
  const libID = Zotero.Libraries.userLibraryID;
  const all = (await Zotero.Items.getAll(libID, true)) || [];
  return all.filter((it) => {
    try {
      if (!it || typeof it.isRegularItem !== "function") return false;
      if (!it.isRegularItem()) return false;
      if (typeof it.isFeedItem === "function" && it.isFeedItem()) return false;
      return true;
    } catch (e) {
      return false;
    }
  });
}

/* ---------------------------------------------------------------------------
 * UI helpers: read the filtered list, set / read the quick search, click a bar.
 * ------------------------------------------------------------------------- */

/** Collect the item ids currently shown in the ZoteroPane items view. */
function shownItemIds() {
  const iv = win.ZoteroPane && win.ZoteroPane.itemsView;
  if (!iv || typeof iv.getRow !== "function") return [];
  const out = [];
  const n = iv.rowCount || 0;
  for (let i = 0; i < n; i++) {
    try {
      const row = iv.getRow(i);
      const ref = row && row.ref;
      if (ref && Number.isFinite(ref.id)) out.push(ref.id);
    } catch (e) {}
  }
  return out;
}

/** The selected collection-tree row (the saved-search row after a drill-down). */
function selectedTreeRow() {
  try {
    return win.ZoteroPane.collectionsView.selectedTreeRow || null;
  } catch (e) {
    return null;
  }
}

function quickSearchBox() {
  return doc.getElementById("zotero-tb-search");
}
function setQuickSearch(text) {
  const sb = quickSearchBox();
  if (!sb) return;
  sb.value = text;
  if (typeof sb.doCommand === "function") sb.doCommand();
}
function quickSearchValue() {
  const sb = quickSearchBox();
  return sb ? String(sb.value || "") : "";
}

function setEq(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function setDiffDetail(shown, expected) {
  const missing = [];
  const extra = [];
  for (const x of expected) if (!shown.has(x)) missing.push(x);
  for (const x of shown) if (!expected.has(x)) extra.push(x);
  return (
    "shown=" + shown.size + " expected=" + expected.size +
    " missing=" + missing.slice(0, 8).join(",") +
    " extra=" + extra.slice(0, 8).join(",")
  );
}

/** Dispatch a real DOM click and let the async drill-down settle. */
async function clickAndSettle(el) {
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
  await sleep(900);
}

/** Wait until the selected tree row is a managed drill-down saved search. */
async function waitForManagedRow() {
  const ok = await waitFor(() => {
    const row = selectedTreeRow();
    const name = row && row.ref && row.ref.name;
    return !!(name && /^Bibliometero\b/.test(name) && /drill-down/i.test(name));
  }, 6000, 150);
  return ok;
}

/* ---------------------------------------------------------------------------
 * 0. Plugin instance + test hooks present (mirror harness.js section 0).
 * ------------------------------------------------------------------------- */

check("plugin instance present", () => {
  assert(inst && typeof inst === "object", "Zotero.ZoteroBibliometero missing");
  return typeof inst;
});
check("initialized + alive", () => {
  assert(inst.data && inst.data.initialized === true, "not initialized");
  return "initialized";
});
check("config id correct", () => {
  assert(inst.data.config.addonID === ID, "addonID mismatch: " + inst.data.config.addonID);
  return inst.data.config.addonID;
});
check("test hooks exposed", () => {
  const t = inst.data && inst.data.test;
  assert(t && typeof t === "object", "inst.data.test hook bag missing");
  for (const fn of ["getActiveView", "switchView"]) {
    assert(typeof t[fn] === "function", "missing test hook: " + fn);
  }
  return "hooks present";
});

const test = inst.data && inst.data.test ? inst.data.test : null;

check("Zotero.Searches API available", () => {
  assert(Zotero.Searches && typeof Zotero.Searches.getByLibrary === "function", "Zotero.Searches.getByLibrary missing");
  return "ok";
});

/* ---------------------------------------------------------------------------
 * 1. Open the Insights panel (mirror harness.js section 1).
 * ------------------------------------------------------------------------- */

await acheck("opening the Insights panel", async () => {
  const btn = doc.querySelector("#bibliometero-insights-button");
  assert(btn, "no toolbar button to click");
  btn.click();
  const ok = await waitFor(() => !!(test && test.getActiveView()), 6000, 150);
  assert(ok, "no active view after opening the panel");
  return "active view: " + test.getActiveView();
});

/* Snapshot the live regular-item population once for all the expected-set math. */
let REGULAR = [];
await acheck("snapshot live regular items", async () => {
  REGULAR = await getRegularItems();
  assert(REGULAR.length > 0, "no regular items in the user library to test against");
  return REGULAR.length + " regular items";
});

/* The hub container element (used to locate the SVG bars / arcs of a view). */
function viewSvg() {
  // The active chart's SVG lives under the hub panel; grab the visible one.
  const cands = Array.prototype.slice.call(doc.querySelectorAll("svg"));
  // Prefer an svg that actually carries drill-down shapes.
  for (const s of cands) {
    if (s.querySelector(".bm-bar, .bm-year-bar, .bm-arc")) {
      // Must be visible (has a layout box).
      const r = s.getBoundingClientRect ? s.getBoundingClientRect() : null;
      if (r && r.width > 0 && r.height > 0) return s;
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 2. TOP-SOURCES: click the smallest bar, assert managed row selected, quick
 *    search cleared, and shown ids equal the exact extractSource-matched set.
 *    Regression guard for the "4 vs 2" over-count bug.
 * ------------------------------------------------------------------------- */

await acheck("top-sources drill-down: exact extractSource set + managed row + cleared search", async () => {
  await test.switchView("top-sources");
  const active = await waitFor(() => test.getActiveView() === "top-sources", 6000, 150);
  assert(active, "top-sources did not become active");
  // Bars settle / data fetch; wait for .bm-bar to exist.
  const haveBars = await waitFor(() => {
    const svg = viewSvg();
    return svg && svg.querySelectorAll(".bm-bar").length > 0;
  }, 6000, 150);
  assert(haveBars, "no .bm-bar bars rendered in top-sources");
  const svg = viewSvg();
  const bars = Array.prototype.slice.call(svg.querySelectorAll(".bm-bar"));
  assert(bars.length > 0, "no source bars");

  // Pick the LAST / smallest bar (ranked bars are descending; last has fewest).
  const bar = bars[bars.length - 1];
  const titleEl = bar.querySelector("title");
  let label = titleEl ? String(titleEl.textContent || "") : "";
  // Ranked-bar titles can be "Label: N" or just the label; strip a trailing count.
  const labelOnly = label.replace(/:\s*\d+\s*$/, "").trim();
  assert(labelOnly, "could not read a source label from the bar <title>");

  // Compute expected = items whose extractSource() trims-equal to this label.
  const expected = new Set(
    REGULAR.filter((it) => {
      try {
        return extractSourceLive(it).trim() === labelOnly;
      } catch (e) {
        return false;
      }
    }).map((it) => it.id),
  );
  assert(expected.size > 0, "no live items match source '" + labelOnly + "' (cannot validate)");

  await clickAndSettle(bar);
  const rowOk = await waitForManagedRow();
  assert(rowOk, "selected tree row is not the managed drill-down search after click");
  const row = selectedTreeRow();
  assert(row && row.id && /^S/.test(String(row.id)), "selected row id is not a saved search (S...): " + (row && row.id));

  // Quick search must be empty so it cannot further narrow the exact set.
  assert(quickSearchValue() === "", "quick-search box not empty after drill-down: '" + quickSearchValue() + "'");

  const shown = new Set(shownItemIds());
  assert(setEq(shown, expected), "shown != expected for source '" + labelOnly + "': " + setDiffDetail(shown, expected));
  return "source='" + labelOnly + "' shown=" + shown.size + " == expected";
});

/* ---------------------------------------------------------------------------
 * 3. TOP-AUTHORS: click the top bar, assert shown ids are NON-empty (blank-list
 *    regression) and equal the normalized-author-key matched set.
 * ------------------------------------------------------------------------- */

await acheck("top-authors drill-down: non-empty + exact author-key set", async () => {
  await test.switchView("top-authors");
  const active = await waitFor(() => test.getActiveView() === "top-authors", 6000, 150);
  assert(active, "top-authors did not become active");
  const haveBars = await waitFor(() => {
    const svg = viewSvg();
    return svg && svg.querySelectorAll(".bm-bar").length > 0;
  }, 6000, 150);
  assert(haveBars, "no .bm-bar bars rendered in top-authors");
  const svg = viewSvg();
  const bars = Array.prototype.slice.call(svg.querySelectorAll(".bm-bar"));
  assert(bars.length > 0, "no author bars");

  // The TOP (first) bar = highest count. Read its label to derive the author key.
  const bar = bars[0];
  const titleEl = bar.querySelector("title");
  let label = titleEl ? String(titleEl.textContent || "") : "";
  const labelOnly = label.replace(/:\s*\d+\s*$/, "").trim();
  assert(labelOnly, "could not read an author label from the bar <title>");

  // Derive the author KEY from the label by finding any live item whose
  // normalized creators produce that exact display label, then use its key.
  // (The bar click in the plugin matches on key, not label; we mirror that.)
  let targetKey = null;
  for (const it of REGULAR) {
    const keys = normalizeCreatorsLive(it);
    const hit = keys.find((k) => k.label === labelOnly);
    if (hit) {
      targetKey = hit.key;
      break;
    }
  }
  assert(targetKey, "could not resolve a normalized author key for label '" + labelOnly + "'");

  const expected = new Set(
    REGULAR.filter((it) => {
      try {
        return normalizeCreatorsLive(it).some((k) => k.key === targetKey);
      } catch (e) {
        return false;
      }
    }).map((it) => it.id),
  );
  assert(expected.size > 0, "no live items match author key '" + targetKey + "'");

  await clickAndSettle(bar);
  const rowOk = await waitForManagedRow();
  assert(rowOk, "managed row not selected after top-authors click");
  assert(quickSearchValue() === "", "quick-search not cleared on author drill-down");

  const shown = new Set(shownItemIds());
  assert(shown.size > 0, "BLANK-LIST regression: author drill-down showed nothing");
  assert(setEq(shown, expected), "author shown != expected: " + setDiffDetail(shown, expected));
  return "author='" + labelOnly + "' key='" + targetKey + "' shown=" + shown.size;
});

/* ---------------------------------------------------------------------------
 * 4. COMPOSITION: click the "Journal Article" item-type arc; assert shown count
 *    equals the live count of journalArticle regular items.
 *    Regression guard for the "nothing happens" bug.
 * ------------------------------------------------------------------------- */

await acheck("composition drill-down: Journal Article arc filters to journalArticle items", async () => {
  await test.switchView("composition");
  const active = await waitFor(() => test.getActiveView() === "composition", 6000, 150);
  assert(active, "composition did not become active");
  const haveArcs = await waitFor(() => doc.querySelectorAll(".bm-arc").length > 0, 6000, 150);
  assert(haveArcs, "no .bm-arc donut arcs rendered in composition");

  // Find the item-type arc whose <title> starts with "Journal Article".
  const arcs = Array.prototype.slice.call(doc.querySelectorAll(".bm-arc"));
  let arc = null;
  for (const p of arcs) {
    const t = p.querySelector("title");
    const txt = t ? String(t.textContent || "") : "";
    if (/^Journal Article\s*:/.test(txt)) {
      // Must be a clickable item-type arc (cursor pointer), not a no-op.
      arc = p;
      break;
    }
  }
  assert(arc, "no 'Journal Article' arc found (need at least one journalArticle item)");
  // The plugin sets style.cursor = "pointer" on drill-able arcs.
  assert(String(arc.style && arc.style.cursor) === "pointer", "Journal Article arc is not marked clickable");

  const expected = new Set(
    REGULAR.filter((it) => {
      try {
        return it.itemType === "journalArticle";
      } catch (e) {
        return false;
      }
    }).map((it) => it.id),
  );
  assert(expected.size > 0, "no journalArticle items live (cannot validate)");

  await clickAndSettle(arc);
  const rowOk = await waitForManagedRow();
  assert(rowOk, "NOTHING-HAPPENS regression: managed row not selected after arc click");
  assert(quickSearchValue() === "", "quick-search not cleared on composition drill-down");

  const shown = new Set(shownItemIds());
  assert(shown.size === expected.size, "journalArticle shown count " + shown.size + " != live count " + expected.size);
  assert(setEq(shown, expected), "journalArticle shown != expected: " + setDiffDetail(shown, expected));
  return "journalArticle shown=" + shown.size + " == live count";
});

/* ---------------------------------------------------------------------------
 * 5. PUB-YEARS: click a specific year bar, parse its <title> for the year and
 *    count; assert EVERY shown item parses to exactly that year (no 2025 leak in
 *    a 2024 click) and the shown count equals the bar count.
 * ------------------------------------------------------------------------- */

await acheck("pub-years drill-down: exact-year set, no cross-year leak", async () => {
  await test.switchView("pubs-per-year");
  const active = await waitFor(() => test.getActiveView() === "pubs-per-year", 6000, 150);
  assert(active, "pubs-per-year did not become active");
  const haveBars = await waitFor(() => {
    const svg = viewSvg();
    return svg && svg.querySelectorAll(".bm-year-bar").length > 0;
  }, 6000, 150);
  assert(haveBars, "no .bm-year-bar bars rendered in pubs-per-year");
  const svg = viewSvg();
  const bars = Array.prototype.slice.call(svg.querySelectorAll(".bm-year-bar"));
  assert(bars.length > 0, "no year bars");

  // Pick a clickable dated bar whose <title> is "YYYY: N" (skip "Unknown").
  let bar = null;
  let year = null;
  let barCount = null;
  for (const b of bars) {
    const t = b.querySelector("title");
    const txt = t ? String(t.textContent || "") : "";
    const m = /^(\d{4})\s*:\s*(\d+)\s*$/.exec(txt);
    if (m && b.style && b.style.cursor === "pointer") {
      year = Number(m[1]);
      barCount = Number(m[2]);
      bar = b;
      break;
    }
  }
  assert(bar, "no clickable dated year bar with a 'YYYY: N' title found");

  const expected = new Set(
    REGULAR.filter((it) => {
      try {
        return parseYearLive(it) === year;
      } catch (e) {
        return false;
      }
    }).map((it) => it.id),
  );
  assert(expected.size > 0, "no live items parse to year " + year);

  await clickAndSettle(bar);
  const rowOk = await waitForManagedRow();
  assert(rowOk, "managed row not selected after year-bar click");
  assert(quickSearchValue() === "", "quick-search not cleared on year drill-down");

  const shownIds = shownItemIds();
  const shown = new Set(shownIds);
  // Every shown item must parse to EXACTLY this year (no cross-year leak).
  for (const idn of shownIds) {
    const it = Zotero.Items.get(idn);
    const py = it ? parseYearLive(it) : null;
    assert(py === year, "year leak: item " + idn + " parses to " + py + " not " + year);
  }
  assert(shown.size === barCount, "year " + year + " shown count " + shown.size + " != bar count " + barCount);
  assert(setEq(shown, expected), "year shown != expected: " + setDiffDetail(shown, expected));
  return "year=" + year + " barCount=" + barCount + " shown=" + shown.size + " all parse to " + year;
});

/* ---------------------------------------------------------------------------
 * 6. SINGLE REUSABLE ROW: after several drill-downs there must be EXACTLY ONE
 *    managed saved search (no proliferation).
 * ------------------------------------------------------------------------- */

let MANAGED_ID = null;
check("exactly one managed drill-down saved search", () => {
  const matches = findManagedSearches();
  assert(matches.length === 1, "expected exactly 1 managed search, found " + matches.length);
  MANAGED_ID = matches[0].id;
  return "1 row, name='" + matches[0].name + "' id=S" + MANAGED_ID;
});

/* ---------------------------------------------------------------------------
 * 7. NON-PERSISTENCE: the PERSISTED managed search's saved conditions contain NO
 *    key / itemID condition. Load it FRESH from the store and assert only the
 *    sentinel (joinMode + title) remains, proving the exact filter is in-memory
 *    only and the row stays clean between clicks.
 * ------------------------------------------------------------------------- */

await acheck("persisted managed search has no key/itemID conditions (in-memory only)", async () => {
  assert(MANAGED_ID != null, "no managed search id resolved");
  // Re-read fresh from the store so we see the PERSISTED (on-disk) conditions,
  // not the in-memory ref we just mutated for the visible filter.
  const fresh = Zotero.Searches.get(MANAGED_ID);
  assert(fresh, "could not reload managed search S" + MANAGED_ID);
  const conds = fresh.getConditions ? fresh.getConditions() : {};
  const list = Object.keys(conds).map((cid) => conds[cid]).filter(Boolean);
  const conditionNames = list.map((c) => String(c.condition));
  const hasKey = conditionNames.some((c) => c === "key" || c === "itemID");
  assert(!hasKey, "persisted search leaked a key/itemID condition: " + conditionNames.join(","));
  // Positive: only the sentinel survives (joinMode all + title is __bibliometero_none__).
  const hasJoin = conditionNames.includes("joinMode");
  const titleCond = list.find((c) => String(c.condition) === "title");
  assert(hasJoin, "sentinel joinMode condition missing from persisted search");
  assert(titleCond, "sentinel title condition missing from persisted search");
  const tv = String(titleCond.value || "");
  assert(/__bibliometero_none__/.test(tv), "sentinel title value unexpected: '" + tv + "'");
  return "persisted conditions: " + conditionNames.join(",") + " (sentinel only)";
});

/* ---------------------------------------------------------------------------
 * 8. SENTINEL: the persisted search alone must match nothing. Run its search()
 *    fresh-from-store and assert it returns an empty set (the title sentinel
 *    " __bibliometero_none__" with joinMode all matches no real item).
 * ------------------------------------------------------------------------- */

await acheck("sentinel-only persisted search matches nothing", async () => {
  assert(MANAGED_ID != null, "no managed search id resolved");
  const fresh = Zotero.Searches.get(MANAGED_ID);
  assert(fresh, "could not reload managed search for sentinel test");
  let results = [];
  try {
    results = (await fresh.search()) || [];
  } catch (e) {
    // If search() throws on the sentinel that itself documents non-matching;
    // surface it rather than silently passing.
    throw new Error("sentinel search() threw: " + (e && e.message ? e.message : e));
  }
  assert(results.length === 0, "sentinel search matched " + results.length + " items (expected 0)");
  return "sentinel matched 0 items";
});

/* ---------------------------------------------------------------------------
 * 9. QUICK-SEARCH INTERACTION: pre-fill the quick search with text, then do a
 *    drill-down, and assert the box was cleared so it cannot further narrow the
 *    exact set (and the shown set still equals the exact expected set).
 * ------------------------------------------------------------------------- */

await acheck("drill-down clears a pre-set quick search", async () => {
  await test.switchView("top-sources");
  await waitFor(() => test.getActiveView() === "top-sources", 6000, 150);
  await waitFor(() => {
    const svg = viewSvg();
    return svg && svg.querySelectorAll(".bm-bar").length > 0;
  }, 6000, 150);

  // Poison the quick search with text that would otherwise narrow results.
  setQuickSearch("zzqq_unlikely_token_" + Date.now());
  await sleep(400);
  assert(quickSearchValue() !== "", "could not set the quick-search box");

  const svg = viewSvg();
  const bars = Array.prototype.slice.call(svg.querySelectorAll(".bm-bar"));
  assert(bars.length > 0, "no source bars for quick-search interaction test");
  const bar = bars[bars.length - 1];
  const t = bar.querySelector("title");
  const labelOnly = (t ? String(t.textContent || "") : "").replace(/:\s*\d+\s*$/, "").trim();
  assert(labelOnly, "no label for the quick-search-interaction bar");

  const expected = new Set(
    REGULAR.filter((it) => {
      try {
        return extractSourceLive(it).trim() === labelOnly;
      } catch (e) {
        return false;
      }
    }).map((it) => it.id),
  );
  assert(expected.size > 0, "no items match source '" + labelOnly + "' for quick-search test");

  await clickAndSettle(bar);
  await waitForManagedRow();
  // The whole point: the box must be empty now.
  assert(quickSearchValue() === "", "quick-search NOT cleared by drill-down: '" + quickSearchValue() + "'");
  const shown = new Set(shownItemIds());
  assert(setEq(shown, expected), "shown != expected after clearing quick-search: " + setDiffDetail(shown, expected));
  return "quick-search cleared; shown=" + shown.size + " == expected";
});

/* ---------------------------------------------------------------------------
 * 10. Final console error scan (bibliometero-relevant errors only).
 * ------------------------------------------------------------------------- */

check("no bibliometero errors in console", () => {
  let lines = [];
  try {
    const msgs = Zotero.getErrors ? Zotero.getErrors(true) : [];
    lines = (msgs || []).map((m) => String(m));
  } catch (e) {
    return "console scan unavailable (skipped)";
  }
  const relevant = lines.filter(
    (l) => /bibliometero/i.test(l) && /error|exception|typeerror/i.test(l),
  );
  assert(relevant.length === 0, "bibliometero errors: " + relevant.slice(0, 3).join(" | "));
  return relevant.length === 0 ? "clean" : relevant.length + " errors";
});

/* ---------------------------------------------------------------------------
 * Restore the view to top-sources and return the report. We intentionally LEAVE
 * the single managed drill-down search row in place (cleanup runs on plugin
 * shutdown via cleanupDrilldownSearches); we never create extra rows.
 * ------------------------------------------------------------------------- */

await acheck("restore top-sources view (leave single managed row)", async () => {
  await test.switchView("top-sources");
  const ok = await waitFor(() => test.getActiveView() === "top-sources", 6000, 150);
  const matches = findManagedSearches();
  assert(matches.length <= 1, "more than one managed search row left behind: " + matches.length);
  return "restored=" + ok + " managedRows=" + matches.length;
});

report.summary = `${report.passed} passed, ${report.failed} failed`;
return report;
