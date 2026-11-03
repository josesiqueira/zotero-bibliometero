# Changelog

All notable changes to Zotero Bibliometero are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A documentation website on GitHub Pages, built from the same source files as the README.

### Changed

- The Top sources and Composition tooltips say that you can click through to your items.

### Fixed

- The Top-N value in Settings now sets how many bars Top sources and Top authors show. Before, it had no effect.

## [0.0.2] - 2026-10-01

First release.

### Added

- An Insights panel that opens under the item list from a chart button in the tab bar, with a resizable height and a Maximize button that moves it to a full tab.
- Six views of your library: co-authorship network, author/paper network, publications per year, top sources, top authors, and item type and collection composition.
- A curated set: pick papers with Add to Insights (items) or Add collection to Insights (collections), and manage them in the Set view.
- Click-through from charts to the matching items in your library.
- PNG and SVG export for every view.
- Settings for the default view, theme, source and Top-N.

### Fixed

- No longer logs a "getSelectedLibraryID() was removed" error on every library lookup.

[Unreleased]: https://github.com/josesiqueira/zotero-bibliometero/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/josesiqueira/zotero-bibliometero/releases/tag/v0.0.2
