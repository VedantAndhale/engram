import { getStroke } from "perfect-freehand";
import type { Rect } from "../model";

/** Ink points are stored with the page width as 1000 units, so strokes keep their shape at any zoom. */
export const INK_UNITS = 1000;

/** How much of the page's text is kept before and after a highlight, to tell repeats of its quote apart. */
const CONTEXT = 32;

/** One page's part of a text selection: where it sits on the page, its own text, and the text around it. */
export interface PagePart {
  rects: Rect[];
  quote: string;
  prefix: string;
  suffix: string;
}

/**
 * Turn a text selection into each page's part of it: page-relative rectangles, and that page's own
 * words. Pages are found from the selection itself, not from what is under each rectangle, so lines
 * scrolled off screen while selecting are kept. Neighbouring rects on the same line are merged, so a
 * highlight reads as one bar, not a row of word boxes.
 */
export function selectionParts(range: Range, pageEl: (el: Element) => { page: number; el: HTMLElement } | null): Map<number, PagePart> {
  const out = new Map<number, PagePart>();
  const common = range.commonAncestorContainer;
  const at = common instanceof Element ? common : common.parentElement;
  if (!at) return out;
  const own = pageEl(at);
  // Within one page, that page; across pages, every page the selection touches.
  const pages = own ? [own] : Array.from(at.querySelectorAll(".page")).filter((el) => range.intersectsNode(el)).map((el) => pageEl(el)).filter((p): p is { page: number; el: HTMLElement } => !!p);
  for (const { page, el } of pages) {
    const part = document.createRange();
    part.selectNodeContents(el);
    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
    const box = el.getBoundingClientRect();
    const rects: Rect[] = [];
    for (const r of Array.from(part.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      // Skip the oversized rects some browsers report for whole text-layer containers.
      if (r.height > box.height * 0.2) continue;
      rects.push({ x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height });
    }
    const quote = rangeText(part).replace(/\s+/g, " ").trim();
    if (!rects.length || !quote) continue;
    const layer = el.querySelector(".textLayer") ?? el;
    const before = document.createRange();
    before.selectNodeContents(layer);
    const after = before.cloneRange();
    if (layer.contains(part.startContainer)) before.setEnd(part.startContainer, part.startOffset);
    if (layer.contains(part.endContainer)) after.setStart(part.endContainer, part.endOffset);
    out.set(page, {
      rects: mergeLines(rects),
      quote,
      prefix: rangeText(before).replace(/\s+/g, " ").slice(-CONTEXT),
      suffix: rangeText(after).replace(/\s+/g, " ").slice(0, CONTEXT),
    });
  }
  return out;
}

/**
 * The text of a range, with a space where a line break element is. The PDF text layer ends each
 * line with a <br> and no space, so a range's own text would glue the last word of a line to the next.
 */
function rangeText(range: Range): string {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return (root as Text).data.slice(range.startOffset, range.endOffset);
  let out = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n as Text).data;
      out += t.slice(n === range.startContainer ? range.startOffset : 0, n === range.endContainer ? range.endOffset : t.length);
    } else if ((n as Element).tagName === "BR") out += " ";
  }
  return out;
}

function mergeLines(rects: Rect[]): Rect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const merged: Rect[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    const sameLine = last && Math.abs(last.y + last.h / 2 - (r.y + r.h / 2)) < Math.min(last.h, r.h) * 0.5;
    if (sameLine && r.x <= last.x + last.w + 0.01) {
      const right = Math.max(last.x + last.w, r.x + r.w);
      const top = Math.min(last.y, r.y);
      last.h = Math.max(last.y + last.h, r.y + r.h) - top;
      last.y = top;
      last.w = right - last.x;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** SVG path for a stroke, in ink units. */
export function inkPath(points: number[], size: number, live = false): string {
  const pts: number[][] = [];
  for (let i = 0; i + 2 < points.length; i += 3) pts.push([points[i], points[i + 1], points[i + 2]]);
  const outline = getStroke(pts, { size, thinning: 0.55, smoothing: 0.5, streamline: 0.45, simulatePressure: pts.every((p) => p[2] === 0.5), last: !live });
  if (!outline.length) return "";
  const d = outline.reduce<string[]>((acc, [x0, y0], i, arr) => {
    const [x1, y1] = arr[(i + 1) % arr.length];
    acc.push(`${x0.toFixed(1)},${y0.toFixed(1)} ${((x0 + x1) / 2).toFixed(1)},${((y0 + y1) / 2).toFixed(1)}`);
    return acc;
  }, []);
  return `M${d[0].split(" ")[0]} Q${d.join(" ")} Z`;
}

/** Whether a point (ink units) is within `radius` of a stroke. Used by the eraser. */
export function hitsStroke(points: number[], x: number, y: number, radius: number): boolean {
  const r2 = radius * radius;
  // Measure against each segment, not just the samples: fast strokes have widely spaced points.
  for (let i = 0; i + 1 < points.length; i += 3) {
    const ax = points[i], ay = points[i + 1];
    const bx = i + 4 < points.length ? points[i + 3] : ax;
    const by = i + 4 < points.length ? points[i + 4] : ay;
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2)) : 0;
    const dx = ax + t * vx - x;
    const dy = ay + t * vy - y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}
