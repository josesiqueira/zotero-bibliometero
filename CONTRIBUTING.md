# Contributing

## Keeping the documentation in sync

The README, the [website](https://josesiqueira.github.io/zotero-bibliometero/)
and the view tooltips inside the plugin are generated from a few source files.
Edit the source, never the generated text.

| You changed                                                | Edit this file                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A view: added, removed, renamed, or it behaves differently | `src/modules/insights/views/catalog.json` (the plugin reads its labels and tooltips too) |
| The panel (dock, Maximize, source switch, export, refresh) | `docs/content.json`, `panel`                                                             |
| A right-click command                                      | `docs/content.json`, `commands`                                                          |
| A setting in `addon/prefs.js` or the Settings pane         | `docs/content.json`, `settings` (internal prefs go in `settings.internal`)               |
| Install steps, tagline, intro                              | `docs/content.json`                                                                      |
| Anything a user can notice                                 | `CHANGELOG.md`, under `## [Unreleased]`                                                  |

Then run:

```bash
npm run docs        # rewrites the generated parts of README.md and builds _site/
npm run docs:check  # the same check CI runs
```

and commit `README.md` with your change. Settings defaults and choices are read
straight from `addon/prefs.js` and `addon/content/preferences.xhtml`, so they
never need to be typed twice.

### What CI enforces

The `docs` job in `.github/workflows/ci.yml` fails when:

- `README.md` was not regenerated after a source file changed;
- a view has a factory in `views/index.ts` but no catalog entry, or the other way round;
- the Settings pane's Default view list does not match the catalog;
- a pref in `addon/prefs.js` or a control in the Settings pane is not documented;
- a right-click label in `set/contextMenus.ts` is not documented;
- `CHANGELOG.md` has no section for the version in `package.json`;
- user-facing text names a Zotero version (the supported range lives only in
  `addon/manifest.json` and the served `update.json`);
- a commit range changes `src/` or `addon/` without touching `CHANGELOG.md`.
  For changes users cannot notice (refactors, comments), put `[skip changelog]`
  in that commit's subject line, or add the `skip-changelog` label to the pull
  request.

The `pages` workflow rebuilds and deploys the website on every push to
`master`, so the site always describes what is on `master`.

## Releasing

1. Move the `## [Unreleased]` entries under a new `## [x.y.z] - YYYY-MM-DD`
   heading in `CHANGELOG.md` and update the compare links at the bottom.
2. Bump `version` in `package.json`, run `npm run docs`, commit.
3. Build with `npm run build`, test the `.xpi` in Zotero, tag `vx.y.z`, and
   publish the release with the `.xpi` attached. Paste the changelog section
   as the release notes.
