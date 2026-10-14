import { useEffect, useState, type CSSProperties, type MouseEvent, type RefObject } from "react";
import { scrollMotion } from "../lib/util";
import type { ArticleHeading } from "../reader/markdown";
import "../styles/article.css";

/*
 * Contents for a saved article. On wide screens it is a rail beside the reading column; on narrow
 * ones it is a list folded up above the text. The current section is the last heading to have
 * scrolled past a probe line a fifth of the way down the reader, so the list follows the reading.
 */

/** Wide enough for the rail beside the text. Keep in step with the breakpoint in styles/article.css. */
const RAIL_QUERY = "(min-width: 1100px)";

/** Whether the window is wide enough for the contents rail, following resizes. */
export function useRailFits(): boolean {
  const [fits, setFits] = useState(() => matchMedia(RAIL_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(RAIL_QUERY);
    const update = () => setFits(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return fits;
}

export function ArticleToc({ headings, scroller, rail }: { headings: ArticleHeading[]; scroller: RefObject<HTMLElement | null>; rail: boolean }) {
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    const root = scroller.current;
    if (!root || headings.length < 2) return;
    // Each heading's id maps to whether its top is above the probe line. The observer reports a
    // heading each time it crosses the reader's edge, so the list follows without a scroll listener.
    const above = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        const line = root.getBoundingClientRect().top + root.clientHeight * 0.2;
        for (const e of entries) above.set(e.target.id, e.boundingClientRect.top < line);
        let last: string | null = null;
        for (const h of headings) if (above.get(h.id)) last = h.id;
        setCurrent(last);
      },
      { root, rootMargin: "0px 0px -80% 0px" },
    );
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [headings, scroller]);

  if (headings.length < 2) return null;

  // Indent by depth from the shallowest heading, so a page whose sections start at h3 still reads as a tree.
  const shallowest = Math.min(...headings.map((h) => h.level));

  // scroll-margin-top on the heading keeps it clear of the sticky bars. A pick also folds the narrow
  // list away first, so the heading's place is measured after the list has gone and it lands in view.
  const go = (id: string, e: MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.closest("details")?.removeAttribute("open");
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: scrollMotion() });
  };

  const list = (
    <ul className="toc-list">
      {headings.map((h) => (
        <li key={h.id} style={{ "--depth": Math.min(3, h.level - shallowest) } as CSSProperties}>
          <button
            type="button"
            className={h.id === current ? "on" : undefined}
            aria-current={h.id === current ? "location" : undefined}
            onClick={(e) => go(h.id, e)}
          >
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  );

  return rail ? (
    <nav className="toc-rail" aria-label="Contents">
      <span className="field-label">Contents</span>
      {list}
    </nav>
  ) : (
    <details className="toc-inline">
      <summary>Contents</summary>
      {list}
    </details>
  );
}
