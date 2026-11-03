# Changelog

All notable changes to Zotero Bibliometero are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A documentation website on GitHub Pages, built from the same source files as the README.
- A Settings pane (Zotero Settings, Bibliometero). The settings existed but the pane was never registered, so it could not be opened.
- A legend on both network maps, and a status line under every view that says what is counted, what was left out and why, and what a click does.
- Keyboard resizing of the panel: focus the divider and use the arrow keys.

### Changed

- Co-authorship now shows research groups instead of a tangle of one-off authors: authors with at least 2 items (raised automatically so the map stays readable), coloured by group (Louvain, as in VOSviewer and bibliometrix), with labels that never overlap. Items with more than 25 authors no longer add links.
- Author / paper now answers which of your items come from the same people: it shows repeat authors and the items they link, coloured by year, instead of the items with the longest author lists.
- Clicking a bar, slice or author now selects exactly the items it counts, in the library the panel shows. Before, it typed the label into the search box, which found nothing for authors and too many items for years and sources, and always jumped to My Library.
- Clicking an item on the author/paper map selects it in the list; double-click opens it.
- Author names: accents and case are ignored, an initials-only form joins the matching full name, and different people who share an initial (Zhang, Yi and Zhang, Yu) stay apart. Labels show full names.
- Only authors are counted, not editors or translators (editors are used only for items with no authors).
- Top sources counts journals, proceedings, series and repositories, not publishers or universities, and merges spelling variants.
- Composition draws collections as bars of top-level collections (subcollections included), because an item can be in several collections; the donut is kept for item types, with small types grouped as Other types. Unfiled replaces Uncategorized.
- Publications per year marks the current year as still in progress and shows items with no date as a separate No date bar.
- Exports are figures for papers and slides: white background, title, legend, caption with library and date, 2400 x 1440 PNG (the co-authorship PNG was 26 MB, it is now well under 1 MB). File names include the view and the date.
- Network maps lay themselves out in about two seconds (was about nine), stay zoomed to fit while they settle, and keep their layout when the library changes.
- The curated set has one name everywhere ("curated set"), Clear all asks first, and switching to it opens the set view only when it is empty.
- Larger, clearer text in charts; labels in ranked charts are no longer cut at 28 characters.

### Fixed

- The Top-N value in Settings now sets how many bars Top sources and Top authors show. Before, it had no effect.
- The Default view setting now chooses the view the panel opens on. Before, it had no effect.
- Views now refresh when items are added, edited, trashed or deleted. Before, they kept showing the data from when they were opened.
- Selecting another library (a group) in the left pane now refreshes the panel.
- Changing the curated set while it is the source now updates the open view at once.
- Trashed items are no longer counted, also in the curated set.
- Maximize and Restore no longer create a second copy of the network map.
- Opening or closing a PDF tab no longer restarts the network layout.
- Hovering a network node no longer leaves its label stuck on the map.
- Export failures are reported in the status line, and the file extension is added when you type a name without one.
- The panel no longer keeps the previous version's styling after an update.

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
