import { Util } from "pdfjs-dist";
import type { PDFDoc } from "../lib/pdf";

/*
 * The reading view's text. A PDF's own text, taken from the file and laid out as paragraphs and
 * headings, so it reads like an article. Pages are kept as the place each block starts, so the
 * page view, the contents list and the notes can still find their way back to the page.
 */

/** Changes whenever the extraction changes, so a cached reflow from an older version is rebuilt. */
export const REFLOW_VERSION = 2;

/** One paragraph or heading, in reading order, with the page it starts on (1-based). */
export interface ReflowBlock {
  page: number;
  kind: "p" | "h";
  /** Headings only: 1 is the largest, 3 the smallest. */
  level?: number;
  text: string;
}

export interface Reflow {
  version: number;
  pages: number;
  blocks: ReflowBlock[];
  /** Pages whose text could not be read. They are left out, and the reader is told. */
  skipped?: number[];
}

/** A word split at a line end: a letter, then a hyphen, and nothing after it. */
const SPLIT_WORD = /\p{L}[-­‐‑]$/u;
const STARTS_LOWER = /^\p{Ll}/u;
/** The end of a paragraph: . ! ? : or ), allowing a closing quote or bracket after it. */
const ENDS_PARAGRAPH = /[.!?:)]["'’”»\]]*$/;
/** A folio: a bare page number, "Page 3", "3 of 12", or a roman numeral. */
const FOLIO = /^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$|^[ivxlcdm]+$/i;
/** The top and bottom 9 percent of a page, where running headers, footers and page numbers sit. */
const EDGE = 0.09;

type Page = Awaited<ReturnType<PDFDoc["getPage"]>>;
type Viewport = ReturnType<Page["getViewport"]>;
type Items = Awaited<ReturnType<Page["getTextContent"]>>["items"];

/** A piece of text on the page: its start and end along the line, and its baseline and size. */
interface Run {
  str: string;
  x: number;
  end: number;
  y: number;
  size: number;
}

/** One line of text as printed, before lines are joined into headings and paragraphs. */
interface Line {
  page: number;
  text: string;
  /** Font size, rounded to the nearest half point. */
  size: number;
  x0: number;
  x1: number;
  /** Baseline, measured down from the top of the page. */
  y: number;
  edge: boolean;
}

/**
 * Takes the PDF's text as paragraphs and headings. Running headers, footers and bare page numbers
 * are dropped. A paragraph that carries over a page break is joined into one block.
 */
export async function extractReflow(pdf: PDFDoc, onProgress?: (done: number, total: number) => void): Promise<Reflow> {
  const pages: Line[][] = [];
  const skipped: number[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    // One page that won't read is left out, rather than failing the whole reading view.
    try {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(linesOf(content.items, page.getViewport({ scale: 1 }), n));
      page.cleanup();
    } catch {
      pages.push([]);
      skipped.push(n);
    }
    onProgress?.(n, pdf.numPages);
  }
  const kept = dropFurniture(pages);
  return { version: REFLOW_VERSION, pages: pdf.numPages, blocks: layout(kept, bodySize(kept.flat())), ...(skipped.length ? { skipped } : {}) };
}

/**
 * The reflow for a document: from this device's cache when it is the current version, otherwise
 * extracted once and cached. The cache is local (not synced); it is derived from the PDF itself.
 */
export async function reflowFor(folder: string, doc: string, pdf: PDFDoc, onProgress?: (done: number, total: number) => void): Promise<Reflow> {
  // Loaded on first use, so that importing this module doesn't pull in the database.
  const { folderCtx } = await import("../folders/registry");
  const { db } = folderCtx(folder);
  const key = `reflow:${doc}`;
  const cached = await db.kvGet<Reflow>(key);
  if (cached?.version === REFLOW_VERSION) return cached;
  const reflow = await extractReflow(pdf, onProgress);
  await db.kvSet(key, reflow);
  return reflow;
}

/** Lines of one page, top to bottom. Pieces of text share a line when their baselines are close. */
function linesOf(items: Items, vp: Viewport, page: number): Line[] {
  const runs: Run[] = [];
  for (const it of items) {
    if (!("str" in it) || !it.str) continue;
    // Mapped to top-left page coordinates, so y grows downwards as it does on screen.
    const m: number[] = Util.transform(vp.transform, it.transform);
    runs.push({ str: it.str, x: m[4], end: m[4] + it.width, y: m[5], size: Math.hypot(m[2], m[3]) });
  }
  runs.sort((a, b) => a.y - b.y || a.x - b.x);

  const rows: { y: number; size: number; runs: Run[] }[] = [];
  for (const r of runs) {
    const row = rows.at(-1);
    if (row && r.y - row.y <= 0.5 * Math.max(row.size, r.size)) {
      row.runs.push(r);
      row.size = Math.max(row.size, r.size);
    } else rows.push({ y: r.y, size: r.size, runs: [r] });
  }

  const lines: Line[] = [];
  for (const row of rows) {
    row.runs.sort((a, b) => a.x - b.x);
    let text = "";
    let prev: Run | undefined;
    for (const r of row.runs) {
      // A gap wider than a fifth of the font size is a word space, unless a space is already there.
      if (prev && r.x - prev.end > 0.2 * Math.max(prev.size, r.size) && !/\s$/.test(text) && !/^\s/.test(r.str)) {
        text += " ";
      }
      text += r.str;
      prev = r;
    }
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    lines.push({
      page,
      text: clean,
      size: Math.round(row.size * 2) / 2,
      x0: row.runs[0].x,
      x1: Math.max(...row.runs.map((r) => r.end)),
      y: row.y,
      edge: row.y < EDGE * vp.height || row.y > (1 - EDGE) * vp.height,
    });
  }
  return lines;
}

/** Lowercase, digits as #, spaces collapsed: "Page 3" and "Page 12" count as the same running head. */
const normalise = (text: string) => text.toLowerCase().replace(/\d/g, "#").replace(/\s+/g, " ").trim();

/**
 * Drops running headers and footers, and folios. A line in the top or bottom band of a page is a
 * running head when it repeats in that band on other pages. A short document needs every readable
 * page to carry it, since two pages can share a line by chance; a longer one needs a third of its
 * pages, and at least three. Folios go wherever they sit in a band.
 */
function dropFurniture(pages: Line[][]): Line[][] {
  const readable = pages.filter((lines) => lines.length).length;
  const repeated = new Set<string>();
  if (readable >= 2) {
    const onPages = new Map<string, Set<number>>();
    for (const l of pages.flat()) {
      if (!l.edge) continue;
      const key = normalise(l.text);
      onPages.set(key, (onPages.get(key) ?? new Set<number>()).add(l.page));
    }
    const least = readable >= 4 ? Math.max(3, 0.3 * readable) : readable;
    for (const [key, seen] of onPages) if (seen.size >= least) repeated.add(key);
  }
  return pages.map((lines) => lines.filter((l) => !l.edge || (!FOLIO.test(l.text) && !repeated.has(normalise(l.text)))));
}

/** The most common size, each line counted by its length, so a few large headings don't win. */
function bodySize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const l of lines) weight.set(l.size, (weight.get(l.size) ?? 0) + l.text.length);
  let body = 0;
  let most = 0;
  for (const [size, w] of weight) {
    if (w > most) {
      body = size;
      most = w;
    }
  }
  return body;
}

