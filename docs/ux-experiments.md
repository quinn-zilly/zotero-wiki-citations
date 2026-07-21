# UX experiments — citation interaction modes

Current behavior (main): a matched in-text citation is highlighted; a plain
left-click opens the cited PDF in a new **background** tab, and the reader's
own jump-to-references is hidden by restoring the scroll position.

Ideas to prototype on a test branch and compare how they *feel*. Each is
independent; several could coexist behind a preference.

## 1. Modifier-click
Plain click = Zotero's normal jump-to-references (leave it untouched).
**Ctrl/Alt/Cmd + click** = open the cited PDF. Zero conflict with native
behavior, predictable, matches common "open in new tab" conventions.
- Pro: no interference with normal reading/selection; no scroll-restore hack.
- Con: less discoverable; requires a modifier.

## 2. Hover popup
Hovering a highlighted citation shows a small card — cited item title +
author/year + an "Open PDF" button (and maybe "Show in library"). Never
hijacks the click.
- Pro: non-destructive, discoverable, room for richer info/preview.
- Con: more UI to build; hover popups can feel busy.

## 3. Right-click context menu
Add "Open cited PDF in new tab" to the reader context menu when the click is
on a matched citation. Uses the documented `createViewContextMenu` reader
event, so it's the most API-stable option.
- Pro: stable API, explicit, no click conflict.
- Con: two steps (right-click → choose); least "wiki-link"-like.

## 4. Embrace jump + foreground
Let the jump happen and open the cited PDF in the **foreground** tab. Since
you've navigated away to the cited PDF, the original's scrolled position no
longer matters.
- Pro: simplest (drop the scroll-restore); focus follows intent.
- Con: original tab is left scrolled to references when you return to it.

## Notes
- Consider a preferences pane to pick the mode (default: current background +
  scroll-restore).
- Reuse existing pieces: `markedSpanAtEvent`, `resolveMatch`,
  `openAttachmentInNewTab`, and the scan/highlight pipeline in
  `src/modules/citationLinks.ts`.
