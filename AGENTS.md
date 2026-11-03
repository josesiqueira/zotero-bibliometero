# Instructions for coding agents

Zotero Bibliometero is a Zotero plugin (TypeScript, zotero-plugin-scaffold).

## Every feature change updates the documentation in the same commit

1. Edit the documentation source that matches the change (table in
   `CONTRIBUTING.md`): `src/modules/insights/views/catalog.json` for views,
   `docs/content.json` for the panel, right-click commands and settings.
2. Add a user-facing line under `## [Unreleased]` in `CHANGELOG.md`
   (Keep a Changelog: Added, Changed, Deprecated, Removed, Fixed, Security).
3. Run `npm run docs`, then `npm run docs:check`, and commit the regenerated
   `README.md` together with the code.

Never hand-edit text between `<!-- docs:NAME:start -->` and
`<!-- docs:NAME:end -->` in `README.md`; it is overwritten.

## Wording rules for user-facing text

- Never name a Zotero version (no "for Zotero 10", no "7+" badge, no minimum).
  The supported range lives only in `addon/manifest.json` (`strict_max_version`)
  and the served `update.json`. `npm run docs:check` enforces this.
- Plain words, sentence case, describe what the user sees and does.

## Checks before committing

```bash
npx tsc --noEmit
npm run test:unit
npm run build
npm run docs:check
```