/** Adds the next line to a paragraph. A word split at the line end by a hyphen is joined without it. */
const joinLine = (text: string, prevLine: string, next: string) =>
  SPLIT_WORD.test(prevLine) && STARTS_LOWER.test(next) ? text.slice(0, -1) + next : `${text} ${next}`;

/** Headings and paragraphs in reading order, from the lines that are left. */
function layout(pages: Line[][], body: number): ReflowBlock[] {
  const isHeading = (l: Line) => l.size >= 1.25 * body && l.text.length <= 140;

  // The usual distance between two body lines. A gap well beyond it starts a new paragraph.
  const gaps: number[] = [];
  for (const lines of pages) {
    for (let i = 1; i < lines.length; i++) {
      if (!isHeading(lines[i]) && !isHeading(lines[i - 1])) gaps.push(lines[i].y - lines[i - 1].y);
    }
  }
  gaps.sort((a, b) => a - b);
  const spacing = gaps.length ? gaps[gaps.length >> 1] : Infinity;

  // Per page, the widest body line and the left margin: they judge short last lines and indents.
  const widest = pages.map((lines) => Math.max(0, ...lines.filter((l) => !isHeading(l)).map((l) => l.x1 - l.x0)));
  const margin = pages.map((lines) => Math.min(...lines.filter((l) => !isHeading(l)).map((l) => l.x0)));

  /** Whether a body line carries on the paragraph before it, rather than starting a new one. */
  const continues = (text: string, prev: Line, line: Line) => {
    // Over a page break a paragraph goes on unless its text ends a sentence. A line that starts in
    // lower case always goes on, even after "et al." or a closing bracket. The page's margins don't apply there.
    if (prev.page !== line.page) return STARTS_LOWER.test(line.text) || !ENDS_PARAGRAPH.test(text);
    if (line.y - prev.y > 1.6 * spacing) return false;
    // A first line indented about an em starts a paragraph. A wrapped line sits on the margin.
    if (line.x0 - margin[line.page - 1] > 0.5 * body) return false;
    if (STARTS_LOWER.test(line.text)) return true;
    // After a sentence, a short last line or a clear gap ends the paragraph. A wrapped line doesn't.
    if (ENDS_PARAGRAPH.test(text) && (prev.x1 - prev.x0 < 0.6 * widest[line.page - 1] || line.y - prev.y > 1.2 * spacing)) return false;
    return true;
  };

  const blocks: ReflowBlock[] = [];
  let current: ReflowBlock | undefined;
  let prev: Line | undefined;
  for (const l of pages.flat()) {
    if (isHeading(l)) {
      if (current?.kind === "h" && prev && isHeading(prev) && prev.size === l.size) {
        current.text = `${current.text} ${l.text}`;
      } else {
        const ratio = l.size / body;
        current = { page: l.page, kind: "h", level: ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : 3, text: l.text };
        blocks.push(current);
      }
    } else if (current?.kind === "p" && prev && continues(current.text, prev, l)) {
      current.text = joinLine(current.text, prev.text, l.text);
    } else {
      current = { page: l.page, kind: "p", text: l.text };
      blocks.push(current);
    }
    prev = l;
  }
  return blocks;
}
