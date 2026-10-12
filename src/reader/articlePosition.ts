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
 */

const PAUSE_MS = 500;

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

    const flush = () => {
      window.clearTimeout(timer);
      const f = moved;
      moved = null;
      if (f === null || f === written) return;
      written = f;
      void savePosition(folder, doc, 0, f);
    };
    const onScroll = () => {
      if (!ready || range() <= 0) return;
      moved = Math.min(1, Math.max(0, el.scrollTop / range()));
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, PAUSE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", flush);

    void (async () => {
      const saved = await db.positions.get(doc);
      // Fonts and two frames first, so the text has its final height before the fraction is applied.
      await document.fonts.ready;
      await nextFrame();
      await nextFrame();
      if (!live) return;
      // Only a saved place is restored. ItemView is keyed by item, so a new article already starts at the top.
      const offset = saved?.offset ?? 0;
      if (offset > 0 && range() > 0) {
        el.scrollTop = offset * range();
        written = offset;
      }
      // The restore's scroll event is dispatched before the next frame's callbacks, so this comes after it.
      await nextFrame();
      if (live) ready = true;
    })();

    return () => {
      live = false;
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [folder, doc, scroller, enabled]);
}
