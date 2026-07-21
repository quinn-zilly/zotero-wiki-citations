/**
 * Wiki-style in-text citations via TEXT INFERENCE + pre-scan.
 *
 * PDFs here don't reliably embed internal citation links, so we infer them from
 * the text layer. On each text-layer render we scan for author-year citations
 * (e.g. "(Smith, 2019)", "(Jones & Lee, 2020)", "(Smith et al., 2019)"),
 * pre-match each to a library item with a PDF (cached), and mark the matching
 * text spans as clickable (highlight + pointer). Clicking a marked citation
 * opens the cited PDF in a new background tab and suppresses the reader's
 * redundant jump-to-references.
 *
 * Injection detail: the reader nests the pdf.js viewer in a child iframe
 * (resource://zotero/reader/pdf/web/viewer.html). We recurse into nested docs
 * and attach capture-phase listeners on the viewer WINDOW so we run before the
 * reader's own document-level click handler. Undocumented internals; all access
 * is defensive + logged.
 */

import { matchCitation } from "./matchReference";
import { openAttachmentInNewTab } from "./openAttachment";

/** Verbose logging to Debug Output. */
const DEBUG = true;

const INJECTED = new WeakSet<object>();
const STYLED = new WeakSet<object>();
const SCANNED = new WeakSet<object>();

/** Cache: "surname|year" -> attachmentID or null (miss). */
const matchCache = new Map<string, number | null>();

const MARK_CLASS = "zwc-citation";
const MARK_ATTR = "zwcAttachment"; // dataset key -> data-zwc-attachment

function log(...args: any[]) {
  if (DEBUG) Zotero.debug(`[zoterowiki] ${args.map(String).join(" ")}`);
}

// ---------------------------------------------------------------------------
// Registration + injection
// ---------------------------------------------------------------------------

export function registerCitationLinks(pluginID: string): void {
  try {
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      (event: any) => {
        const reader = event?.reader;
        if (reader) injectIntoReader(reader);
      },
      pluginID,
    );
    log("registered renderToolbar hook for reader injection");
  } catch (e) {
    log("registerEventListener failed:", e);
  }

  try {
    for (const reader of Zotero.Reader._readers || []) injectIntoReader(reader);
  } catch (e) {
    log("initial reader sweep failed:", e);
  }
}

export function injectIntoReader(reader: any): void {
  attachToAllDocs(reader);
  let tries = 0;
  const win: any = reader?._iframeWindow;
  const timer = win?.setInterval?.(() => {
    tries++;
    attachToAllDocs(reader);
    if (tries >= 10) win.clearInterval(timer);
  }, 500);
}

function attachToAllDocs(reader: any): void {
  try {
    const root: Document | undefined = reader?._iframeWindow?.document;
    if (!root) return;
    for (const doc of collectDocs(root)) attachTo(doc);
  } catch (e) {
    log("attachToAllDocs failed:", e);
  }
}

function collectDocs(doc: Document, depth = 0): Document[] {
  const out: Document[] = [doc];
  if (depth > 4) return out;
  let frames: NodeListOf<HTMLIFrameElement>;
  try {
    frames = doc.querySelectorAll("iframe");
  } catch {
    return out;
  }
  for (const f of Array.from(frames) as HTMLIFrameElement[]) {
    let inner: Document | null = null;
    try {
      inner = f.contentDocument;
    } catch {
      inner = null;
    }
    if (inner) out.push(...collectDocs(inner, depth + 1));
  }
  return out;
}

