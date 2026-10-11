import { useEffect, type RefObject } from "react";
import { toast } from "../../store/ui";
import type { Tool } from "./PageView";

/*
 * Touch and pen with the highlighter, pen or eraser out. Pages stop handing touches to the
 * browser (touch-action: none, in app.css), so a stroke or a highlight never turns into a
 * scroll halfway through. In exchange this does the scrolling:
 *
 * - one finger (or a pen) drags across text to highlight it, or draws with the pen tool;
 * - two fingers scroll, and so does one finger that starts where there's no text;
 * - once a pen has been used, one finger always scrolls and only the pen marks the page.
 *
 * The margins around the pages scroll as usual. With the select tool nothing changes.
 * Articles use the same rules, with the article text as the surface.
 */

let penUsed = false;
/** Whether a pen has been used on this device this session; fingers then scroll instead of marking. */
export const penSeen = () => penUsed;

const HINT_KEY = "reader.touchHint";

/** What a tool marks: the element touches are taken over on, and the element holding its text. */
export interface Surface {
  surface: string;
  text: string;
}
const PDF_PAGES: Surface = { surface: ".page", text: ".textLayer" };

export function useTouchTools(scroller: RefObject<HTMLElement | null>, tool: Tool, ready: boolean, where: Surface = PDF_PAGES) {
  const { surface, text } = where;
  useEffect(() => {
    const el = scroller.current;
    if (!el || tool === "select") return;
    const points = new Map<number, { x: number; y: number }>();
    let panning = false;
    let anchor: Caret | null = null;

    const centre = () => {
      let x = 0;
      let y = 0;
      for (const p of points.values()) (x += p.x), (y += p.y);
      return { x: x / points.size, y: y / points.size };
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || !(e.target as Element).closest?.(surface)) return;
      if (e.pointerType === "pen") penUsed = true;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (e.pointerType === "touch" && !localStorage.getItem(HINT_KEY)) {
        localStorage.setItem(HINT_KEY, "1");
        toast("Two fingers scroll while a tool is out.");
      }
      if (points.size > 1 || (e.pointerType === "touch" && penUsed)) return startPan();
      if (tool !== "highlight") return; // the ink layer draws or erases
      anchor = caretAt(e.clientX, e.clientY, text);
      if (!anchor) return startPan();
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
    };

    const startPan = () => {
      panning = true;
      anchor = null;
      window.getSelection()?.removeAllRanges();
    };

    const onMove = (e: PointerEvent) => {
      const p = points.get(e.pointerId);
      if (!p) return;
      if (panning) {
        const before = centre();
        p.x = e.clientX;
        p.y = e.clientY;
        const after = centre();
        el.scrollBy(before.x - after.x, before.y - after.y);
        return;
      }
      p.x = e.clientX;
      p.y = e.clientY;
      const focus = anchor && caretAt(e.clientX, e.clientY, text);
      if (anchor && focus) window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    };

    // The reader's own pointerup handler then turns the selection into a highlight.
    const onUp = (e: PointerEvent) => {
      if (!points.delete(e.pointerId) || points.size > 0) return;
      panning = false;
      anchor = null;
    };

    // A long press would open the browser's text menu over the page.
    const onMenu = (e: Event) => {
      if (points.size > 0 || (e.target as Element).closest?.(surface)) e.preventDefault();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("contextmenu", onMenu);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("contextmenu", onMenu);
    };
  }, [scroller, tool, ready, surface, text]);
}

export type Caret = { node: Node; offset: number };

/** The text position under a point, if it's inside the text (a PDF page's text layer, an article). */
export function caretAt(x: number, y: number, text = PDF_PAGES.text): Caret | null {
  let caret: Caret | null = null;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) caret = { node: p.offsetNode, offset: p.offset };
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) caret = { node: r.startContainer, offset: r.startOffset };
  }
  if (!caret) return null;
  const el = caret.node instanceof Element ? caret.node : caret.node.parentElement;
  // pdf.js puts an empty block at the end of each text layer; landing there isn't text.
  if (!el?.closest(text)) return null;
  return text === PDF_PAGES.text && (el.classList.contains("endOfContent") || el.classList.contains("textLayer")) ? null : caret;
}
