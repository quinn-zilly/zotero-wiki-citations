/**
 * Match a raw reference-list string (extracted from a PDF citation destination)
 * to an item in the Zotero library.
 *
 * Strategy (locked with user): DOI-first, fuzzy fallback.
 *   1. Parse a DOI from the reference text -> search library by DOI (reliable).
 *   2. No DOI -> parse author surname + year + title -> fuzzy rank candidates.
 * Only return a hit that has a PDF attachment; otherwise null (caller falls
 * back to default reader navigation).
 */

export interface ReferenceMatch {
  item: Zotero.Item;
  attachmentID: number;
  /** How the match was made, for logging/telemetry. */
  method: "doi" | "fuzzy";
  /** 0..1 confidence, mainly meaningful for fuzzy. */
  score: number;
}

/** Minimum fuzzy score to accept, to avoid opening the wrong PDF. */
const FUZZY_THRESHOLD = 0.55;

export async function matchReference(
  refText: string,
  libraryID: number = Zotero.Libraries.userLibraryID,
): Promise<ReferenceMatch | null> {
  const text = normalizeWhitespace(refText);
  if (!text) return null;

  // --- 1. DOI-first ------------------------------------------------------
  const doi = extractDOI(text);
  if (doi) {
    const item = await findByDOI(doi, libraryID);
    if (item) {
      const attachmentID = await getPdfAttachment(item);
      if (attachmentID != null) {
        return { item, attachmentID, method: "doi", score: 1 };
      }
      // Matched item but no PDF -> treat as no-match (default nav).
      return null;
    }
  }

  // --- 2. Fuzzy fallback -------------------------------------------------
  const parsed = parseReference(text);
  if (!parsed.title && !parsed.author) return null;

  const candidate = await fuzzyMatch(parsed, libraryID);
  if (candidate && candidate.score >= FUZZY_THRESHOLD) {
    const attachmentID = await getPdfAttachment(candidate.item);
    if (attachmentID != null) {
      return {
        item: candidate.item,
        attachmentID,
        method: "fuzzy",
        score: candidate.score,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Author-year in-text citation matching
// ---------------------------------------------------------------------------

/**
 * Match an in-text author-year citation (e.g. authors=["Smith"], year="2019")
 * directly against the library. Author-year carries little information, so we
 * require the first-author surname AND (when present) the year to agree before
 * accepting — this avoids opening the wrong PDF.
 */
export async function matchCitation(
  authors: string[],
  year: string | null,
  libraryID: number = Zotero.Libraries.userLibraryID,
): Promise<ReferenceMatch | null> {
  const primary = (authors[0] || "").trim();
  if (!primary) return null;
  const primaryLc = primary.toLowerCase();

  const runSearch = async (withYear: boolean): Promise<number[]> => {
    const s = new Zotero.Search();
    s.addCondition("libraryID", "is", String(libraryID));
    s.addCondition("itemType", "isNot", "attachment");
    s.addCondition("creator", "contains", primary);
    if (withYear && year) s.addCondition("date", "is", year);
    try {
      return await s.search();
    } catch {
      return [];
    }
  };

  let ids = await runSearch(true);
  if (!ids.length) ids = await runSearch(false);
  if (!ids.length) return null;

  let best: { item: Zotero.Item; score: number } | null = null;
  for (const id of ids.slice(0, 50)) {
    const item = Zotero.Items.get(id) as Zotero.Item;
    const creators = item.getCreators?.() || [];
    const first = (creators[0]?.lastName || "").toLowerCase();

    // Require the primary surname to match the item's first author.
    const surnameMatch = first === primaryLc;
    if (!surnameMatch) continue;

    let score = 0.6; // first-author surname match
    const itemYear = (safeField(item, "date") || "").match(/\b(19|20)\d{2}\b/);
    if (year) {
      if (itemYear && itemYear[0] === year) score += 0.4;
      else continue; // year given but mismatched -> reject
    }
    // Bonus if additional cited authors also appear.
    for (const extra of authors.slice(1)) {
      const e = extra.toLowerCase();
      if (creators.some((c: any) => (c.lastName || "").toLowerCase() === e)) {
        score += 0.1;
      }
    }
    if (!best || score > best.score) best = { item, score };
  }
  if (!best) return null;

  const attachmentID = await getPdfAttachment(best.item);
  if (attachmentID == null) return null;
  return { item: best.item, attachmentID, method: "fuzzy", score: best.score };
}

// ---------------------------------------------------------------------------
// DOI
// ---------------------------------------------------------------------------

/** Standard DOI shape; trailing sentence punctuation trimmed. */
export function extractDOI(text: string): string | null {
  const m = text.match(/10\.\d{4,9}\/[^\s"'<>)\]]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;:)\]]+$/, "");
}

async function findByDOI(
  doi: string,
  libraryID: number,
): Promise<Zotero.Item | null> {
  const target = doi.toLowerCase();

  // Fast path: Zotero indexes the DOI field for many item types.
  const s = new Zotero.Search();
  s.addCondition("libraryID", "is", String(libraryID));
  s.addCondition("itemType", "isNot", "attachment");
  s.addCondition("DOI", "is", doi);
  let ids: number[];
  try {
    ids = await s.search();
  } catch {
    ids = [];
  }
  if (ids.length) {
    return Zotero.Items.get(ids[0]) as Zotero.Item;
  }

  // Fallback: DOI can live in the `extra` field or `url` (preprints, etc.).
  const s2 = new Zotero.Search();
  s2.addCondition("libraryID", "is", String(libraryID));
  s2.addCondition("itemType", "isNot", "attachment");
  s2.addCondition("quicksearch-everything", "contains", doi);
  let ids2: number[];
  try {
    ids2 = await s2.search();
  } catch {
    ids2 = [];
  }
  for (const id of ids2) {
    const item = Zotero.Items.get(id) as Zotero.Item;
    const fields = [
      safeField(item, "DOI"),
      safeField(item, "url"),
      safeField(item, "extra"),
    ]
      .join(" ")
      .toLowerCase();
    if (fields.includes(target)) return item;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fuzzy
// ---------------------------------------------------------------------------

interface ParsedRef {
  author: string | null; // first-author surname, lowercased
  year: string | null;
  title: string | null;
}

/** Best-effort structural parse of a reference string. */
export function parseReference(text: string): ParsedRef {
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : null;

  // First-author surname: leading token before comma/space+initials.
  // e.g. "Smith, J. A." -> "smith"; "Smith J, Doe K" -> "smith".
  const authorMatch = text.match(/^\s*([A-Z][A-Za-z'’-]+)/);
  const author = authorMatch ? authorMatch[1].toLowerCase() : null;

  // Title: heuristic — the longest clause after the year, before a journal/
  // publisher marker. Falls back to the longest sentence-like span.
  let title: string | null = null;
  if (year) {
    const afterYear = text.slice(text.indexOf(year) + year.length);
    // Strip a leading ")." or ". " left over from "(2019). Title..."
    const cleaned = afterYear.replace(/^[)\s.]+/, "");
    // Title usually ends at the first period followed by a capitalized
    // journal name, or at "In " / "doi".
    const t = cleaned.split(/\.\s+(?=[A-Z])|,\s+In\s+|\bdoi\b/i)[0];
    title = t ? normalizeWhitespace(t) : null;
  }
  if (!title) {
    const parts = text.split(/[.]/).map((s) => s.trim());
    title = parts.sort((a, b) => b.length - a.length)[0] || null;
  }
  if (title && title.length < 6) title = null;

  return { author, year, title: title ? title.toLowerCase() : null };
}

async function fuzzyMatch(
  parsed: ParsedRef,
  libraryID: number,
): Promise<{ item: Zotero.Item; score: number } | null> {
  // Narrow candidates: prefer year match, then title keyword search.
  const s = new Zotero.Search();
  s.addCondition("libraryID", "is", String(libraryID));
  s.addCondition("itemType", "isNot", "attachment");
  if (parsed.year) s.addCondition("date", "is", parsed.year);
  if (parsed.title) {
    // Use the 3 longest title tokens as a coarse filter.
    const kw = topTokens(parsed.title, 3);
    for (const k of kw) s.addCondition("title", "contains", k);
  }
  let ids: number[];
  try {
    ids = await s.search();
  } catch {
    ids = [];
  }

  // If year filter was too strict and returned nothing, retry title-only.
  if (!ids.length && parsed.title) {
    const s2 = new Zotero.Search();
    s2.addCondition("libraryID", "is", String(libraryID));
    s2.addCondition("itemType", "isNot", "attachment");
    for (const k of topTokens(parsed.title, 3))
      s2.addCondition("title", "contains", k);
    try {
      ids = await s2.search();
    } catch {
      ids = [];
    }
  }
  if (!ids.length) return null;

  let best: { item: Zotero.Item; score: number } | null = null;
  for (const id of ids.slice(0, 50)) {
    const item = Zotero.Items.get(id) as Zotero.Item;
    const score = scoreCandidate(parsed, item);
    if (!best || score > best.score) best = { item, score };
  }
  return best;
}

function scoreCandidate(parsed: ParsedRef, item: Zotero.Item): number {
  let score = 0;

  // Title similarity (weight 0.6).
  if (parsed.title) {
    const itemTitle = (safeField(item, "title") || "").toLowerCase();
    score += 0.6 * jaccardTokens(parsed.title, itemTitle);
  }
  // Year (weight 0.25).
  if (parsed.year) {
    const itemYear = (safeField(item, "date") || "").match(/\b(19|20)\d{2}\b/);
    if (itemYear && itemYear[0] === parsed.year) score += 0.25;
  }
  // First-author surname (weight 0.15).
  if (parsed.author) {
    const creators = item.getCreators?.() || [];
    const first = creators[0];
    const surname = (first?.lastName || "").toLowerCase();
    if (surname && surname === parsed.author) score += 0.15;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

/** Return the itemID of the item's best PDF attachment, or null. */
export async function getPdfAttachment(
  item: Zotero.Item,
): Promise<number | null> {
  // Prefer Zotero's own "best attachment" resolver when available.
  const best = await item.getBestAttachment?.();
  if (best && best.attachmentContentType === "application/pdf") {
    return best.id;
  }
  const ids = item.getAttachments?.() || [];
  for (const id of ids) {
    const att = Zotero.Items.get(id) as Zotero.Item;
    if (att?.attachmentContentType === "application/pdf") return att.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeField(item: Zotero.Item, field: string): string {
  try {
    return (item.getField?.(field as any) as string) || "";
  } catch {
    return "";
  }
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "in",
  "on",
  "for",
  "to",
  "with",
  "from",
  "by",
  "at",
  "as",
  "is",
  "are",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function topTokens(s: string, n: number): string[] {
  return [...new Set(tokenize(s))]
    .sort((a, b) => b.length - a.length)
    .slice(0, n);
}

/** Jaccard similarity over token sets. */
function jaccardTokens(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
