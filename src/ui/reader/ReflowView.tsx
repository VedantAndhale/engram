import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { scrollMotion } from "../../lib/util";
import type { Annotation } from "../../model";
import { bestOccurrence, snapRange } from "../../reader/anchor";
import { squash, squashContext } from "../../reader/quoteRects";
import type { Reflow, ReflowBlock } from "../../reader/reflow";
import { toast } from "../../store/ui";
import "../../styles/reflow.css";
import { caretAt, type Surface } from "./touch";

/*
 * The reading view: the PDF's text as an article, in the column and type of a saved article. Pages
 * stay visible as a "Page N" line where the page changes and as each block's data-page, so the
 * contents, the notes and the find bar can still move between pages. Highlights are painted with
 * the browser's highlight API, as ArticleView paints them, and found again by their quote.
 */

/** Where a selection, a tap or a highlight's text is looked for in the reading view. */
export const REFLOW_SURFACE: Surface = { surface: ".reflow", text: ".reflow" };

/** How far below the top edge a jump stops, so the line isn't pinned to the edge. */
const TOP_GAP = 24;
/** The ::highlight(hl-picked) rule in app.css, shared with the article view. */
const PICKED = "hl-picked";

/** How much of the reading text is kept before and after a highlight, to tell repeats of its quote apart. */
const CONTEXT = 32;

/** Text selected in the reading view: its quote, the page it starts on, the text around it, and where its popover goes. */
export interface ReflowSelection {
  text: string;
  page: number;
  prefix: string;
  suffix: string;
  anchor: DOMRect;
}

interface Props {
  reflow: Reflow;
  /** Text size in px, already scaled by zoom. */
  size: number;
  /** Every annotation of the document; the live highlights among them are painted. */
  annotations: Annotation[];
  selectedId?: string;
  /** Filled with the range each painted highlight covers, by annotation id, so the notes can jump to it. */
  ranges: RefObject<Map<string, Range>>;
  onSelect: (sel: ReflowSelection) => void;
  onPick: (id: string, anchor: DOMRect) => void;
}

export const ReflowView = memo(function ReflowView({ reflow, size, annotations, selectedId, ranges, onSelect, onPick }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const index = useMemo(() => indexBlocks(reflow.blocks), [reflow]);
  const highlights = useMemo(() => annotations.filter((a) => a.kind === "highlight" && a.quote?.trim() && !a.deleted), [annotations]);

  // Paint every highlight whose quote can be found, one highlight group per colour.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !("highlights" in CSS)) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>(".reflow-block"));
    ranges.current.clear();
    const groups = new Map<string, Range[]>();
    for (const a of highlights) {
      const r = quoteRange(els, index, reflow.blocks, a);
      if (!r) continue;
      ranges.current.set(a.id, r);
      groups.set(a.color, [...(groups.get(a.color) ?? []), r]);
    }
    const names: string[] = [];
    let css = "";
    [...groups].forEach(([color, rs], i) => {
      const name = `reflow-${i}`;
      names.push(name);
      CSS.highlights.set(name, new Highlight(...rs));
      // Colours come from synced files: only a plain hex colour goes into the style sheet.
      const safe = /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#f7d154";
      css += `::highlight(${name}){background-color:color-mix(in srgb, ${safe} 50%, transparent)}`;
    });
    highlightSheet().textContent = css;
    return () => names.forEach((n) => CSS.highlights.delete(n));
  }, [reflow, index, highlights, ranges]);

  // The picked highlight is outlined here as it is in the page view.
  useEffect(() => {
    if (!("highlights" in CSS)) return;
    const r = selectedId ? ranges.current.get(selectedId) : undefined;
    if (r) CSS.highlights.set(PICKED, new Highlight(r));
    else CSS.highlights.delete(PICKED);
    return () => void CSS.highlights.delete(PICKED);
  }, [selectedId, highlights, ranges]);

  // A finished selection goes to the reader, which decides by tool. A tap on a highlight picks it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onUp = (e: PointerEvent) =>
      setTimeout(() => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount) {
          // A drag that starts or ends inside a word takes the whole word.
          const range = snapRange(sel.getRangeAt(0));
          const text = range.toString().replace(/\s+/g, " ").trim();
          if (!el.contains(range.commonAncestorContainer) || !text) return;
          const from = pageOf(range.startContainer);
          const to = pageOf(range.endContainer);
          if (from === null || to === null) return;
          // A passage may run over one page break, which highlightReading splits; a longer one can't be placed.
          if (to > from + 1) return void toast("Select a shorter passage to highlight");
          const rects = Array.from(range.getClientRects());
          const { prefix, suffix } = contextOf(index, range);
          return onSelect({ text, page: from, prefix, suffix, anchor: rects[rects.length - 1] ?? range.getBoundingClientRect() });
        }
        const at = caretAt(e.clientX, e.clientY, REFLOW_SURFACE.text);
        if (!at) return;
        for (const [id, r] of ranges.current) {
          if (r.isPointInRange(at.node, at.offset)) {
            const box = Array.from(r.getClientRects()).find((b) => b.top <= e.clientY && b.bottom >= e.clientY) ?? r.getBoundingClientRect();
            return onPick(id, box);
          }
        }
      }, 0);
    el.addEventListener("pointerup", onUp);
    return () => el.removeEventListener("pointerup", onUp);
  }, [onSelect, onPick, ranges, index]);

  if (!reflow.blocks.length) return <p className="reflow-status">This PDF has no text to read. Use the page view.</p>;

  return (
    <div ref={ref} className="reflow" style={{ "--reflow-size": `${size}px` } as React.CSSProperties}>
      {reflow.columns && <p className="reflow-status">This PDF is set in columns, so some lines here may be out of order, and its figures and tables are left out. The page view shows it as printed.</p>}
      {!!reflow.skipped?.length && (
        <p className="reflow-status">
          Couldn't read {reflow.skipped.length > 1 ? "pages" : "page"} {reflow.skipped.join(", ")}, so {reflow.skipped.length > 1 ? "they are" : "it is"} left out. The page view has {reflow.skipped.length > 1 ? "them" : "it"}.
        </p>
      )}
      {reflow.blocks.map((b, i) => {
        const Tag = b.kind === "p" ? "p" : b.level === 1 ? "h2" : b.level === 2 ? "h3" : "h4";
        return (
          <Fragment key={i}>
            {(i === 0 || reflow.blocks[i - 1].page !== b.page) && <div className="reflow-page">Page {b.page}</div>}
            <Tag className="reflow-block" data-page={b.page} data-index={i}>
              {b.text}
            </Tag>
          </Fragment>
        );
      })}
    </div>
  );
});

