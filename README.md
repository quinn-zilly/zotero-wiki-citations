# Zotero Wiki Citations

[![CI](https://github.com/quinn-zilly/zotero-wiki-citations/actions/workflows/ci.yml/badge.svg)](https://github.com/quinn-zilly/zotero-wiki-citations/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/github/license/quinn-zilly/zotero-wiki-citations)](LICENSE)

Make in-text citations in the Zotero PDF reader behave like internal wiki
links. Click an author–year citation such as `(Hulleman & Harackiewicz, 2010)`
and, if that source is in your Zotero library with an attached PDF, it opens in
a new reader tab — no digging through the reference list.

> Status: early but working. Author–year citations only, for now. See
> [Roadmap](#roadmap).

## Features

- **Click a citation → open the cited PDF.** Matched citations are highlighted;
  clicking one opens the cited item's PDF in a new background tab.
- **Works on any PDF.** It doesn't rely on PDFs embedding citation hyperlinks
  (most don't). Citations are detected from the text itself.
- **No disruption when there's no match.** If the cited source isn't in your
  library (or has no PDF), the citation is left alone and the reader behaves
  normally.
- **No stray jump.** When a PDF _does_ embed a citation link, the reader's
  usual jump-to-references is suppressed so your place isn't lost.
- **Selection untouched.** Normal text selection in the reader still works.

## How it works

An in-text citation is usually just text (or, at best, a link that jumps to the
reference list — it carries no metadata about the source). So this plugin infers
citations from the reader's text layer:

1. As each PDF page renders, scan the text for author–year citations
   (`(Smith, 2019)`, `(Jones & Lee, 2020)`, `(Smith et al., 2019)`,
   `Smith (2019)`, and `;`-separated groups).
2. Match each to your library by first-author surname + year (requiring both to
   agree, to avoid opening the wrong item).
3. Highlight matches that resolve to an item with a PDF attachment.
4. On click, open that PDF in a new tab and restore the scroll position so the
   original view doesn't jump.

Everything is confined to the reader; nothing about your library data is
modified.

## Requirements

- **Zotero 7 or later.** Developed and tested on **Zotero 9.0.6** (Windows).
  Other versions are untested — it leans on some reader internals that can shift
  between releases.

## Install

### From a release (recommended)

1. Download the latest `zotero-wiki-citations.xpi` from the
   [Releases](https://github.com/quinn-zilly/zotero-wiki-citations/releases)
   page.
2. In Zotero: **Tools → Plugins → gear icon → Install Plugin From File…**, pick
   the `.xpi`.
3. Restart Zotero.

### From source

```bash
git clone https://github.com/quinn-zilly/zotero-wiki-citations.git
cd zotero-wiki-citations
npm install
npm run build      # produces .scaffold/build/zotero-wiki-citations.xpi
```

Then install that `.xpi` as above.

## Usage

Open any PDF in the Zotero reader. In-text author–year citations whose source is
in your library (with a PDF) become highlighted. Click one to open the cited
PDF in a new background tab.

## Limitations

- **Author–year styles only.** Numeric styles (`[12]`) aren't handled yet.
- **Needs the source in your library, with a PDF attachment.** Otherwise the
  citation is left as normal text.
- **Matching is surname + year.** Two different papers by the same first author
  in the same year can be ambiguous.
- Relies on undocumented reader internals; a future Zotero update could require
  a fix.

## Roadmap

- Alternate interaction modes (modifier-click, hover preview, context menu) —
  see [`docs/ux-experiments.md`](docs/ux-experiments.md).
- Numeric citation support (resolve `[n]` via the reference list).
- A preferences pane (open in foreground/background, matching strictness).

## Development

```bash
npm start          # launch Zotero with the plugin, hot-reloading on save
npm run build      # build the distributable .xpi
npm run lint:fix   # format + lint
```

`npm start` needs a `.env` (see `.env.example`) pointing at your Zotero binary
and a profile.

The interception, scanning, highlighting, and citation parsing live in
[`src/modules/citationLinks.ts`](src/modules/citationLinks.ts); library matching
is in [`src/modules/matchReference.ts`](src/modules/matchReference.ts).

## Credits

Built on the excellent
[zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
by windingwind, using
[zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit).

## License

[AGPL-3.0-or-later](LICENSE), inherited from the plugin template.
