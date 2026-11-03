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

// Every screenshot the docs show exists in both themes.
const IMAGE_DIR = "docs/images";
const imageNames = [
  ...views.map((v) => v.image),
  content.hero.image,
  ...content.firstUse.filter((s) => s.image).map((s) => s.image),
];
for (const v of views)
  if (!v.question || !v.image)
    fail(`catalog.json: view "${v.id}" needs "question" and "image".`);
for (const name of imageNames)
  for (const theme of ["light", "dark"])
    if (
      name &&
      !fs.existsSync(path.join(ROOT, IMAGE_DIR, `${name}-${theme}.png`))
    )
      fail(
        `${IMAGE_DIR}/${name}-${theme}.png is missing (a screenshot the docs show).`,
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

/** Light and dark screenshot; GitHub and browsers pick the one matching the reader's theme. */
function picture(name, alt, base, attrs = "") {
  return [
    "<picture>",
    `  <source media="(prefers-color-scheme: dark)" srcset="${base}/${name}-dark.png">`,
    `  <img src="${base}/${name}-light.png" alt="${esc(alt)}"${attrs}>`,
    "</picture>",
  ].join("\n");
}

/** The anchor GitHub gives a heading ("Author / paper" -> "author--paper"). */
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");

/** Install steps followed by the first-use steps, as one numbered list. */
function startSteps() {
  return [...content.install.map((text) => ({ text })), ...content.firstUse];
}

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
  const img = IMAGE_DIR;
  s.hero = [
    picture(content.hero.image, content.hero.alt, img),
    "",
    `<sub>${esc(content.hero.caption)}</sub>`,
  ].join("\n");

  s.intro = content.intro;

  s.views = [
    "| View | The question it answers |",
    "|---|---|",
    ...views.map(
      (v) =>
        `| [${mdCell(v.label)}](#${slug(v.label)}) | ${mdCell(v.question)} |`,
    ),
    "",
    ...views.flatMap((v) => [
      `### ${v.label}`,
      "",
      `**${v.question}** ${v.summary}`,
      "",
      picture(v.image, `${v.label} view: ${v.summary}`, img),
      "",
      "<details>",
      "<summary>How to read it</summary>",
      "",
      ...v.details.map((d) => `- ${d}`),
      "",
      "</details>",
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
    ...startSteps().flatMap((step, i) => {
      const line = `${i + 1}. ${step.text.replace("the latest release", `[the latest release](${REPO}/releases/latest)`)}`;
      return step.image
        ? [
            line,
            "",
            // Indented, so the picture belongs to the step and the list keeps going.
            picture(step.image, step.alt || "", img, ' width="300"')
              .split("\n")
              .map((l) => `   ${l}`)
              .join("\n"),
            "",
          ]
        : [line];
    }),
    "",
    content.installNote,
    "",
    `Full guide: <${PAGES_URL}>`,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
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
  <div class="view-text">
    <h3>${esc(v.label)}</h3>
    <p class="question">${esc(v.question)}</p>
    <p class="summary">${esc(v.summary)}</p>
  </div>
  <figure class="shot">${picture(v.image, `${v.label} view: ${v.summary}`, "images", ' loading="lazy"')}</figure>
  <details class="how">
    <summary>How to read it</summary>
    <ul>${v.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
  </details>
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
  const install = startSteps()
    .map(
      (s) =>
        `<li>${esc(s.text).replace("the latest release", `<a href="${REPO}/releases/latest">the latest release</a>`)}${
          s.image
            ? `<div class="step-shot">${picture(s.image, s.alt || "", "images", ' width="300"')}</div>`
            : ""
        }</li>`,
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
<link rel="icon" href="icon-small.svg" type="image/svg+xml">
<link rel="icon" href="favicon.png" type="image/png">
<link rel="apple-touch-icon" href="favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,560;6..72,700&family=Public+Sans:wght@400;600&display=swap">
<link rel="stylesheet" href="style.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="bar">
  <a class="brand" href="./"><img src="icon-small.svg" alt="" width="26" height="26">Bibliometero</a>
  <nav aria-label="Sections">
    <a href="#views">Views</a>
    <a href="#panel">The panel</a>
    <a href="#settings">Settings</a>
    <a href="#install">Get started</a>
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

<section class="block in-zotero" aria-label="Screenshot">
  <figure class="shot wide">${picture(content.hero.image, content.hero.alt, "images")}
    <figcaption>${esc(content.hero.caption)}</figcaption>
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
  <h2>Get started</h2>
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
  for (const [from, to] of [
    ["addon/content/icons/favicon.png", "favicon.png"],
    ["addon/content/icons/icon.svg", "icon.svg"],
    ["addon/content/icons/icon-small.svg", "icon-small.svg"],
  ])
    fs.copyFileSync(path.join(ROOT, from), path.join(out, to));
  fs.mkdirSync(path.join(out, "images"));
  for (const f of fs.readdirSync(path.join(ROOT, IMAGE_DIR)))
    if (f.endsWith(".png"))
      fs.copyFileSync(
        path.join(ROOT, IMAGE_DIR, f),
        path.join(out, "images", f),
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
