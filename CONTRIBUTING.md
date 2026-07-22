# Contributing

Thanks for your interest in Zotero Wiki Citations! This is a small project, so
contributions of any size — bug reports, ideas, or pull requests — are welcome.

## Reporting bugs & requesting features

Please open an [issue](https://github.com/quinn-zilly/zotero-wiki-citations/issues)
using one of the templates. For bugs, the most useful thing you can include is a
**debug log** (see below) and the citation text that misbehaved.

### Getting a debug log

1. In Zotero: **Help → Debug Output Logging → Enable**.
2. Reproduce the problem (open a PDF, click the citation, etc.).
3. **Help → Debug Output Logging → View Output**, or save it to a file.
4. Paste the relevant lines — search for `[zoterowiki]` to find this plugin's
   output.

## Development setup

Requires [Node.js](https://nodejs.org/) 20+ and a local Zotero install
(tested on Zotero 9.0.6).

```bash
git clone https://github.com/quinn-zilly/zotero-wiki-citations.git
cd zotero-wiki-citations
npm install
cp .env.example .env   # then edit .env to point at your Zotero binary + profile
npm start              # launches Zotero with the plugin, hot-reloads on save
```

Useful scripts:

```bash
npm start          # dev Zotero with hot reload
npm run build      # build the distributable .xpi
npm run lint:fix   # prettier + eslint --fix
npm run lint:check # verify formatting/lint (what CI runs)
```

## Where the code lives

- [`src/modules/citationLinks.ts`](src/modules/citationLinks.ts) — reader
  injection, text-layer scanning, citation highlighting, click handling, and
  author–year parsing.
- [`src/modules/matchReference.ts`](src/modules/matchReference.ts) — matching a
  parsed citation against the Zotero library.
- [`src/modules/openAttachment.ts`](src/modules/openAttachment.ts) — opening the
  matched PDF in a new reader tab.
- [`src/hooks.ts`](src/hooks.ts) — plugin startup wiring.

## Pull requests

- Branch off `main`; keep commits focused and descriptive.
- Run `npm run lint:check` before pushing — CI runs the same and will fail
  otherwise.
- Reference the issue a PR closes (e.g. `Closes #12`).
- Describe how you tested: which PDF / citation style, Zotero version.

## Code style

Formatting is enforced by Prettier and ESLint
([`@zotero-plugin/eslint-config`](https://www.npmjs.com/package/@zotero-plugin/eslint-config)).
Don't hand-format — run `npm run lint:fix`.

## License

By contributing, you agree that your contributions are licensed under the
project's [AGPL-3.0-or-later](LICENSE) license.
