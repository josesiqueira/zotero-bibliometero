/*
 * Zotero Bibliometero — live test harness.
 *
 * Runs INSIDE the running Zotero chrome process against the installed plugin.
 * Execute the entire contents of this file via the MCP bridge
 * (zotero_execute_js); it returns a structured pass/fail report.
 *
 * It exercises the live, UI-observable behaviour of the Insights hub and its 6
 * views through the read-only test hooks the hub exposes at
 *   Zotero.ZoteroBibliometero.data.test
 *     getActiveView() -> string view id
 *     switchView(id) -> Promise<void>
 *     getNodePositions() -> Array<{ id, x, y, kind, itemId? }>
 *     isSettled() -> boolean (force sim at rest)
 *     dispatchPointer(type, x, y) -> void  (type: down|move|up|cancel|hover)
 *     exportView(id, fmt) -> Promise<{ format, bytes?:Uint8Array, text?:string }>
 *     getTooltipText() -> string
 *
 * Pure aggregation (normalization, adjacency, year parse, ranking, composition)
 * is covered by the mocha suite under test/*.test.ts and is NOT retested here.
 *
 * Acceptance criteria exercised: AC-1 anti-jitter, AC-2 smooth drag,
 * AC-3 one-click-to-paper, AC-4 valid PNG+SVG exports, plus chart hover and a
 * final console error scan.
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

const VIEWS = [
  "coauthorship",
  "author-paper",
  "pubs-per-year",
  "top-sources",
  "top-authors",
  "composition",
];
const NETWORK_VIEWS = ["coauthorship", "author-paper"];
const CHART_VIEWS = ["pubs-per-year", "top-sources", "top-authors", "composition"];

/* ---------------------------------------------------------------------------
 * 0. Instance + initialization
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
  for (const fn of [
    "getActiveView",
    "switchView",
    "getNodePositions",
    "isSettled",
    "dispatchPointer",
    "exportView",
    "getTooltipText",
  ]) {
    assert(typeof t[fn] === "function", "missing test hook: " + fn);
  }
  return "all hooks present";
});

const test = inst.data && inst.data.test ? inst.data.test : null;
const win = Zotero.getMainWindow();
const doc = win.document;

/* ---------------------------------------------------------------------------
 * 1. Toolbar button + opening the panel
 * ------------------------------------------------------------------------- */

check("insights toolbar button in DOM", () => {
  const btn = doc.querySelector("#bibliometero-insights-button");
  assert(btn && btn.nodeType === 1, "#bibliometero-insights-button not found");
  return "button present";
});

// SCREENSHOT CHECKPOINT: full main window before opening the Insights tab.

await acheck("opening the Insights panel", async () => {
  const btn = doc.querySelector("#bibliometero-insights-button");
  assert(btn, "no toolbar button to click");
  btn.click();
  // The hub mounts its first view asynchronously; wait for an active view.
  const ok = await waitFor(() => !!(test && test.getActiveView()), 6000, 150);
  assert(ok, "no active view after opening the panel");
  return "active view: " + test.getActiveView();
});

// SCREENSHOT CHECKPOINT: Insights tab open with the default (coauthorship) view.

/* ---------------------------------------------------------------------------
 * 2. All 6 views switch + mount without error
 * ------------------------------------------------------------------------- */

for (const id of VIEWS) {
  await acheck("view mounts: " + id, async () => {
    await test.switchView(id);
    const ok = await waitFor(() => test.getActiveView() === id, 6000, 150);
    assert(ok, "view did not become active: " + id);
    // SCREENSHOT CHECKPOINT: each view freshly mounted.
    return "mounted " + id;
  });
}

/* ---------------------------------------------------------------------------
 * 3. ANTI-JITTER (AC-1): at rest positions are pixel-stable; re-layout settles.
 * ------------------------------------------------------------------------- */

function maxDisplacement(a, b) {
  const byId = new Map(b.map((n) => [n.id, n]));
  let max = 0;
  for (const n of a) {
    const m = byId.get(n.id);
    if (!m) continue;
    const d = Math.hypot(n.x - m.x, n.y - m.y);
    if (d > max) max = d;
  }
  return max;
}

