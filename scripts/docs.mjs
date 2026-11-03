#!/usr/bin/env node
/* global process, console */
// Documentation generator and checker for Zotero Bibliometero.
//
// Sources (edit these, never the generated output):
//   src/modules/insights/views/catalog.json  the views (also read by the plugin)
//   docs/content.json                        panel, commands, settings, install
//   CHANGELOG.md                             release history (Keep a Changelog)
//   package.json                             name, version, description
//
// Outputs:
//   README.md     the parts between <!-- docs:NAME:start --> and <!-- docs:NAME:end -->
//   _site/        the GitHub Pages site (not committed; built by .github/workflows/pages.yml)
//
// Usage:
//   node scripts/docs.mjs           write README.md and build _site/
//   node scripts/docs.mjs --check   fail if README.md is out of date or the docs
//                                   disagree with the code (used by CI)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const readJSON = (p) => JSON.parse(read(p));

const pkg = readJSON("package.json");
const catalog = readJSON("src/modules/insights/views/catalog.json");
const content = readJSON("docs/content.json");
const changelog = read("CHANGELOG.md");
const prefsJs = read("addon/prefs.js");
const prefsXhtml = read("addon/content/preferences.xhtml");
const viewsIndex = read("src/modules/insights/views/index.ts");
const contextMenus = read("src/modules/insights/set/contextMenus.ts");

const REPO = "https://github.com/josesiqueira/zotero-bibliometero";
const XPI_URL = `${REPO}/releases/latest/download/zotero-bibliometero.xpi`;
const PAGES_URL = "https://josesiqueira.github.io/zotero-bibliometero/";
const BADGE_JSON =
  "https://raw.githubusercontent.com/josesiqueira/zotero-bibliometero/master/.github/badges/downloads.json";

const errors = [];
const fail = (msg) => errors.push(msg);

// ---------------------------------------------------------------------------
// Facts read from the code
// ---------------------------------------------------------------------------

/** Default prefs from addon/prefs.js: { key: value }. */
function parsePrefsJs(src) {
  const out = {};
  const re = /^\s*pref\(\s*"([^"]+)"\s*,\s*(.+?)\s*\)\s*;/gm;
  for (const m of src.matchAll(re)) out[m[1]] = JSON.parse(m[2]);
  return out;
}

/** Controls in the Settings pane: { pref: { choices: [{value,label}] | null, min, max } }. */
function parsePrefsPane(src) {
  const out = {};
  const menuRe =
    /<menulist\s+preference="([^"]+)"[^>]*>([\s\S]*?)<\/menulist>/g;
  for (const m of src.matchAll(menuRe)) {
    const choices = [
      ...m[2].matchAll(/<menuitem\s+value="([^"]+)"\s+label="([^"]+)"/g),
    ].map((c) => ({ value: c[1], label: c[2] }));
    out[m[1]] = { choices };
  }
  const inputRe = /<html:input\s+([^>]*?)preference="([^"]+)"([^>]*)\/>/g;
  for (const m of src.matchAll(inputRe)) {
    const attrs = m[1] + m[3];
    const min = /min="([^"]+)"/.exec(attrs)?.[1];
    const max = /max="([^"]+)"/.exec(attrs)?.[1];
    out[m[2]] = { choices: null, min, max };
  }
  return out;
}

/** View ids that have a factory in views/index.ts. */
function parseFactoryIds(src) {
  const block = /const FACTORIES[^{]*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/^\s*"?([\w-]+)"?\s*:/gm)].map((m) => m[1]);
}

/** Right-click labels defined in contextMenus.ts. */
function parseMenuLabels(src) {
  return [...src.matchAll(/^const LABEL_\w+\s*=\s*"([^"]+)"/gm)].map(
    (m) => m[1],
  );
}

const prefDefaults = parsePrefsJs(prefsJs);
const prefsPane = parsePrefsPane(prefsXhtml);
const factoryIds = parseFactoryIds(viewsIndex);
const menuLabels = parseMenuLabels(contextMenus);

// ---------------------------------------------------------------------------
// Coverage checks: the docs must describe exactly what the code ships
// ---------------------------------------------------------------------------

const views = catalog.views;
const viewIds = views.map((v) => v.id);
const sameSet = (a, b) =>
  a.length === b.length && a.every((x) => b.includes(x));

