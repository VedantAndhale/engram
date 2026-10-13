import { useEffect, type RefObject } from "react";
import { folderCtx } from "../folders/registry";
import type { Position } from "../model";
import { savePosition } from "../store/actions";

/**
 * A position part way through an article. Page 0 is how articles save theirs; the ends (0 unread,
 * 1 finished) are not progress worth showing.
 */
export function partlyRead(p?: Position): p is Position {
  return !!p && p.page === 0 && p.offset > 0 && p.offset < 1;
}

/*
 * Where you are in a saved article, kept as a fraction of its scroll range. It goes in the same
 * positions table as the PDF reader's, on page 0. It is saved once you pause scrolling, when you
 * leave the article, and when the page is hidden. It is put back once, after the text has laid out.
 *
 * A fraction drifts on a page with pictures: they load as you reach them, so the scroll range when
 * you left is not the one when you come back. So this device also keeps the paragraph at the top of
 * the window and how far into it, and goes back to that when the synced place is the one it left.
 * Pictures that load above it afterwards don't move it, until you scroll.
 */

const PAUSE_MS = 500;
/** How long a place is held while pictures above it load, unless the reader moves first. */
const SETTLE_MS = 15_000;
/** The elements a place is kept against, in document order. */
const BLOCKS = ".article-text :is(p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, img, table, hr)";

/** Where an article was left on this device: a block, how far down it, and the synced fraction saved with it. */
interface Place {
  block: number;
  within: number;
  offset: number;
}

const placeKey = (doc: string) => `article.place:${doc}`;

function readPlace(doc: string): Place | null {
  try {
    return JSON.parse(localStorage.getItem(placeKey(doc)) ?? "null") as Place | null;
  } catch {
    return null;
  }
}

/** The block at the top of the scroller's window, and how far down it that edge is. */
function placeIn(el: HTMLElement, offset: number): Place | null {
  const line = el.getBoundingClientRect().top;
  const blocks = el.querySelectorAll<HTMLElement>(BLOCKS);
  for (let i = 0; i < blocks.length; i++) {
    const r = blocks[i].getBoundingClientRect();
    if (r.bottom > line) return { block: i, within: Math.min(1, Math.max(0, (line - r.top) / Math.max(1, r.height))), offset };
  }
  return null;
}

/** Scrolls so a kept place is at the top of the window again. False when the article has no such block. */
function goTo(el: HTMLElement, place: Place): boolean {
  const block = el.querySelectorAll<HTMLElement>(BLOCKS)[place.block];
  if (!block) return false;
  const r = block.getBoundingClientRect();
  el.scrollTop += r.top - el.getBoundingClientRect().top + place.within * r.height;
  return true;
}

const nextFrame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

export function useArticlePosition(folder: string, doc: string, scroller: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = scroller.current;
    if (!enabled || !el) return;
    const { db } = folderCtx(folder);
    const range = () => el.scrollHeight - el.clientHeight;
    let live = true;
    // Stays false until the saved place is back, so the restore's own scrolling is never saved as a new place.
    let ready = false;
    let timer: number | undefined;
    let moved: number | null = null; // the latest place, not yet written
    let written: number | null = null; // the place last written or restored
    let settle: ResizeObserver | undefined;
    const stopSettling = () => settle?.disconnect();

    const flush = () => {
      window.clearTimeout(timer);
      const f = moved;
      moved = null;
      if (f === null || f === written) return;
      written = f;
      void savePosition(folder, doc, 0, f);
      // Only while the article is on screen: once it is gone there is nothing to measure, and the place kept before stands.
      const place = el.isConnected && placeIn(el, Math.round(f * 1000) / 1000);
      if (place) localStorage.setItem(placeKey(doc), JSON.stringify(place));
    };
    const onScroll = () => {
      if (!ready || range() <= 0) return;
      moved = Math.min(1, Math.max(0, el.scrollTop / range()));
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, PAUSE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", flush);
    // The reader's own wheel, touch, press or key ends the hold on a restored place.
    const moves = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const m of moves) el.addEventListener(m, stopSettling, { passive: true });

    void (async () => {
      const saved = await db.positions.get(doc);
      // Fonts and two frames first, so the text has its final height before the fraction is applied.
      await document.fonts.ready;
      await nextFrame();
      await nextFrame();
      if (!live) return;
      // Only a saved place is restored. ItemView is keyed by item, so a new article already starts at the top.
      const offset = saved?.offset ?? 0;
      // This device's own place, when the synced one is what it saved with it; else the fraction.
      const place = readPlace(doc);
      if (offset > 0 && place && Math.abs(place.offset - offset) < 0.0005 && goTo(el, place)) {
        written = offset;
        const text = el.querySelector(".article-text");
        if (text) {
          settle = new ResizeObserver(() => goTo(el, place));
          settle.observe(text);
          window.setTimeout(stopSettling, SETTLE_MS);
        }
      } else if (offset > 0 && range() > 0) {
        el.scrollTop = offset * range();
        written = offset;
      }
      // The restore's scroll event is dispatched before the next frame's callbacks, so this comes after it.
      await nextFrame();
      if (live) ready = true;
    })();

    return () => {
      live = false;
      stopSettling();
      el.removeEventListener("scroll", onScroll);
      for (const m of moves) el.removeEventListener(m, stopSettling);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [folder, doc, scroller, enabled]);
}
