import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNotes, type Note } from "../../ai/notes";
import { findQuote, indexText } from "../../reader/anchor";
import { NoteCard } from "./NoteCard";
import { settle } from "./settle";

/** The top of a note's passage: its selected words when they can be found, else its paragraph. */
function passageTop(article: HTMLElement, note: Note): number | null {
  const para = article.querySelector<HTMLElement>(`[data-para="${note.anchor.para}"]`);
  if (!para) return null;
  const quote = note.anchor.quote;
  const range = quote ? findQuote(indexText(para), { quote }) : null;
  return (range?.getClientRects()[0] ?? para.getBoundingClientRect()).top;
}

/** Wide enough for a column of notes beside the text. Keep in step with the breakpoint in styles/article.css. */
const MARGIN_QUERY = "(min-width: 1280px)";

/** Whether the window is wide enough for the margin, following resizes. */
export function useMarginFits(): boolean {
  const [fits, setFits] = useState(() => matchMedia(MARGIN_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(MARGIN_QUERY);
    const update = () => setFits(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return fits;
}

/**
 * The notes of an article, in a column beside its text. Each stands level with its passage; the open
 * one stays exactly there and the others settle above and below it, so none covers another.
 */
export function Margin({ item, scroller }: { item: string; scroller: RefObject<HTMLElement | null> }) {
  const all = useNotes((s) => s.notes);
  const notes = useMemo(() => all.filter((n) => n.item === item), [all, item]);
  const active = useNotes((s) => s.active);
  /** The article's text, whichever way the page was laid out. */
  const article = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return scroller.current?.querySelector<HTMLElement>(".article-text") ?? null;
      },
    }),
    [scroller],
  );
  const column = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const placed = useRef(new Set<string>());
  const frame = useRef(0);
  const [layout, setLayout] = useState<{ tops: Record<string, number>; height: number }>({ tops: {}, height: 0 });

  const compute = useCallback(() => {
    const col = column.current;
    const root = article.current;
    if (!col || !root) return;
    const base = col.getBoundingClientRect().top;
    const items: { id: string; desired: number; h: number }[] = [];
    for (const n of notes) {
      const top = passageTop(root, n);
      if (top !== null) items.push({ id: n.id, desired: top - base - 4, h: cards.current.get(n.id)?.offsetHeight ?? 64 });
    }
    items.sort((a, b) => a.desired - b.desired);
    const tops = settle(items, active);
    const height = items.reduce((m, i) => Math.max(m, tops[i.id] + i.h), 0);
    setLayout((prev) =>
      prev.height === height && Object.keys(tops).length === Object.keys(prev.tops).length && Object.entries(tops).every(([k, v]) => Math.abs((prev.tops[k] ?? -1e9) - v) < 0.5)
        ? prev
        : { tops, height },
    );
  }, [notes, active, article]);

  const schedule = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(compute);
  }, [compute]);

  useLayoutEffect(() => {
    compute();
  }, [compute]);

  useLayoutEffect(() => {
    for (const id of Object.keys(layout.tops)) placed.current.add(id);
  }, [layout]);

  // The text reflows when the window or the type size changes, and a note grows as its answer streams in.
  useEffect(() => {
    const watch = new ResizeObserver(schedule);
    if (article.current) watch.observe(article.current);
    for (const el of cards.current.values()) watch.observe(el);
    window.addEventListener("resize", schedule);
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => {
      watch.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame.current);
    };
  }, [schedule, article, notes, active]);

  return (
    <div ref={column} className="margin-col" style={{ minHeight: layout.height }}>
      {notes.map((n) => (
        <NoteCard
          key={n.id}
          ref={(el) => {
            if (el) cards.current.set(n.id, el);
            else cards.current.delete(n.id);
          }}
          note={n}
          variant="margin"
          active={active === n.id}
          top={layout.tops[n.id]}
          fresh={!placed.current.has(n.id)}
        />
      ))}
    </div>
  );
}