for (const v of views) {
  for (const f of ["id", "label", "kind", "tooltip", "summary", "details"]) {
    if (v[f] === undefined || v[f] === "")
      fail(`catalog.json: view "${v.id}" is missing "${f}".`);
  }
  if (!["network", "chart", "manage"].includes(v.kind))
    fail(`catalog.json: view "${v.id}" has unknown kind "${v.kind}".`);
}
if (!sameSet(viewIds, factoryIds))
  fail(
    `catalog.json views [${viewIds}] do not match the factories in views/index.ts [${factoryIds}]. ` +
      "Add the missing catalog entry or factory.",
  );

// The Settings pane's "Default view" list must offer every visual view, with catalog labels.
const dvChoices = prefsPane["hub.defaultView"]?.choices ?? [];
const visualViews = views.filter((v) => v.kind !== "manage");
if (
  !sameSet(
    dvChoices.map((c) => c.value),
    visualViews.map((v) => v.id),
  )
)
  fail(
    "preferences.xhtml: the Default view list does not offer exactly the catalog's views " +
      `(${visualViews.map((v) => v.id)}).`,
  );
for (const c of dvChoices) {
  const v = views.find((x) => x.id === c.value);
  if (v && v.label !== c.label)
    fail(
      `preferences.xhtml: Default view label "${c.label}" differs from catalog label "${v.label}".`,
    );
}

// Every pref in prefs.js is documented as a setting or listed as internal.
const documentedPrefs = content.settings.items.map((s) => s.pref);
const knownPrefs = [...documentedPrefs, ...content.settings.internal];
for (const key of Object.keys(prefDefaults))
  if (!knownPrefs.includes(key))
    fail(
      `addon/prefs.js: pref "${key}" is not in docs/content.json settings.items or settings.internal.`,
    );
for (const key of knownPrefs)
  if (!(key in prefDefaults))
    fail(`docs/content.json: pref "${key}" does not exist in addon/prefs.js.`);
// Every control in the Settings pane is documented.
for (const key of Object.keys(prefsPane))
  if (!documentedPrefs.includes(key))
    fail(
      `preferences.xhtml: the control for "${key}" is not documented in docs/content.json settings.items.`,
    );
for (const key of documentedPrefs)
  if (!(key in prefsPane))
    fail(
      `docs/content.json: setting "${key}" has no control in preferences.xhtml (move it to settings.internal).`,
    );

// Every right-click command is documented, and nothing extra.
const docLabels = content.commands.map((c) => c.label);
if (!sameSet(menuLabels, docLabels))
  fail(
    `Right-click labels in contextMenus.ts [${menuLabels}] do not match docs/content.json commands [${docLabels}].`,
  );

// Changelog follows Keep a Changelog and covers the current version.
if (!/^## \[Unreleased\]/m.test(changelog))
  fail("CHANGELOG.md: missing the ## [Unreleased] section.");
if (
  !new RegExp(
    `^## \\[${pkg.version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}`,
    "m",
  ).test(changelog)
)
  fail(
    `CHANGELOG.md: no "## [${pkg.version}] - YYYY-MM-DD" section for the version in package.json.`,
  );

// House rule: user-facing text never names a Zotero version (the range lives in
// manifest.json and update.json only).
const versionRe = /Zotero\s+(?:version\s+)?\d+(?:\.\d+)*\+?/i;
for (const [file, text] of [
  ["catalog.json", JSON.stringify(catalog)],
  ["docs/content.json", JSON.stringify(content)],
  ["CHANGELOG.md", changelog],
  ["package.json description", pkg.description],
])
  if (versionRe.test(text))
    fail(
      `${file}: names a Zotero version ("${versionRe.exec(text)[0]}"). Remove it.`,
    );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const mdCell = (s) => String(s).replace(/\|/g, "\\|");

function settingRows() {
  return content.settings.items.map((s) => {
    const pane = prefsPane[s.pref] ?? {};
    const def = prefDefaults[s.pref];
    let choices;
    let defLabel = String(def);
    if (pane.choices) {
      choices = pane.choices.map((c) => c.label);
      defLabel =
        pane.choices.find((c) => c.value === def)?.label ?? String(def);
    } else {
      choices = [`a number from ${pane.min} to ${pane.max}`];
    }
    return { ...s, choices, defLabel };
  });
}

/** Release sections of CHANGELOG.md: [{ title, date, body }]. */
function parseChangelog(src) {
  const parts = src.split(/^## /m).slice(1);
  return parts.map((part) => {
    const [head, ...rest] = part.split("\n");
    const m = /^\[([^\]]+)\](?: - (\S+))?/.exec(head);
    const body = rest
      .join("\n")
      .replace(/^\[[^\]]+\]: .*$/gm, "")
      .trim();
    return { title: m?.[1] ?? head, date: m?.[2] ?? "", body };
  });
}

