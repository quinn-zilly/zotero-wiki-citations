# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-21

Initial release.

### Added

- Detect author–year in-text citations (e.g. `(Hulleman & Harackiewicz, 2010)`)
  in the Zotero PDF reader by scanning the rendered text layer — no reliance on
  PDFs embedding citation hyperlinks.
- Match a citation's first-author surname and year against the Zotero library,
  requiring both to agree before accepting a match.
- Highlight matched citations and, on click, open the cited item's PDF in a new
  background reader tab.
- Suppress the reader's default jump-to-reference behaviour for matched
  citations so clicking opens the PDF with no visible scroll.
- Leave unmatched citations (source not in library, or no attached PDF)
  untouched so the reader behaves normally.
- Auto-update support via `update.json`.

[Unreleased]: https://github.com/quinn-zilly/zotero-wiki-citations/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/quinn-zilly/zotero-wiki-citations/releases/tag/v0.1.0
