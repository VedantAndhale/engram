import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useNotes } from "../../ai/notes";
import { scaleSpans, viewTopFor, viewWindow, type Span } from "../../reader/minimap";
import "../../styles/notes.css";

interface Geometry {
  total: number;
  /** How far down the scroller the text starts. */
  offset: number;
  rail: number;
  bars: Span[];
  highlights: number[];
  notes: number[];
}

/**
 * A thin strip beside the article that stands for all of it: a bar for each paragraph, a yellow tick for each
 * highlight, a dot for each AI note, and a frame around what is on screen. Press anywhere on it, or drag, to
 * go there. It only draws on a wide window and a long text, and it is a visual aid, so assistive technology
 * skips it: the article is already reachable by scrolling and by the contents.
 */
export function Minimap({ scroller, ranges, highlightKey, item }: { scroller: RefObject<HTMLElement | null>; ranges: RefObject<Map<string, Range>>; highlightKey: string; item: string }) {
  // Which paragraphs have an AI note, as a string, so streaming words don't redraw the strip.
  const noteParas = useNotes((s) =>
    s.notes
      .filter((n) => n.item === item)
      .map((n) => n.anchor.para)
      .sort((a, b) => a - b)
      .join(","),
  );
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [view, setView] = useState<Span>({ top: 0, height: 0 });
  const rail = useRef<HTMLDivElement>(null);
  const frame = useRef(0);

  const measure = useCallback(() => {
    const root = scroller.current;
    const text = root?.querySelector<HTMLElement>(".article-text");
    if (!root || !text) return;
    const box = text.getBoundingClientRect();
    const total = box.height;
    // Long enough to be worth a map: more than a screen and a half.
    if (total < root.clientHeight * 1.5) return setGeo(null);
    const railH = Math.max(120, Math.min(440, window.innerHeight - 260));
    const paras = [...text.querySelectorAll<HTMLElement>("[data-para]")];
    const spans = paras.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top - box.top, height: r.height };
    });
    const topOf = (px: number) => scaleSpans([{ top: px, height: 0 }], total, railH)[0].top;
    const byPara = new Map(paras.map((el) => [el.dataset.para, el.getBoundingClientRect().top - box.top]));
    setGeo({
      total,
      offset: box.top - root.getBoundingClientRect().top + root.scrollTop,
      rail: railH,
      bars: scaleSpans(spans, total, railH),
      highlights: [...ranges.current.values()].map((r) => topOf(r.getBoundingClientRect().top - box.top)),
      notes: noteParas ? noteParas.split(",").map((n) => topOf(byPara.get(n) ?? 0)) : [],
    });
  }, [scroller, ranges, noteParas, highlightKey]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // The text reflows with the window and the type size.
  useEffect(() => {
    const text = scroller.current?.querySelector(".article-text");
    const watch = new ResizeObserver(measure);
    if (text) watch.observe(text);
    window.addEventListener("resize", measure);
    return () => {
      watch.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, scroller]);

  // The frame follows the scroll.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !geo) return;
    const update = () => {
      frame.current = 0;
      setView(viewWindow(root.scrollTop - geo.offset, root.clientHeight, geo.total, geo.rail));
    };
    const onScroll = () => {
      if (!frame.current) frame.current = requestAnimationFrame(update);
    };
    update();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [geo, scroller]);

  if (!geo) return null;

  const go = (e: ReactPointerEvent) => {
    const root = scroller.current;
    const box = rail.current?.getBoundingClientRect();
    if (!root || !box) return;
    root.scrollTo({ top: geo.offset + viewTopFor(e.clientY - box.top, geo.rail, geo.total, root.clientHeight), behavior: "instant" });
  };

  return (
    <div className="minimap" aria-hidden="true">
      <div
        ref={rail}
        className="minimap-rail"
        style={{ height: geo.rail }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          go(e);
        }}
        onPointerMove={(e) => e.buttons === 1 && go(e)}
      >
        {geo.bars.map((b, i) => (
          <span key={i} className="minimap-bar" style={{ top: b.top, height: b.height }} />
        ))}
        {geo.highlights.map((top, i) => (
          <span key={`h${i}`} className="minimap-hl" style={{ top }} />
        ))}
        {geo.notes.map((top, i) => (
          <span key={`n${i}`} className="minimap-note" style={{ top }} />
        ))}
        <span className="minimap-view" style={{ top: view.top, height: view.height }} />
      </div>
    </div>
  );
}