/** The block at a height in the reading view: the last one that starts at or above it. Null while there is no text. */
export function readingBlockAt(scroller: HTMLElement, y: number): HTMLElement | null {
  const blocks = scroller.querySelectorAll<HTMLElement>(".reflow-block");
  if (!blocks.length) return null;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (blocks[mid].offsetTop <= y) lo = mid;
    else hi = mid - 1;
  }
  return blocks[lo];
}

/** The first block on or after a page, for jumping to it. Null when the text has nothing from there on. */
export function readingBlockOnPage(scroller: HTMLElement, page: number): HTMLElement | null {
  const blocks = scroller.querySelectorAll<HTMLElement>(".reflow-block");
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(blocks[mid].dataset.page) < page) lo = mid + 1;
    else hi = mid;
  }
  return blocks[lo] ?? null;
}

/** Scrolls the reading view so a block, or a highlight's range, sits just under the top edge. */
export function scrollReadingTo(scroller: HTMLElement, target: Element | Range, smooth: boolean) {
  const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - TOP_GAP;
  scroller.scrollTo({ top, behavior: smooth ? scrollMotion() : "auto" });
}

/** The page of the block a node sits in, or null outside the text (the "Page N" lines, the margins). */
function pageOf(node: Node): number | null {
  const block = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".reflow-block");
  return block ? Number(block.dataset.page) : null;
}

interface TextIndex {
  /** The reading text, a newline between blocks. */
  joined: string;
  /** The whole reading text, squashed for matching (quoteRects.ts). */
  text: string;
  /** For each character of `text`, its position in the joined text. */
  at: number[];
  /** Where each block starts in the joined text. */
  starts: number[];
}

/*
 * The reading text joined with a newline between blocks. squash drops the newlines, so a quote that
 * runs over two paragraphs still matches; `at` maps back into the joined text, and `starts` says
 * where each block begins there.
 */
function indexBlocks(blocks: ReflowBlock[]): TextIndex {
  const starts: number[] = [];
  let joined = "";
  for (const b of blocks) {
    starts.push(joined.length);
    joined += `${b.text}\n`;
  }
  return { ...squash(joined), joined, starts };
}

/** The block a position in the joined text falls in: the last one that starts at or before it. */
function blockAt(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The reading text just before and after a selection, kept with its highlight. */
function contextOf(ix: TextIndex, range: Range): { prefix: string; suffix: string } {
  const offset = (node: Node, at: number) => {
    const block = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".reflow-block");
    if (!block) return null;
    // Each block holds one text node; a boundary on the block itself is before or after all of it.
    const inBlock = node.nodeType === Node.TEXT_NODE ? at : at > 0 ? (block.textContent ?? "").length : 0;
    return ix.starts[Number(block.dataset.index)] + inBlock;
  };
  const s = offset(range.startContainer, range.startOffset);
  const e = offset(range.endContainer, range.endOffset);
  if (s === null || e === null) return { prefix: "", suffix: "" };
  const tidy = (t: string) => t.replace(/\s+/g, " ");
  return { prefix: tidy(ix.joined.slice(Math.max(0, s - CONTEXT * 2), s)).slice(-CONTEXT), suffix: tidy(ix.joined.slice(e, e + CONTEXT * 2)).slice(0, CONTEXT) };
}

/** How much being on the highlight's own page counts for, against characters of agreeing context. */
const SAME_PAGE = 8;

/**
 * The range of a highlight's quote in the reading text, or null when the quote isn't there. A quote
 * can occur more than once: the text kept around it picks the place, helped by being on the
 * highlight's own page; failing both, the first.
 */
function quoteRange(els: HTMLElement[], ix: TextIndex, blocks: ReflowBlock[], a: Annotation): Range | null {
  const q = squash(a.quote ?? "").text;
  if (!q) return null;
  const hit = bestOccurrence(ix.text, q, squashContext(a), "first", (i) => (blocks[blockAt(ix.starts, ix.at[i])].page === a.page ? SAME_PAGE : 0));
  if (hit < 0) return null;
  const s = ix.at[hit];
  const e = ix.at[hit + q.length - 1] + 1;
  const first = blockAt(ix.starts, s);
  const last = blockAt(ix.starts, e - 1);
  const range = document.createRange();
  range.setStart(els[first].firstChild as Text, s - ix.starts[first]);
  range.setEnd(els[last].firstChild as Text, e - ix.starts[last]);
  return range;
}

/** One style element for the highlight colours, shared by whichever reading text is open. */
function highlightSheet(): HTMLStyleElement {
  let el = document.getElementById("reflow-highlights") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "reflow-highlights";
    document.head.append(el);
  }
  return el;
}