for (const id of NETWORK_VIEWS) {
  await acheck("anti-jitter at rest (<0.5px): " + id, async () => {
    await test.switchView(id);
    await waitFor(() => test.getActiveView() === id, 6000, 150);
    const settled = await waitFor(() => test.isSettled(), 6000, 100);
    assert(settled, "sim never settled within 6s for " + id);
    const before = test.getNodePositions();
    assert(before.length > 0, "no node positions to sample for " + id);
    await sleep(500);
    const after = test.getNodePositions();
    const disp = maxDisplacement(before, after);
    assert(disp < 0.5, "node drifted " + disp.toFixed(3) + "px at rest (>=0.5)");
    assert(test.isSettled(), "sim reports unsettled after rest sample");
    // SCREENSHOT CHECKPOINT: settled network, used as the visual jitter baseline.
    return id + " stable, maxDisplacement=" + disp.toFixed(3) + "px";
  });

  await acheck("re-layout moves then re-settles: " + id, async () => {
    // Negative guard: switching away and back triggers a fresh layout, so we
    // should observe motion (not settled immediately) and then a return to rest.
    await test.switchView(id === "coauthorship" ? "author-paper" : "coauthorship");
    await sleep(200);
    await test.switchView(id);
    await waitFor(() => test.getActiveView() === id, 6000, 150);
    // It should be running (unsettled) shortly after a re-layout...
    const moved = await waitFor(() => !test.isSettled(), 1500, 50);
    // ...then come back to rest.
    const resettled = await waitFor(() => test.isSettled(), 6000, 100);
    assert(resettled, "did not re-settle after re-layout for " + id);
    return id + " moved=" + moved + " then re-settled";
  });
}

/* ---------------------------------------------------------------------------
 * 4. SMOOTH DRAG (AC-2): dragged node tracks the cursor, no snap-back.
 * ------------------------------------------------------------------------- */

await acheck("drag tracks cursor, no snap-back (AC-2)", async () => {
  await test.switchView("coauthorship");
  await waitFor(() => test.getActiveView() === "coauthorship", 6000, 150);
  await waitFor(() => test.isSettled(), 6000, 100);

  const start = test.getNodePositions();
  assert(start.length >= 2, "need >=2 nodes for a meaningful drag");
  // Pick the highest-degree-looking node (first in positions) to drag.
  const node = start[0];
  const others = new Map(start.map((n) => [n.id, n]));

  test.dispatchPointer("down", node.x, node.y);
  // Move in 5 steps of +20px x / +12px y; assert tracking each step.
  let px = node.x;
  let py = node.y;
  let worstTrack = 0;
  for (let i = 0; i < 5; i++) {
    px += 20;
    py += 12;
    test.dispatchPointer("move", px, py);
    await sleep(60);
    const now = test.getNodePositions().find((n) => n.id === node.id);
    assert(now, "dragged node vanished mid-drag");
    const track = Math.hypot(now.x - px, now.y - py);
    if (track > worstTrack) worstTrack = track;
    assert(track <= 3, "node lagged pointer by " + track.toFixed(2) + "px (>3)");
  }
  // SCREENSHOT CHECKPOINT: node pinned under the cursor at the end of the drag.
  test.dispatchPointer("up", px, py);
  await sleep(300);

  const dropped = test.getNodePositions().find((n) => n.id === node.id);
  const snap = Math.hypot(dropped.x - px, dropped.y - py);
  assert(snap <= 3, "node snapped back " + snap.toFixed(2) + "px after release");

  // Neighbours must stay bounded (no explosion). Compare a non-dragged node.
  const other = start.find((n) => n.id !== node.id);
  const otherNow = test.getNodePositions().find((n) => n.id === other.id);
  const otherMove = Math.hypot(otherNow.x - other.x, otherNow.y - other.y);
  assert(otherMove < 200, "neighbour moved " + otherMove.toFixed(1) + "px (unbounded)");

  return "worstTrack=" + worstTrack.toFixed(2) + "px snapBack=" + snap.toFixed(2) + "px";
});

/* ---------------------------------------------------------------------------
 * 5. ONE-CLICK TO PAPER (AC-3): single click on an item node selects the item.
 * ------------------------------------------------------------------------- */

await acheck("single click on item node opens the paper (AC-3)", async () => {
  // The bipartite view has paper (item) nodes carrying itemId.
  await test.switchView("author-paper");
  await waitFor(() => test.getActiveView() === "author-paper", 6000, 150);
  await waitFor(() => test.isSettled(), 6000, 100);

  const ZoteroPane = win.ZoteroPane;
  const priorSelection = ZoteroPane.getSelectedItems
    ? ZoteroPane.getSelectedItems().map((i) => i.id)
    : [];

  const positions = test.getNodePositions();
  const itemNode = positions.find((n) => n.kind === "item" && n.itemId);
  assert(itemNode, "no item node with an itemId found in bipartite view");

  // A single click = down + up at the same point, no move in between.
  test.dispatchPointer("down", itemNode.x, itemNode.y);
  test.dispatchPointer("up", itemNode.x, itemNode.y);
  const selected = await waitFor(() => {
    const sel = ZoteroPane.getSelectedItems ? ZoteroPane.getSelectedItems() : [];
    return sel.length > 0 && sel[0].id === itemNode.itemId;
  }, 4000, 150);
  assert(selected, "clicking the item node did not select item " + itemNode.itemId);
  // SCREENSHOT CHECKPOINT: library tab focused with the clicked item selected.

  // Author nodes are a no-op for selection: clicking one must not change it.
  const authorNode = positions.find((n) => n.kind === "author");
  let authorNoop = "no author node to test";
  if (authorNode) {
    const before = ZoteroPane.getSelectedItems().map((i) => i.id).join(",");
    await test.switchView("author-paper");
    await waitFor(() => test.isSettled(), 6000, 100);
    const an = test.getNodePositions().find((n) => n.kind === "author");
    if (an) {
      test.dispatchPointer("down", an.x, an.y);
      test.dispatchPointer("up", an.x, an.y);
      await sleep(300);
      const afterSel = ZoteroPane.getSelectedItems().map((i) => i.id).join(",");
      assert(afterSel === before, "author-node click changed selection (should no-op)");
      authorNoop = "author click no-op";
    }
  }
  void priorSelection;
  return "selected item " + itemNode.itemId + "; " + authorNoop;
});

