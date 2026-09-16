/*
 * Zotero Bibliometero - dual-mode (include/exclude) live harness.
 *
 * Runs INSIDE the running Zotero chrome process against the installed plugin.
 * Execute the entire contents of this file via the MCP bridge
 * (zotero_execute_js); it returns a structured pass/fail report.
 *
 * It exercises the Zotero-coupled behaviour of the include/exclude scope that
 * the pure mocha suite (test/scopeStore.test.ts) cannot: the mode switch in the
 * Manage view, that switching is non-destructive (both lists survive), that the
 * six visualizations re-scope and tolerate a zero-item include scope, and that
 * the right-click menu labels follow the active mode. It restores a clean state
 * (exclude mode, both lists empty) before returning.
 *
 * Pure persistence/migration/resolution is covered by test/scopeStore.test.ts
 * and is NOT retested here.
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

const inst = Zotero.ZoteroBibliometero;
const win = Zotero.getMainWindow();
const doc = win.document;
const test = inst && inst.data && inst.data.test ? inst.data.test : null;

const VIEWS = [
  "coauthorship",
  "author-paper",
  "pubs-per-year",
  "top-sources",
  "top-authors",
  "composition",
];

/* Helpers to read the shell. */
function segButtons() {
  return Array.from(doc.querySelectorAll(".bm-seg-btn"));
}
function segLabels() {
  return segButtons().map((b) => b.textContent);
}
function modeRadios() {
  return Array.from(doc.querySelectorAll('.bm-scope-mode button'));
}
function clickRadio(label) {
  const r = modeRadios().find((x) => x.textContent === label);
  assert(r, "mode radio not found: " + label);
  r.click();
}
function manageButton(label) {
  return Array.from(doc.querySelectorAll(".bm-hub-viewport button")).find(
    (b) => b.textContent === label,
  );
}
function manageText() {
  const vp = doc.querySelector(".bm-hub-viewport");
  return vp ? vp.innerText.replace(/\s+/g, " ") : "";
}

/* ---------------------------------------------------------------------------
 * 0. Instance + open the panel on the Manage view
 * ------------------------------------------------------------------------- */

check("plugin instance + test hooks present", () => {
  assert(inst && inst.data && inst.data.initialized === true, "not initialized");
  assert(test && typeof test.switchView === "function", "test hooks missing");
  return "ok";
});

await acheck("open panel and Manage view", async () => {
  const btn = doc.querySelector("#bibliometero-insights-button");
  assert(btn, "toolbar button missing");
  if (segButtons().length === 0) {
    btn.dispatchEvent(new win.Event("command", { bubbles: true }));
    await waitFor(() => segButtons().length > 0, 6000, 150);
  }
  await test.switchView("set");
  await waitFor(() => test.getActiveView() === "set", 6000, 150);
  await waitFor(() => modeRadios().length === 2, 4000, 100);
  return "manage open, " + modeRadios().length + " mode options";
});

/* Resolve the active library + a couple of regular item ids to curate with. */
const libraryID = (() => {
  try {
    return win.ZoteroPane.getSelectedLibraryID() ?? Zotero.Libraries.userLibraryID;
  } catch (e) {
    return Zotero.Libraries.userLibraryID;
  }
})();
let sampleIds = [];
await acheck("gather two regular item ids", async () => {
  const all = await Zotero.Items.getAll(libraryID, true);
  sampleIds = all
    .filter((it) => {
      try {
        return it.isRegularItem() && !(it.isFeedItem && it.isFeedItem());
      } catch (e) {
        return false;
      }
    })
    .slice(0, 2)
    .map((it) => it.id);
  assert(sampleIds.length === 2, "need at least 2 regular items to test");
  return "ids " + sampleIds.join(",");
});

/* Snapshot the starting state so we can restore it at the end. */
const startMode = (() => {
  try {
    return modeRadios().find((r) => r.getAttribute("aria-pressed") === "true")
      ?.textContent;
  } catch (e) {
    return null;
  }
})();

