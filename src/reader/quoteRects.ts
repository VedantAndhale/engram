import { Util } from "pdfjs-dist";
import type { PDFDoc } from "../lib/pdf";
import type { Rect } from "../model";
import { bestOccurrence } from "./anchor";

/*
 * Where a quote sits on a page, so a highlight made in the reading view is painted on the page too.
 * Matching ignores case, whitespace and hyphens, because the reading view joins words that a line
 * break split and the page's text may still carry the hyphen.
 */

type Page = Awaited<ReturnType<PDFDoc["getPage"]>>;
type Items = Awaited<ReturnType<Page["getTextContent"]>>["items"];
type TextItem = Extract<Items[number], { str: string }>;

/** Dropped when squashing: the reading view joins a word split at a hyphen, and the page keeps the hyphen. */
const HYPHEN = /[-­‐‑]/;

/** Lowercased with whitespace and hyphens removed, and for each kept character, where it sits in the original. */
export function squash(text: string): { text: string; at: number[] } {
  let out = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch) || HYPHEN.test(ch)) continue;
    const lower = ch.toLowerCase();
    out += lower;
    // Lowercasing can turn one character into two; both point back at the same original character.
    for (let k = 0; k < lower.length; k++) at.push(i);
  }
  return { text: out, at };
}

/** Clamps a page coordinate to 0..1 of the page's size. */
const unit = (v: number, size: number) => Math.min(1, Math.max(0, v / size));

/** One line's part of a quote, in top-left page units. */
interface Box {
  x0: number;
  x1: number;
  y: number;
  size: number;
  top: number;
  bottom: number;
}

/**
 * Rectangles (0..1 of the page's width and height, top-left origin, as highlights are stored) that
 * cover the quote on one page. Null when the quote isn't on that page. When the quote appears more
 * than once, the text kept before and after it picks the place; failing that, `where` does: the
 * first, or the last (a passage that ends a page).
 */
export async function rectsForQuote(pdf: PDFDoc, page: number, quote: string, where: "first" | "last" = "first", context: Context = {}): Promise<Rect[] | null> {
  const wanted = squash(quote).text;
  if (!wanted) return null;

  const pg = await pdf.getPage(page);
  const vp = pg.getViewport({ scale: 1 });
  const content = await pg.getTextContent();
  pg.cleanup();

  // The page's text as one string, each character tied back to its item and its place in it. Items
  // are joined without spaces: squash drops whitespace anyway, so the match ignores where items meet.
  const runs: TextItem[] = [];
  const runOf: number[] = [];
  const charOf: number[] = [];
  let text = "";
  for (const it of content.items) {
    if (!("str" in it) || !it.str) continue;
    const run = runs.length;
    runs.push(it);
    for (let c = 0; c < it.str.length; c++) {
      runOf.push(run);
      charOf.push(c);
    }
    text += it.str;
  }

  const squashed = squash(text);
  const start = bestOccurrence(squashed.text, wanted, squashContext(context), where);
  if (start < 0) return null;

  // For each item the quote touches, the characters it covers, from the first to the last.
  const spans = new Map<number, { from: number; to: number }>();
  for (let s = start; s < start + wanted.length; s++) {
    const at = squashed.at[s];
    const run = runOf[at];
    const c = charOf[at];
    const span = spans.get(run);
    if (span) {
      span.from = Math.min(span.from, c);
      span.to = Math.max(span.to, c + 1);
    } else spans.set(run, { from: c, to: c + 1 });
  }

  const boxes: Box[] = [];
  for (const [run, { from, to }] of spans) {
    const it = runs[run];
    const m: number[] = Util.transform(vp.transform, it.transform);
    const size = Math.hypot(m[2], m[3]);
    // The text layer gives each item's width but not each character's, so characters share it evenly.
    const perChar = it.width / it.str.length;
    const box: Box = {
      x0: m[4] + from * perChar,
      x1: m[4] + to * perChar,
      y: m[5],
      size,
      top: m[5] - 0.8 * size,
      bottom: m[5] + 0.2 * size,
    };
    // Pieces on one line make one box, so a highlight is a bar per line rather than per word.
    const same = boxes.find((b) => Math.abs(b.y - box.y) <= 0.5 * size);
    if (same) {
      same.x0 = Math.min(same.x0, box.x0);
      same.x1 = Math.max(same.x1, box.x1);
      same.top = Math.min(same.top, box.top);
      same.bottom = Math.max(same.bottom, box.bottom);
    } else boxes.push(box);
  }

  return boxes.map((b) => {
    const x = unit(b.x0, vp.width);
    const y = unit(b.top, vp.height);
    return { x, y, w: unit(b.x1, vp.width) - x, h: unit(b.bottom, vp.height) - y };
  });
}