function attachTo(doc: Document): void {
  if (INJECTED.has(doc)) return;
  const url = (doc as any)?.location?.href || doc?.URL || "";
  if (!/viewer\.html/.test(url)) {
    INJECTED.add(doc);
    return;
  }
  INJECTED.add(doc);
  try {
    const win = doc.defaultView as (Window & typeof globalThis) | null;
    // Capture on the WINDOW so we run before the reader's document handler.
    // Only intercept click/auxclick — touching mousedown/up desyncs the
    // reader's text-selection state machine (stuck-selecting bug).
    const holder: EventTarget = win || doc;
    // Record scroll before the reader can jump (does not prevent/stop -> text
    // selection stays intact).
    holder.addEventListener("pointerdown", recordScroll as any, true);
    holder.addEventListener("mousedown", recordScroll as any, true);
    holder.addEventListener("auxclick", onSuppress as any, true);
    holder.addEventListener("click", onClick as any, true);

    injectStyles(doc);
    observeTextLayers(doc);
    scanAllTextLayers(doc);
    log("citation listeners attached to viewer:", url);
  } catch (e) {
    log("attachTo failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

function injectStyles(doc: Document): void {
  if (STYLED.has(doc)) return;
  STYLED.add(doc);
  try {
    const style = doc.createElement("style");
    style.textContent = `
      .${MARK_CLASS} {
        cursor: pointer;
        background-color: rgba(80, 140, 255, 0.18);
        border-radius: 2px;
        box-shadow: 0 0 0 1px rgba(80, 140, 255, 0.35) inset;
      }
      .${MARK_CLASS}:hover {
        background-color: rgba(80, 140, 255, 0.32);
      }
    `;
    const host = doc.head || doc.documentElement;
    host?.appendChild(style);
  } catch (e) {
    log("injectStyles failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Text-layer scanning
// ---------------------------------------------------------------------------

function observeTextLayers(doc: Document): void {
  try {
    const win: any = doc.defaultView;
    const obs = new win.MutationObserver((mutations: MutationRecord[]) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (!(node instanceof win.HTMLElement)) continue;
          const el = node as HTMLElement;
          if (el.classList?.contains("textLayer")) queueScan(el);
          el.querySelectorAll?.(".textLayer")?.forEach((t: Element) =>
            queueScan(t as HTMLElement),
          );
          // Annotation layer renders separately; re-neutralize its page.
          const annOnPage =
            el.classList?.contains("annotationLayer") ||
            el.querySelector?.(".annotationLayer");
          if (annOnPage) {
            const page = el.closest?.(".page") as HTMLElement | null;
            if (page) queueNeutralize(page);
          }
        }
      }
    });
    obs.observe(doc.body || doc.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    log("observeTextLayers failed:", e);
  }
}

function scanAllTextLayers(doc: Document): void {
  doc
    .querySelectorAll(".textLayer")
    .forEach((t: Element) => queueScan(t as HTMLElement));
}

/** Debounce per text layer (pdf.js may mutate it repeatedly while rendering). */
function queueScan(layer: HTMLElement): void {
  const win: any = layer.ownerDocument?.defaultView;
  if (!win) return;
  const anyLayer = layer as any;
  if (anyLayer.__zwcTimer) win.clearTimeout(anyLayer.__zwcTimer);
  anyLayer.__zwcTimer = win.setTimeout(() => {
    anyLayer.__zwcTimer = null;
    void scanTextLayer(layer);
  }, 150);
}

/** Debounced page neutralize (annotation layer may mutate as it renders). */
function queueNeutralize(page: HTMLElement): void {
  const win: any = page.ownerDocument?.defaultView;
  if (!win) return;
  const anyPage = page as any;
  if (anyPage.__zwcNeutTimer) win.clearTimeout(anyPage.__zwcNeutTimer);
  anyPage.__zwcNeutTimer = win.setTimeout(() => {
    anyPage.__zwcNeutTimer = null;
    neutralizePage(page);
  }, 100);
}

async function scanTextLayer(layer: HTMLElement): Promise<void> {
  try {
    // Already processed this rendered layer? (fresh re-renders have no marks)
    if (layer.querySelector(`span.${MARK_CLASS}`)) return;

    // Only top-level line spans (skip any nested marks from prior passes).
    const spans = Array.from(layer.children).filter(
      (el) => el.tagName === "SPAN",
    ) as HTMLElement[];
    if (!spans.length) return;

    // Concatenate span text, recording each span's [start,end) range.
    let text = "";
    const map: { span: HTMLElement; start: number; end: number }[] = [];
    for (const s of spans) {
      const start = text.length;
      const t = s.textContent || "";
      text += t;
      map.push({ span: s, start, end: text.length });
      text += " ";
    }

    const cites = findAllCitations(text);
    if (!cites.length) return;

    let marked = 0;
    for (const c of cites) {
      if (!c.year || !c.authors.length) continue;
      const att = await resolveMatch(c.authors, c.year);
      if (att == null) continue;
      for (const e of map) {
        if (e.start < c.end && e.end > c.start) {
          const spanLen = e.end - e.start;
          const localStart = Math.max(0, c.start - e.start);
          const localEnd = Math.min(spanLen, c.end - e.start);
          if (markSpanPortion(e.span, localStart, localEnd, att)) marked++;
        }
      }
    }
    SCANNED.add(layer);

    // Neutralize link annotations overlapping our marks. The annotation layer
    // renders separately from the text layer and may arrive later, so retry.
    if (marked) {
      const page = layer.closest?.(".page") as HTMLElement | null;
      if (page) {
        const win: any = layer.ownerDocument?.defaultView;
        neutralizePage(page);
        win?.setTimeout?.(() => neutralizePage(page), 300);
        win?.setTimeout?.(() => neutralizePage(page), 900);
      }
    }
  } catch (e) {
    log("scanTextLayer error:", e);
  }
}

/**
 * Wrap the [localStart,localEnd) portion of a line span in a marked child span
 * so only the citation text is highlighted/clickable — not the whole line.
 * Returns the marked element.
 */
function markSpanPortion(
  span: HTMLElement,
  localStart: number,
  localEnd: number,
  att: number,
): HTMLElement | null {
  const full = span.textContent || "";
  const s = Math.max(0, Math.min(localStart, full.length));
  const e = Math.max(s, Math.min(localEnd, full.length));

  // Whole span is the citation -> mark the span itself.
  if (s <= 0 && e >= full.length) {
    span.classList.add(MARK_CLASS);
    (span as any).dataset[MARK_ATTR] = String(att);
    return span;
  }

  const doc = span.ownerDocument;
  if (!doc) return null;
  const before = full.slice(0, s);
  const mid = full.slice(s, e);
  const after = full.slice(e);
  if (!mid) return null;

  span.textContent = "";
  if (before) span.appendChild(doc.createTextNode(before));
  const mark = doc.createElement("span");
  mark.className = MARK_CLASS;
  (mark as any).dataset[MARK_ATTR] = String(att);
  mark.textContent = mid;
  span.appendChild(mark);
  if (after) span.appendChild(doc.createTextNode(after));
  return mark;
}

/**
 * Disable annotation-layer links overlapping any marked citation on a page, so
 * the reader's own jump-to-references (which hit-tests the annotation layer,
 * possibly on pointerup) finds nothing there. We don't touch events, so text
 * selection is unaffected. `display:none` also removes it from geometry-based
 * hit-tests, not just pointer-events ones.
 */
function neutralizePage(page: HTMLElement): number {
  try {
    const ann = page.querySelector?.(".annotationLayer") as HTMLElement | null;
    if (!ann) return 0;
    const marks = page.querySelectorAll(`span.${MARK_CLASS}`);
    if (!marks.length) return 0;
    const markRects = Array.from(marks).map((m) =>
      (m as HTMLElement).getBoundingClientRect(),
    );
    const links = Array.from(
      ann.querySelectorAll("a, .linkAnnotation, [data-annotation-id]"),
    ) as HTMLElement[];

    let disabled = 0;
    for (const l of links) {
      if ((l as any).dataset?.zwcNeutralized) continue;
      const lr = l.getBoundingClientRect();
      if (lr.width === 0 && lr.height === 0) continue;
      const hit = markRects.some(
        (r) =>
          !(
            r.right < lr.left ||
            r.left > lr.right ||
            r.bottom < lr.top ||
            r.top > lr.bottom
          ),
      );
      if (hit) {
        l.style.pointerEvents = "none";
        l.style.display = "none";
        (l as any).dataset.zwcNeutralized = "1";
        disabled++;
      }
    }
    if (disabled) log(`neutralized ${disabled} link(s) over citations`);
    return disabled;
  } catch (e) {
    log("neutralizePage error:", e);
    return 0;
  }
}

/** Cached library resolution: authors+year -> attachmentID or null. */
async function resolveMatch(
  authors: string[],
  year: string,
): Promise<number | null> {
  const key = `${(authors[0] || "").toLowerCase()}|${year}`;
  if (matchCache.has(key)) return matchCache.get(key)!;
  let att: number | null = null;
  try {
    const m = await matchCitation(authors, year);
    att = m ? m.attachmentID : null;
  } catch {
    att = null;
  }
  matchCache.set(key, att);
  return att;
}

// ---------------------------------------------------------------------------
// Click handling
// ---------------------------------------------------------------------------

/** Pre-empt the reader's navigation (any pre-click event) for a marked citation. */
function onSuppress(event: Event): void {
  if (!markedSpanAtEvent(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** Scroll position captured at pointerdown, before the reader may jump. */
let savedScroll: { el: HTMLElement; top: number; left: number } | null = null;

/** On pointerdown over a marked citation, remember the scroll position. */
function recordScroll(event: Event): void {
  try {
    if (!markedSpanAtEvent(event)) return;
    const doc = (event.target as HTMLElement)?.ownerDocument;
    const el = doc?.querySelector("#viewerContainer") as HTMLElement | null;
    if (el) savedScroll = { el, top: el.scrollTop, left: el.scrollLeft };
  } catch {
    /* ignore */
  }
}

/** Repeatedly restore the saved scroll position to defeat async/smooth nav. */
function restoreScroll(): void {
  const s = savedScroll;
  if (!s) return;
  const win: any = s.el.ownerDocument?.defaultView;
  const apply = () => {
    s.el.scrollTop = s.top;
    s.el.scrollLeft = s.left;
  };
  apply();
  for (const t of [0, 16, 33, 50, 80, 120, 180, 260, 360]) {
    win?.setTimeout?.(apply, t);
  }
  win?.requestAnimationFrame?.(() => {
    apply();
    win?.requestAnimationFrame?.(apply);
  });
}

async function onClick(event: Event): Promise<void> {
  try {
    // 1. Fast path: a pre-scanned, pre-matched citation span.
    const span = markedSpanAtEvent(event);
    if (span) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const att = Number((span as any).dataset[MARK_ATTR]);
      log(`marked citation clicked -> attachment ${att}; opening`);
      const ok = await openAttachmentInNewTab(att, { background: true });
      if (!ok) log("openAttachmentInNewTab returned false");
      // The reader navigates internally on pointerup (before this click), so
      // snap the scroll back to where it was at pointerdown to hide the jump.
      restoreScroll();
      return;
    }

    // 2. Fallback: click-time detection on an unscanned span (no suppression).
    const target = event.target as HTMLElement | null;
    const s = target?.closest?.("span") as HTMLElement | null;
    if (!s || !s.closest?.(".textLayer")) return;

    const win = buildTextWindow(s);
    if (!win) return;
    const cite = findCitationAtClick(win.text, win.clickStart, win.clickEnd);
    if (!cite || !cite.year || !cite.authors.length) return;

    const att = await resolveMatch(cite.authors, cite.year);
    if (att == null) {
      log("no library match with a PDF; leaving click as-is");
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    log(`citation (fallback) -> attachment ${att}; opening`);
    await openAttachmentInNewTab(att, { background: true });
  } catch (e) {
    log("onClick error:", e);
  }
}

/**
 * The marked citation span for an event — by direct target OR by hit-testing
 * the click point (a link annotation may sit on top of the text span).
 */
function markedSpanAtEvent(event: Event): HTMLElement | null {
  const target = event.target as HTMLElement | null;
  const direct = target?.closest?.(`span.${MARK_CLASS}`) as HTMLElement | null;
  if (direct) return direct;

  const me = event as MouseEvent;
  const doc = target?.ownerDocument;
  const stack = (doc as any)?.elementsFromPoint?.(
    me.clientX,
    me.clientY,
  ) as Element[] | undefined;
  if (stack) {
    for (const el of stack) {
      const s = (el as HTMLElement).closest?.(
        `span.${MARK_CLASS}`,
      ) as HTMLElement | null;
      if (s) return s;
    }
  }
  return null;
}

/**
 * Text window from the clicked span plus up to 2 siblings each side, with the
 * clicked span's [start,end) offsets. Used only by the fallback path.
 */
function buildTextWindow(
  span: HTMLElement,
): { text: string; clickStart: number; clickEnd: number } | null {
  const prev: string[] = [];
  let p = span.previousElementSibling as HTMLElement | null;
  for (let i = 0; p && i < 2; i++) {
    prev.unshift(p.textContent || "");
    p = p.previousElementSibling as HTMLElement | null;
  }
  const next: string[] = [];
  let n = span.nextElementSibling as HTMLElement | null;
  for (let i = 0; n && i < 2; i++) {
    next.push(n.textContent || "");
    n = n.nextElementSibling as HTMLElement | null;
  }
  const self = span.textContent || "";
  const before = prev.join(" ");
  const clickStart = before ? before.length + 1 : 0;
  const clickEnd = clickStart + self.length;
  const text = [before, self, next.join(" ")].filter(Boolean).join(" ");
  return { text, clickStart, clickEnd };
}

// ---------------------------------------------------------------------------
// Citation parsing (author-year)
// ---------------------------------------------------------------------------

export interface ParsedCitation {
  authors: string[];
  year: string | null;
}

export interface CitationRange extends ParsedCitation {
  start: number;
  end: number;
}

/** Parenthetical group containing a 4-digit year. */
const PAREN_CITE = /\(([^()]*\b(?:19|20)\d{2}[a-z]?\b[^()]*)\)/g;
/** Narrative form: "Smith (2019)" / "Smith et al. (2019)". */
const NARRATIVE_CITE =
  /([A-Z][A-Za-z'’-]+(?:\s+(?:and|&)\s+[A-Z][A-Za-z'’-]+|\s+et al\.?)*)\s*\(\s*((?:19|20)\d{2}[a-z]?)\s*\)/g;

/** All author-year citations in a text with their [start,end) ranges. */
export function findAllCitations(text: string): CitationRange[] {
  const out: CitationRange[] = [];

  PAREN_CITE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAREN_CITE.exec(text))) {
    const inner = m[1];
    const innerStart = m.index + 1;
    for (const part of splitWithOffsets(inner, /;/g, innerStart)) {
      const parsed = parseOneCitation(part.text);
      if (parsed.year && parsed.authors.length) {
        out.push({ ...parsed, start: part.start, end: part.end });
      }
    }
  }

  NARRATIVE_CITE.lastIndex = 0;
  while ((m = NARRATIVE_CITE.exec(text))) {
    const authors = extractSurnames(m[1]);
    if (authors.length) {
      out.push({
        authors,
        year: m[2].replace(/[a-z]$/, ""),
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }
  return out;
}

/** Citation overlapping the clicked offsets (fallback path). */
export function findCitationAtClick(
  text: string,
  clickStart: number,
  clickEnd: number,
): ParsedCitation | null {
  const cites = findAllCitations(text);
  const overlapping = cites.filter(
    (c) => c.start < clickEnd && c.end > clickStart,
  );
  if (!overlapping.length) return null;
  // Prefer the one whose center is nearest the click center.
  const cc = (clickStart + clickEnd) / 2;
  overlapping.sort(
    (a, b) =>
      Math.abs((a.start + a.end) / 2 - cc) -
      Math.abs((b.start + b.end) / 2 - cc),
  );
  const c = overlapping[0];
  return { authors: c.authors, year: c.year };
}

interface Part {
  text: string;
  start: number;
  end: number;
}

function splitWithOffsets(s: string, sep: RegExp, base: number): Part[] {
  const parts: Part[] = [];
  let last = 0;
  const re = new RegExp(sep.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    parts.push({
      text: s.slice(last, m.index),
      start: base + last,
      end: base + m.index,
    });
    last = m.index + m[0].length;
  }
  parts.push({ text: s.slice(last), start: base + last, end: base + s.length });
  return parts;
}

export function parseOneCitation(chunk: string): ParsedCitation {
  const yearMatch = chunk.match(/\b(19|20)\d{2}\b/);
  return {
    authors: extractSurnames(chunk),
    year: yearMatch ? yearMatch[0] : null,
  };
}

function extractSurnames(s: string): string[] {
  const cleaned = s
    .replace(/\bet al\.?/gi, " ")
    .replace(/\b(19|20)\d{2}[a-z]?\b/g, " ");
  const out: string[] = [];
  const re = /([A-Z][A-Za-z'’-]{1,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const w = m[1];
    if (/^(And|The|In|Of|See|Cf|Vol|No|Pp|Ed|Eds)$/i.test(w)) continue;
    out.push(w);
  }
  return out;
}