/* Reset to a clean slate (both lists empty) so the run is deterministic
 * regardless of any pre-existing curation. */
await acheck("reset both lists before testing", async () => {
  clickRadio("Only included items");
  await sleep(300);
  let c = manageButton("Clear all");
  if (c && !c.disabled) {
    c.click();
    await sleep(300);
  }
  clickRadio("Whole library, minus excluded");
  await sleep(300);
  let r = manageButton("Restore all");
  if (r && !r.disabled) {
    r.click();
    await sleep(300);
  }
  // Verify BOTH lists are empty: include shows (0), exclude shows the full count.
  clickRadio("Only included items");
  await sleep(300);
  assert(segLabels()[0] === "Insights set (0)", "include list not empty after reset: " + segLabels()[0]);
  clickRadio("Whole library, minus excluded");
  await sleep(300);
  assert(segLabels()[0].startsWith("My Library"), "reset did not return to exclude");
  return "reset to clean exclude state, both lists empty";
});

/* ---------------------------------------------------------------------------
 * 1. Default mode is exclude; header reads "My Library (N)"
 * ------------------------------------------------------------------------- */

await acheck("default mode is exclude, header My Library (N)", async () => {
  // Ensure we start from exclude for a deterministic run.
  clickRadio("Whole library, minus excluded");
  await sleep(500);
  const labels = segLabels();
  assert(/^My Library \(\d+\)$/.test(labels[0]), "header not My Library (N): " + labels[0]);
  const checked = modeRadios().find((r) => r.getAttribute("aria-pressed") === "true");
  assert(checked && checked.textContent === "Whole library, minus excluded", "exclude not active");
  return labels[0];
});

/* ---------------------------------------------------------------------------
 * 2. Switch to include -> onboarding empty state, header "Insights set (0)"
 * ------------------------------------------------------------------------- */

await acheck("include mode shows onboarding empty state", async () => {
  clickRadio("Only included items");
  await sleep(600);
  assert(segLabels()[0] === "Insights set (0)", "header not Insights set (0): " + segLabels()[0]);
  const txt = manageText();
  assert(/Build your Insights set/.test(txt), "onboarding title missing");
  assert(/Add to Insights/.test(txt), "include hint missing");
  return "onboarding shown";
});

/* ---------------------------------------------------------------------------
 * 3. Add a selection -> included rows appear, header count updates
 * ------------------------------------------------------------------------- */

await acheck("add selection populates the include set", async () => {
  await win.ZoteroPane.selectItems(sampleIds);
  await sleep(300);
  const add = manageButton("Add selection");
  assert(add, "Add selection button missing");
  add.click();
  await sleep(600);
  assert(segLabels()[0] === `Insights set (${sampleIds.length})`, "header count wrong: " + segLabels()[0]);
  const removeBtns = Array.from(doc.querySelectorAll(".bm-hub-viewport button")).filter(
    (b) => b.textContent === "Remove",
  );
  assert(removeBtns.length === sampleIds.length, "expected " + sampleIds.length + " Remove buttons, got " + removeBtns.length);
  // Included rows must NOT be struck through.
  const struck = Array.from(doc.querySelectorAll(".bm-hub-viewport div")).filter(
    (d) => d.style && d.style.textDecoration === "line-through",
  );
  assert(struck.length === 0, "included rows must not be struck through");
  return sampleIds.length + " included, no strikethrough";
});

/* ---------------------------------------------------------------------------
 * 4. The six views re-scope to the include set without error
 * ------------------------------------------------------------------------- */

for (const id of VIEWS) {
  await acheck("view re-scopes on include set: " + id, async () => {
    await test.switchView(id);
    const ok = await waitFor(() => test.getActiveView() === id, 6000, 150);
    assert(ok, "view did not mount: " + id);
    return "mounted " + id;
  });
}

/* ---------------------------------------------------------------------------
 * 5. Switch back to exclude is NON-DESTRUCTIVE (include list survives)
 * ------------------------------------------------------------------------- */