/** The text kept just before and after a highlight's quote. */
export interface Context {
  prefix?: string;
  suffix?: string;
}

/** A context squashed as quotes are, for comparing with a page's squashed text. */
export const squashContext = (c: Context): Context => ({ prefix: squash(c.prefix ?? "").text, suffix: squash(c.suffix ?? "").text });

/** One page's part of a passage: where it is on the page, its own words, and the text around them. */
export interface QuotePart extends Context {
  page: number;
  rects: Rect[];
  quote: string;
}

/**
 * Where a passage sits when it may run over a page break: one part per page it touches, each with
 * only that page's words, as a page-view selection is saved. It is looked for whole on the page the
 * reading view says it starts on, then the page after and the page before, since a block can start
 * on any of them. Null when no such pages hold it.
 */
export async function rectsForQuoteAcross(pdf: PDFDoc, page: number, quote: string, context: Context = {}): Promise<QuotePart[] | null> {
  const sq = squash(quote);
  if (!sq.text) return null;
  const candidates = [page, page + 1, page - 1].filter((p) => p >= 1 && p <= pdf.numPages);
  for (const p of candidates) {
    const rects = await rectsForQuote(pdf, p, quote, "first", context);
    if (rects) return [{ page: p, rects, quote, ...context }];
  }
  for (const p of candidates) {
    if (p + 1 > pdf.numPages) continue;
    const split = await splitAcross(pdf, p, sq.text, context);
    if (!split) continue;
    const [head, tail] = splitQuote(quote, split.cut);
    return [
      { page: p, rects: split.head, quote: head, prefix: context.prefix, suffix: tail.slice(0, 32) },
      { page: p + 1, rects: split.tail, quote: tail, prefix: head.slice(-32), suffix: context.suffix },
    ];
  }
  return null;
}

/** A quote cut in two where its squashed text is cut at `cut` (quoteRects' squash), each part trimmed. */
export function splitQuote(quote: string, cut: number): [string, string] {
  const at = squash(quote).at[cut] ?? quote.length;
  return [quote.slice(0, at).trim(), quote.slice(at).trim()];
}

/**
 * A passage that starts on `page` and ends on the next one. The longest start of it that is on `page`
 * is found first (the start only ever shortens to something still on the page, so a binary search
 * works), and the rest must be at the top of the next page. `cut` is where the squashed passage splits.
 */
async function splitAcross(pdf: PDFDoc, page: number, wanted: string, context: Context): Promise<{ head: Rect[]; tail: Rect[]; cut: number } | null> {
  let lo = 1;
  let hi = wanted.length - 1;
  let head: Rect[] | null = null;
  let cut = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rects = await rectsForQuote(pdf, page, wanted.slice(0, mid), "last", { prefix: context.prefix });
    if (rects) {
      head = rects;
      cut = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (!head) return null;
  const tail = await rectsForQuote(pdf, page + 1, wanted.slice(cut), "first", { suffix: context.suffix });
  return tail ? { head, tail, cut } : null;
}
