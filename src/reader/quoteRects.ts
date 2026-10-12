import { Util } from "pdfjs-dist";
import type { PDFDoc } from "../lib/pdf";
import type { Rect } from "../model";

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
 * cover the quote on one page. Null when the quote isn't on that page. `where` picks the occurrence
 * when the quote appears more than once: the first, or the last (a passage that ends a page).
 */
export async function rectsForQuote(pdf: PDFDoc, page: number, quote: string, where: "first" | "last" = "first"): Promise<Rect[] | null> {
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
  const start = where === "last" ? squashed.text.lastIndexOf(wanted) : squashed.text.indexOf(wanted);
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

/**
 * Where a passage sits when it may run over a page break: one part per page it touches, as a
 * highlight is saved on each page of a page-view selection. It is looked for whole on the page the
 * reading view says it starts on, then the page after and the page before, since a block can start
 * on any of them. Null when no such pages hold it.
 */
export async function rectsForQuoteAcross(pdf: PDFDoc, page: number, quote: string): Promise<{ page: number; rects: Rect[] }[] | null> {
  const wanted = squash(quote).text;
  if (!wanted) return null;
  const candidates = [page, page + 1, page - 1].filter((p) => p >= 1 && p <= pdf.numPages);
  for (const p of candidates) {
    const rects = await rectsForQuote(pdf, p, quote);
    if (rects) return [{ page: p, rects }];
  }
  for (const p of candidates) {
    if (p + 1 > pdf.numPages) continue;
    const parts = await splitAcross(pdf, p, wanted);
    if (parts) return parts;
  }
  return null;
}

/**
 * A passage that starts on `page` and ends on the next one. The longest start of it that is on `page`
 * is found first (the start only ever shortens to something still on the page, so a binary search
 * works), and the rest must be at the top of the next page.
 */
async function splitAcross(pdf: PDFDoc, page: number, wanted: string): Promise<{ page: number; rects: Rect[] }[] | null> {
  let lo = 1;
  let hi = wanted.length - 1;
  let head: Rect[] | null = null;
  let cut = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rects = await rectsForQuote(pdf, page, wanted.slice(0, mid), "last");
    if (rects) {
      head = rects;
      cut = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (!head) return null;
  const tail = await rectsForQuote(pdf, page + 1, wanted.slice(cut), "first");
  return tail ? [{ page, rects: head }, { page: page + 1, rects: tail }] : null;
}