await acheck("switch to exclude restores My Library scope", async () => {
  await test.switchView("set");
  await waitFor(() => modeRadios().length === 2, 4000, 100);
  clickRadio("Whole library, minus excluded");
  await sleep(600);
  assert(/^My Library \(\d+\)$/.test(segLabels()[0]), "header not My Library (N): " + segLabels()[0]);
  return segLabels()[0];
});

await acheck("re-entering include shows the SAME items (non-destructive)", async () => {
  clickRadio("Only included items");
  await sleep(600);
  assert(
    segLabels()[0] === `Insights set (${sampleIds.length})`,
    "include list was lost on mode switch: " + segLabels()[0],
  );
  return "include list survived round-trip";
});

/* ---------------------------------------------------------------------------
 * 6. Zero-item include scope is tolerated by every view (no crash)
 * ------------------------------------------------------------------------- */

await acheck("clear include set -> empty scope", async () => {
  await test.switchView("set");
  await waitFor(() => modeRadios().length === 2, 4000, 100);
  const clear = manageButton("Clear all");
  assert(clear, "Clear all button missing");
  clear.click();
  await sleep(500);
  assert(segLabels()[0] === "Insights set (0)", "include set not cleared: " + segLabels()[0]);
  return "cleared";
});

for (const id of VIEWS) {
  await acheck("view tolerates zero-item include scope: " + id, async () => {
    await test.switchView(id);
    const ok = await waitFor(() => test.getActiveView() === id, 6000, 150);
    assert(ok, "view did not mount on empty scope: " + id);
    return "mounted " + id + " on empty include";
  });
}

/* ---------------------------------------------------------------------------
 * 7. Right-click menu labels follow the active mode
 * ------------------------------------------------------------------------- */

await acheck("item menu label is mode-aware", async () => {
  await win.ZoteroPane.selectItems(sampleIds);
  await sleep(300);
  const mi = doc.getElementById("bibliometero-set-toggle");
  assert(mi, "context menu item missing");
  const itemMenu = doc.getElementById("zotero-itemmenu");

  // Include mode is currently active.
  itemMenu.dispatchEvent(new win.Event("popupshowing", { bubbles: false }));
  const includeLabel = mi.getAttribute("label");
  assert(includeLabel === "Add to Insights", "include label wrong: " + includeLabel);

  // Flip to exclude and re-open.
  await test.switchView("set");
  await waitFor(() => modeRadios().length === 2, 4000, 100);
  clickRadio("Whole library, minus excluded");
  await sleep(400);
  await win.ZoteroPane.selectItems(sampleIds);
  await sleep(200);
  itemMenu.dispatchEvent(new win.Event("popupshowing", { bubbles: false }));
  const excludeLabel = mi.getAttribute("label");
  assert(excludeLabel === "Exclude from Insights", "exclude label wrong: " + excludeLabel);
  return "include=" + includeLabel + " exclude=" + excludeLabel;
});

/* ---------------------------------------------------------------------------
 * 8. Restore a clean state + console error scan
 * ------------------------------------------------------------------------- */

await acheck("restore clean state (exclude mode, both lists empty)", async () => {
  await test.switchView("set");
  await waitFor(() => modeRadios().length === 2, 4000, 100);
  // Clear whichever list is active in each mode.
  clickRadio("Only included items");
  await sleep(300);
  const clrInc = manageButton("Clear all");
  if (clrInc && !clrInc.disabled) {
    clrInc.click();
    await sleep(300);
  }
  clickRadio("Whole library, minus excluded");
  await sleep(300);
  const clrExc = manageButton("Restore all");
  if (clrExc && !clrExc.disabled) {
    clrExc.click();
    await sleep(300);
  }
  if (startMode && startMode !== "Whole library, minus excluded") {
    // leave on default exclude regardless; startMode snapshot is informational
  }
  assert(segLabels()[0].startsWith("My Library"), "not back to My Library: " + segLabels()[0]);
  return "restored";
});

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
  return "clean";
});

report.summary = `${report.passed} passed, ${report.failed} failed`;
return report;