/** Markdown subset used in CHANGELOG.md (### headings, bullets, paragraphs, links, code). */
function mdToHtml(md) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = false;
  for (const line of md.split("\n")) {
    if (/^- /.test(line)) {
      if (!list) (out.push("<ul>"), (list = true));
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    if (list) (out.push("</ul>"), (list = false));
    if (/^### /.test(line)) out.push(`<h4>${inline(line.slice(4))}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// README sections
// ---------------------------------------------------------------------------

function readmeSections() {
  const s = {};
  s.intro = content.intro;

  s.views = [
    "| View | What it shows |",
    "|---|---|",
    ...views.map((v) => `| ${mdCell(v.label)} | ${mdCell(v.summary)} |`),
    "",
    ...views.flatMap((v) => [
      `**${v.label}**`,
      "",
      ...v.details.map((d) => `- ${d}`),
      "",
    ]),
  ]
    .join("\n")
    .trimEnd();

  s.panel = content.panel.map((p) => `- **${p.title}.** ${p.text}`).join("\n");

  s.commands = [
    "| Where | Command | What it does |",
    "|---|---|---|",
    ...content.commands.map(
      (c) => `| ${mdCell(c.where)} | ${mdCell(c.label)} | ${mdCell(c.text)} |`,
    ),
  ].join("\n");

  s.settings = [
    `Open ${content.settings.where}.`,
    "",
    "| Setting | Choices | Default | What it does |",
    "|---|---|---|---|",
    ...settingRows().map(
      (r) =>
        `| ${mdCell(r.label)} | ${mdCell(r.choices.join(", "))} | ${mdCell(r.defLabel)} | ${mdCell(r.text)} |`,
    ),
  ].join("\n");

  s.install = [
    ...content.install.map(
      (step, i) =>
        `${i + 1}. ${step.replace("the latest release", `[the latest release](${REPO}/releases/latest)`)}`,
    ),
    "",
    content.installNote,
    "",
    `Full guide: <${PAGES_URL}>`,
  ].join("\n");
  return s;
}

function renderReadme(current) {
  let next = current;
  for (const [name, body] of Object.entries(readmeSections())) {
    const re = new RegExp(
      `(<!-- docs:${name}:start[^>]*-->)[\\s\\S]*?(<!-- docs:${name}:end -->)`,
    );
    if (!re.test(next)) {
      fail(
        `README.md: missing the <!-- docs:${name}:start --> / <!-- docs:${name}:end --> markers.`,
      );
      continue;
    }
    next = next.replace(re, (_, a, b) => `${a}\n${body}\n${b}`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

/** Small drawing for each view, by id, falling back to the view's kind. */
function viewDrawing(v) {
  const ink = 'stroke="currentColor"';
  const nodes = (pts, r = 3.2) =>
    pts
      .map(
        ([x, y], i) =>
          `<circle cx="${x}" cy="${y}" r="${i % 4 === 0 ? r + 2 : r}" class="n${i % 3}"/>`,
      )
      .join("");
  const lines = (pairs, pts) =>
    pairs
      .map(
        ([a, b]) =>
          `<line x1="${pts[a][0]}" y1="${pts[a][1]}" x2="${pts[b][0]}" y2="${pts[b][1]}"/>`,
      )
      .join("");
  const drawings = {
    coauthorship: () => {
      const p = [
        [30, 40],
        [52, 22],
        [58, 52],
        [80, 34],
        [100, 18],
        [104, 56],
        [126, 40],
        [76, 66],
        [140, 22],
        [18, 62],
      ];
      const e = [
        [0, 1],
        [0, 2],
        [1, 3],
        [2, 3],
        [3, 4],
        [3, 5],
        [5, 6],
        [4, 6],
        [2, 7],
        [6, 8],
        [0, 9],
        [7, 5],
      ];
      return `<g class="edges" ${ink}>${lines(e, p)}</g>${nodes(p)}`;
    },
    "author-paper": () => {
      const papers = [
        [40, 20],
        [40, 50],
        [120, 34],
        [120, 64],
      ];
      const authors = [
        [80, 12],
        [80, 40],
        [80, 68],
        [20, 36],
        [146, 48],
      ];
      const e = [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 2],
        [2, 0],
        [2, 1],
        [3, 2],
        [0, 3],
        [1, 3],
        [3, 4],
        [2, 4],
      ];
      const l = e
        .map(
          ([a, b]) =>
            `<line x1="${papers[a][0]}" y1="${papers[a][1]}" x2="${authors[b][0]}" y2="${authors[b][1]}"/>`,
        )
        .join("");
      return `<g class="edges" ${ink}>${l}</g>${papers.map(([x, y]) => `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" class="n1"/>`).join("")}${authors.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4.5" class="n0"/>`).join("")}`;
    },
    "pubs-per-year": () =>
      [8, 14, 11, 22, 30, 26, 41, 36, 50, 44, 18]
        .map(
          (h, i) =>
            `<rect x="${12 + i * 13}" y="${74 - h}" width="10" height="${h}" class="${i === 10 ? "n2" : "n0"}"/>`,
        )
        .join("") +
      `<line x1="8" y1="74.5" x2="156" y2="74.5" ${ink} class="axis"/>`,
    "top-sources": () =>
      [130, 104, 88, 70, 52, 40]
        .map(
          (w, i) =>
            `<rect x="14" y="${8 + i * 11}" width="${w}" height="8" class="n0"/>`,
        )
        .join(""),
    "top-authors": () =>
      [120, 112, 90, 66, 60, 44]
        .map(
          (w, i) =>
            `<rect x="14" y="${8 + i * 11}" width="${w}" height="8" class="n1"/>`,
        )
        .join(""),
    composition: () => {
      const donut = (cx, parts) => {
        let a = -Math.PI / 2;
        const r = 26;
        return parts
          .map((f, i) => {
            const b = a + f * 2 * Math.PI;
            const large = f > 0.5 ? 1 : 0;
            const d = `M${cx + r * Math.cos(a)} ${40 + r * Math.sin(a)} A${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(b)} ${40 + r * Math.sin(b)}`;
            a = b;
            return `<path d="${d}" class="arc a${i}"/>`;
          })
          .join("");
      };
      return donut(46, [0.5, 0.28, 0.22]) + donut(118, [0.36, 0.34, 0.3]);
    },
    set: () =>
      [0, 1, 2, 3]
        .map(
          (i) =>
            `<rect x="12" y="${8 + i * 17}" width="${96 - i * 12}" height="5" class="n0"/><rect x="12" y="${16 + i * 17}" width="44" height="3" class="muted"/><rect x="146" y="${8 + i * 17}" width="8" height="9" class="n2"/>`,
        )
        .join(""),
  };
  const fallback = {
    network: drawings.coauthorship,
    chart: drawings["top-sources"],
    manage: drawings.set,
  };
  const draw = drawings[v.id] ?? fallback[v.kind];
  return `<svg class="drawing" viewBox="0 0 164 80" aria-hidden="true" focusable="false">${draw()}</svg>`;
}

function renderSite() {
  const releases = parseChangelog(changelog);
  const rows = settingRows();
  const panel = content.panel
    .map(
      (p) =>
        `<div class="feature"><dt>${esc(p.title)}</dt><dd>${esc(p.text)}</dd></div>`,
    )
    .join("\n");
  const viewRows = views
    .map(
      (v) => `<article class="view" id="view-${esc(v.id)}">
  ${viewDrawing(v)}
  <div class="view-text">
    <h3>${esc(v.label)}</h3>
    <p class="summary">${esc(v.summary)}</p>
    <ul>${v.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
  </div>
</article>`,
    )
    .join("\n");
  const commands = content.commands
    .map(
      (c) =>
        `<tr><td>${esc(c.where)}</td><th scope="row">${esc(c.label)}</th><td>${esc(c.text)}</td></tr>`,
    )
    .join("\n");
  const settings = rows
    .map(
      (r) =>
        `<tr><th scope="row">${esc(r.label)}</th><td>${esc(r.choices.join(", "))}</td><td>${esc(r.defLabel)}</td><td>${esc(r.text)}</td></tr>`,
    )
    .join("\n");
  const install = content.install
    .map(
      (s) =>
        `<li>${esc(s).replace("the latest release", `<a href="${REPO}/releases/latest">the latest release</a>`)}</li>`,
    )
    .join("\n");
  const changes = releases
    .map(
      (r) => `<section class="release">
  <h3>${r.title === "Unreleased" ? "Not released yet" : `Version ${esc(r.title)}`}${r.date ? ` <time datetime="${esc(r.date)}">${esc(r.date)}</time>` : ""}</h3>
  ${mdToHtml(r.body)}
</section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zotero Bibliometero</title>
<meta name="description" content="${esc(pkg.description)}">
<link rel="icon" href="favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,560;6..72,700&family=Public+Sans:wght@400;600&display=swap">
<link rel="stylesheet" href="style.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="bar">
  <a class="brand" href="./"><img src="favicon.png" alt="" width="20" height="20">Bibliometero</a>
  <nav aria-label="Sections">
    <a href="#views">Views</a>
    <a href="#panel">The panel</a>
    <a href="#settings">Settings</a>
    <a href="#install">Install</a>
    <a href="#changes">Changes</a>
    <a href="${REPO}">GitHub</a>
  </nav>
</header>
<main id="main">
<section class="hero">
  <div class="hero-text">
    <h1>Zotero Bibliometero</h1>
    <p class="lede">${esc(content.tagline)}</p>
    <p>${esc(content.intro)}</p>
    <p class="actions">
      <a class="button primary" href="${XPI_URL}">Download version ${esc(pkg.version)}</a>
      <a class="button" href="#install">How to install</a>
    </p>
    <p class="meta" id="downloads" hidden></p>
  </div>
  <figure class="hero-graph">
    <canvas id="graph" aria-label="An example co-authorship network made from mock data. You can drag the nodes." role="img"></canvas>
    <figcaption>An example co-authorship network (mock data). Drag a node.</figcaption>
  </figure>
</section>

<section id="views" class="block">
  <h2>The views</h2>
  <p class="section-lede">Pick a view from the strip at the top of the panel. Hover its name for a one-line reminder of what it shows.</p>
  ${viewRows}
</section>

<section id="panel" class="block">
  <h2>Working in the panel</h2>
  <dl class="features">
${panel}
  </dl>
  <h3 class="sub">Right-click commands</h3>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col">Where</th><th scope="col">Command</th><th scope="col">What it does</th></tr></thead>
    <tbody>
${commands}
    </tbody>
  </table></div>
</section>

<section id="settings" class="block">
  <h2>Settings</h2>
  <p class="section-lede">Open ${esc(content.settings.where)}.</p>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col">Setting</th><th scope="col">Choices</th><th scope="col">Default</th><th scope="col">What it does</th></tr></thead>
    <tbody>
${settings}
    </tbody>
  </table></div>
</section>

<section id="install" class="block">
  <h2>Install</h2>
  <ol class="steps">
${install}
  </ol>
  <p>${esc(content.installNote)}</p>
</section>

<section id="changes" class="block">
  <h2>What changed</h2>
  ${changes}
  <p><a href="${REPO}/blob/master/CHANGELOG.md">Full changelog on GitHub</a></p>
</section>
</main>
<footer class="foot">
  <p>Zotero Bibliometero ${esc(pkg.version)} is free software under the <a href="${REPO}/blob/master/LICENSE">AGPL-3.0-or-later</a> license.
  <a href="${REPO}">Source code</a>, <a href="${REPO}/issues">report a problem</a>.</p>
  <p>Zotero is a project of the Corporation for Digital Scholarship. This plugin is independent of it.</p>
</footer>
<script>window.BADGE_JSON = ${JSON.stringify(BADGE_JSON)};</script>
<script src="hero.js" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const readmePath = path.join(ROOT, "README.md");
const readme = fs.readFileSync(readmePath, "utf8");
const nextReadme = renderReadme(readme);
const html = renderSite();

if (CHECK) {
  if (nextReadme !== readme)
    fail(
      "README.md is out of date with the docs sources. Run `npm run docs` and commit the result.",
    );
} else if (!errors.length) {
  fs.writeFileSync(readmePath, nextReadme);
  const out = path.join(ROOT, "_site");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "index.html"), html);
  for (const f of ["style.css", "hero.js"])
    fs.copyFileSync(path.join(ROOT, "docs/site", f), path.join(out, f));
  fs.copyFileSync(
    path.join(ROOT, "addon/content/icons/favicon.png"),
    path.join(out, "favicon.png"),
  );
  fs.writeFileSync(path.join(out, ".nojekyll"), "");
}

if (errors.length) {
  console.error(`Documentation check failed (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  CHECK
    ? "Documentation is in sync with the code."
    : "Wrote README.md and _site/.",
);
