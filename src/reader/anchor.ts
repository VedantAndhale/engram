/*
 * Where an article highlight sits in the text. A highlight is its quote plus a little of the
 * text before and after it (W3C's "text quote" idea). Matching ignores whitespace, because the
 * same words come out with different spacing from a selection, the bookmarklet and the reading
 * view; the surrounding text picks between repeats of the same quote. Nothing depends on the
 * article's markup, so a highlight still lands after the article is saved again.
 */

const CONTEXT = 32;

/** All the text in a rendered article, with a whitespace-free copy for matching. */
export interface TextIndex {
  root: Element;
  nodes: Text[];
  /** Where each text node starts in `full`. */
  starts: number[];
  full: string;
  compact: string;
  /** For each character of `compact`, its position in `full`. */
  map: number[];
}

/** Marks something drawn inside the article that is not the article's text, such as an AI note under a paragraph. */
export const NOT_TEXT = "[data-note]";

export function indexText(root: Element): TextIndex {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let full = "";
  // Notes sit among the paragraphs but are not the article's words: no highlight or quote may count them.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(NOT_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(full.length);
    full += (n as Text).data;
  }
  let compact = "";
  const map: number[] = [];
  for (let i = 0; i < full.length; i++) {
    if (/\s/.test(full[i])) continue;
    compact += full[i];
    map.push(i);
  }
  return { root, nodes, starts, full, compact, map };
}

const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, "");

/** A DOM position for an offset into `full`. */
function point(ix: TextIndex, offset: number): [Text, number] {
  let lo = 0;
  let hi = ix.nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ix.starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return [ix.nodes[lo], Math.min(offset - ix.starts[lo], ix.nodes[lo].data.length)];
}

