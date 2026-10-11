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

export function indexText(root: Element): TextIndex {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let full = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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

/** Offset into `full` of a DOM position inside the article. */
function offsetOf(ix: TextIndex, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(ix.root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** What to store for a selection: the quote as the reader sees it, and the text around it. */
export function quoteOf(ix: TextIndex, range: Range): { quote: string; prefix: string; suffix: string } | null {
  if (!ix.root.contains(range.commonAncestorContainer)) return null;
  const s = offsetOf(ix, range.startContainer, range.startOffset);
  const e = offsetOf(ix, range.endContainer, range.endOffset);
  const quote = range.toString().replace(/\s+/g, " ").trim();
  if (!quote || e <= s) return null;
  const tidy = (t: string) => t.replace(/\s+/g, " ");
  return {
    quote,
    prefix: tidy(ix.full.slice(Math.max(0, s - CONTEXT * 2), s)).slice(-CONTEXT),
    suffix: tidy(ix.full.slice(e, e + CONTEXT * 2)).slice(0, CONTEXT),
  };
}