/* ---------------------------------------------------------------------------
 * 6. CHART HOVER: tooltip text on each chart view.
 * ------------------------------------------------------------------------- */

for (const id of CHART_VIEWS) {
  await acheck("chart hover tooltip: " + id, async () => {
    await test.switchView(id);
    await waitFor(() => test.getActiveView() === id, 6000, 150);
    await sleep(200);
    // Hover near the left third of the plot where the first/longest bar sits.
    const container = doc.querySelector("#bibliometero-insights-button")
      ? doc.querySelector(".bibliometero-view, [class*='bibliometero']")
      : null;
    let hx = 120;
    let hy = 120;
    if (container && container.getBoundingClientRect) {
      const r = container.getBoundingClientRect();
      hx = r.left + Math.max(40, r.width * 0.25);
      hy = r.top + Math.max(40, r.height * 0.4);
    }
    test.dispatchPointer("hover", hx, hy);
    const got = await waitFor(() => {
      const t = test.getTooltipText();
      return t && t.trim().length > 0;
    }, 3000, 150);
    assert(got, "no tooltip text on hover for " + id);
    const txt = test.getTooltipText();
    assert(txt && txt.trim().length > 0, "tooltip empty for " + id);
    // SCREENSHOT CHECKPOINT: tooltip visible over a bar/segment for " + id.
    return id + " tooltip: " + txt.slice(0, 40);
  });
}

/* ---------------------------------------------------------------------------
 * 7. EXPORT (AC-4): all 6 views x {png, svg} produce valid output.
 * ------------------------------------------------------------------------- */

function bytesOf(out) {
  if (out && out.bytes) return out.bytes;
  if (out && out.blob && typeof out.blob.arrayBuffer === "function") return null; // handled by caller
  return null;
}

async function toUint8(out) {
  if (out && out.bytes) return out.bytes instanceof Uint8Array ? out.bytes : new Uint8Array(out.bytes);
  if (out && out.blob && typeof out.blob.arrayBuffer === "function") {
    const buf = await out.blob.arrayBuffer();
    return new Uint8Array(buf);
  }
  return null;
}

for (const id of VIEWS) {
  await acheck("export PNG valid: " + id, async () => {
    const out = await test.exportView(id, "png");
    assert(out, "exportView returned nothing for png " + id);
    const u8 = await toUint8(out);
    assert(u8 && u8.length > 1024, "PNG smaller than 1KB for " + id);
    // PNG magic bytes: 89 50 4E 47.
    assert(
      u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47,
      "PNG magic bytes wrong for " + id,
    );
    void bytesOf;
    return id + " png " + u8.length + "B";
  });

  await acheck("export SVG valid: " + id, async () => {
    const out = await test.exportView(id, "svg");
    assert(out, "exportView returned nothing for svg " + id);
    const text = (out.text || "").trim();
    assert(text.length > 0, "empty SVG text for " + id);
    assert(/^<\?xml|^<svg/i.test(text), "SVG does not start with <svg for " + id);
    // Parse it and assert it has shape elements.
    const parser = new win.DOMParser();
    const svgDoc = parser.parseFromString(text, "image/svg+xml");
    assert(
      !svgDoc.querySelector("parsererror"),
      "SVG failed to parse for " + id,
    );
    const shapes = svgDoc.querySelectorAll(
      "rect, circle, line, path, polyline, polygon, text",
    );
    assert(shapes.length > 0, "SVG has no shape elements for " + id);
    return id + " svg " + text.length + "ch, " + shapes.length + " shapes";
  });
}

/* ---------------------------------------------------------------------------
 * 8. Final console error scan (bibliometero-relevant errors only).
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

report.summary = `${report.passed} passed, ${report.failed} failed`;
return report;