/** How many characters of `a` and `b` agree, reading from the end (back) or the start. */
function agree(a: string, b: string, back: boolean): number {
  let n = 0;
  while (n < a.length && n < b.length && (back ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++;
  return n;
}

/** The range a highlight covers in the text, or null if its quote isn't there. */
export function findQuote(ix: TextIndex, a: { quote?: string; prefix?: string; suffix?: string }): Range | null {
  const q = squash(a.quote);
  if (!q || !ix.nodes.length) return null;
  const pre = squash(a.prefix);
  const suf = squash(a.suffix);
  let best = -1;
  let bestScore = -1;
  for (let at = ix.compact.indexOf(q); at >= 0; at = ix.compact.indexOf(q, at + 1)) {
    const score = agree(ix.compact.slice(Math.max(0, at - pre.length), at), pre, true) + agree(ix.compact.slice(at + q.length, at + q.length + suf.length), suf, false);
    if (score > bestScore) (best = at), (bestScore = score);
    if (score === pre.length + suf.length) break;
  }
  if (best < 0) return null;
  const range = document.createRange();
  range.setStart(...point(ix, ix.map[best]));
  range.setEnd(...point(ix, ix.map[best + q.length - 1] + 1));
  return range;
}

/**
 * Offset into `full` of a DOM position inside the article. A position in an indexed text node is read
 * from the index. Any other position (between elements, or inside a note) is the start of the first
 * indexed text after it, so a note under a paragraph never shifts the offsets that follow it.
 */
function offsetOf(ix: TextIndex, node: Node, offset: number): number {
  const i = ix.nodes.indexOf(node as Text);
  if (i >= 0) return ix.starts[i] + Math.min(offset, ix.nodes[i].data.length);
  const at = document.createRange();
  at.setStart(node, offset);
  at.collapse(true);
  const text = document.createRange();
  for (let j = 0; j < ix.nodes.length; j++) {
    text.selectNodeContents(ix.nodes[j]);
    if (at.compareBoundaryPoints(Range.START_TO_START, text) <= 0) return ix.starts[j];
  }
  return ix.full.length;
}

/** The elements that start a new line of text: a quote that runs over two of them gets a line break there. */
const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, figcaption, dt, dd, td, th, tr, div, section, article, aside, header, footer";

/** What to store for a selection: the quote as the reader sees it, in whole words, and the text around it. */
export function quoteOf(ix: TextIndex, range: Range): { quote: string; prefix: string; suffix: string } | null {
  if (!ix.root.contains(range.commonAncestorContainer)) return null;
  // A drag that starts or ends inside a word takes the whole word.
  const [s, e] = snapToWords(ix.full, offsetOf(ix, range.startContainer, range.startOffset), offsetOf(ix, range.endContainer, range.endOffset));
  if (e <= s) return null;
  // Each text node's part, with a line break where a new paragraph starts: in the text they sit side by side with nothing between.
  const pieces: { text: string; block: unknown }[] = [];
  ix.nodes.forEach((node, i) => {
    const from = ix.starts[i];
    const to = from + node.data.length;
    if (to <= s || from >= e) return;
    pieces.push({ text: ix.full.slice(Math.max(from, s), Math.min(to, e)), block: node.parentElement?.closest(BLOCKS) ?? null });
  });
  const quote = joinBlocks(pieces);
  if (!quote) return null;
  const tidy = (t: string) => t.replace(/\s+/g, " ");
  return {
    quote,
    prefix: tidy(ix.full.slice(Math.max(0, s - CONTEXT * 2), s)).slice(-CONTEXT),
    suffix: tidy(ix.full.slice(e, e + CONTEXT * 2)).slice(0, CONTEXT),
  };
}

/**
 * Pieces of text in order, as one quote: pieces of the same block run on, and a new block starts a
 * new line. Spaces are collapsed within a line, and blank lines dropped.
 */
export function joinBlocks(pieces: { text: string; block: unknown }[]): string {
  let out = "";
  pieces.forEach((p, i) => {
    if (i > 0 && p.block !== pieces[i - 1].block) out += "\n";
    out += p.text;
  });
  return out
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** A letter, digit or mark; an apostrophe counts inside a word ("don't"), not at its ends. */
function wordAt(text: string, i: number): boolean {
  const ch = text[i];
  if (ch === undefined) return false;
  if (/[\p{L}\p{N}\p{M}]/u.test(ch)) return true;
  return /['’]/.test(ch) && /[\p{L}\p{N}]/u.test(text[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[i + 1] ?? "");
}

/** A start offset moved back to the start of the word it cuts through, if it cuts through one. */
export function wordStart(text: string, i: number): number {
  if (!wordAt(text, i) || !wordAt(text, i - 1)) return i;
  while (i > 0 && wordAt(text, i - 1)) i--;
  return i;
}

/** An end offset moved on to the end of the word it cuts through, if it cuts through one. */
export function wordEnd(text: string, i: number): number {
  if (!wordAt(text, i) || !wordAt(text, i - 1)) return i;
  while (i < text.length && wordAt(text, i)) i++;
  return i;
}

/** A span of `text`, from `start` to `end`, widened to whole words at both ends. */
export function snapToWords(text: string, start: number, end: number): [number, number] {
  return [wordStart(text, start), wordEnd(text, end)];
}

/**
 * A copy of a selection widened to whole words. Each end only moves within its own text node: the
 * PDF text layer puts separate words in neighbouring nodes with nothing between them.
 */
export function snapRange(range: Range): Range {
  const r = range.cloneRange();
  if (r.startContainer.nodeType === Node.TEXT_NODE) r.setStart(r.startContainer, wordStart((r.startContainer as Text).data, r.startOffset));
  if (r.endContainer.nodeType === Node.TEXT_NODE) r.setEnd(r.endContainer, wordEnd((r.endContainer as Text).data, r.endOffset));
  return r;
}

/**
 * Of the places `wanted` occurs in `text`, the one whose surroundings best agree with the text kept
 * before and after it. All of them are compared as given, so squash them the same way first. `bonus`
 * adds to a place's score; ties go to the first place, or the last. -1 when it isn't there.
 */
export function bestOccurrence(
  text: string,
  wanted: string,
  context: { prefix?: string; suffix?: string } = {},
  where: "first" | "last" = "first",
  bonus?: (at: number) => number,
): number {
  if (!wanted) return -1;
  const pre = context.prefix ?? "";
  const suf = context.suffix ?? "";
  let best = -1;
  let bestScore = -1;
  for (let at = text.indexOf(wanted); at >= 0; at = text.indexOf(wanted, at + 1)) {
    const before = agree(text.slice(Math.max(0, at - pre.length), at), pre, true);
    const after = agree(text.slice(at + wanted.length, at + wanted.length + suf.length), suf, false);
    const score = before + after + (bonus?.(at) ?? 0);
    if (score > bestScore || (where === "last" && score === bestScore)) (best = at), (bestScore = score);
  }
  return best;
}
