import { getStroke } from "perfect-freehand";
import type { Rect } from "../model";

/** Ink points are stored with the page width as 1000 units, so strokes keep their shape at any zoom. */
export const INK_UNITS = 1000;

/**
 * Turn a text selection into page-relative rectangles for each page it touches.
 * Neighbouring rects on the same line are merged, so a highlight reads as one bar, not a row of word boxes.
 */
export function selectionRects(range: Range, pageEl: (el: Element) => { page: number; el: HTMLElement } | null) {
  const out = new Map<number, Rect[]>();
  for (const r of Array.from(range.getClientRects())) {
    if (r.width < 1 || r.height < 1) continue;
    const hit = pageEl(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) ?? document.body);
    if (!hit) continue;
    const box = hit.el.getBoundingClientRect();
    // Skip the oversized rects some browsers report for whole text-layer containers.
    if (r.height > box.height * 0.2) continue;
    const rect = { x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height };
    out.set(hit.page, [...(out.get(hit.page) ?? []), rect]);
  }
  for (const [page, rects] of out) out.set(page, mergeLines(rects));
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
