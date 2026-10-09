import { memo, useEffect, useRef, useState } from "react";
import { pdfjsLib, type PDFDoc } from "../../lib/pdf";
import type { Annotation } from "../../model";
import { hitsStroke, inkPath, INK_UNITS } from "../../reader/geometry";

export type Tool = "select" | "highlight" | "ink" | "eraser";

export interface PageSize {
  w: number;
  h: number;
}

interface Props {
  pdf: PDFDoc;
  page: number;
  size: PageSize;
  scale: number;
  /** Close enough to the viewport to be worth rendering. */
  near: boolean;
  annotations: Annotation[];
  tool: Tool;
  inkColor: string;
  inkSize: number;
  findTerms: string[];
  selectedId?: string;
  onPickAnnotation: (a: Annotation, anchor: DOMRect) => void;
  onInk: (page: number, points: number[]) => void;
  onErase: (id: string) => void;
}

/** Keep huge pages from allocating giant canvases on high-DPI screens. */
const MAX_CANVAS_PIXELS = 16_000_000;

export const PageView = memo(function PageView(p: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const width = Math.floor(p.size.w * p.scale);
  const height = Math.floor(p.size.h * p.scale);

  useEffect(() => {
    if (!p.near) {
      setRendered(false);
      const c = canvasRef.current;
      if (c) c.width = c.height = 0; // free the bitmap while the page is far away
      if (textRef.current) textRef.current.replaceChildren();
      return;
    }
    let cancelled = false;
    let task: { cancel: () => void } | undefined;
    let textLayer: InstanceType<typeof pdfjsLib.TextLayer> | undefined;
    void (async () => {
      const page = await p.pdf.getPage(p.page);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: p.scale });
      const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      // Render into an offscreen canvas and swap it in, so zooming never flashes a blank page.
      const off = document.createElement("canvas");
      off.width = Math.floor(viewport.width * dpr);
      off.height = Math.floor(viewport.height * dpr);
      const render = page.render({ canvas: off, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      task = render;
      try {
        await render.promise;
      } catch {
        return; // cancelled
      }
      if (cancelled || !canvasRef.current) return;
      const c = canvasRef.current;
      c.width = off.width;
      c.height = off.height;
      c.getContext("2d")!.drawImage(off, 0, 0);
      off.width = off.height = 0;
      setRendered(true);

      const container = textRef.current;
      if (!container) return;
      container.replaceChildren();
      textLayer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
      await textLayer.render().catch(() => {});
      if (!cancelled) markFind(container, p.findTerms);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
    };
    // findTerms is applied separately below, without re-rendering the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.pdf, p.page, p.scale, p.near]);

  useEffect(() => {
    if (textRef.current && rendered) markFind(textRef.current, p.findTerms);
  }, [p.findTerms, rendered]);

  const highlights = p.annotations.filter((a) => a.kind === "highlight" && a.rects);
  const strokes = p.annotations.filter((a) => a.kind === "ink" && a.points);

  return (
    <div
      className={`page tool-${p.tool}`}
      data-page={p.page}
      style={
        {
          width,
          height,
          "--total-scale-factor": p.scale,
          "--scale-round-x": "1px",
          "--scale-round-y": "1px",
        } as React.CSSProperties
      }
    >
      <canvas ref={canvasRef} className="page-canvas" style={{ width, height }} />
      {!rendered && <div className="page-loading" />}

      <svg className="hl-layer" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
        {highlights.map((a) =>
          a.rects!.map((r, i) => (
            <rect
              key={`${a.id}-${i}`}
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              fill={a.color}
              className={a.id === p.selectedId ? "selected" : undefined}
            />
          )),
        )}
      </svg>

      <div ref={textRef} className="textLayer" />

      {/* Click targets for highlights sit above the text so a tap opens the highlight instead of selecting text. */}
      {p.tool !== "ink" && p.tool !== "eraser" && (
        <div className="hl-hits">
          {highlights.map((a) =>
            a.rects!.map((r, i) => (
              <button
                key={`${a.id}-${i}`}
                className="hl-hit"
                aria-label={a.note ? `Highlight with note: ${a.note}` : `Highlight: ${a.quote ?? ""}`}
                style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
                onClick={(e) => p.onPickAnnotation(a, e.currentTarget.getBoundingClientRect())}
              />
            )),
          )}
          {highlights
            .filter((a) => a.note)
            .map((a) => {
              const r = a.rects![0];
              return (
                <button
                  key={`${a.id}-note`}
                  className="note-pin"
                  aria-label="Open note"
                  style={{ left: `calc(${(r.x + r.w) * 100}% + 2px)`, top: `${r.y * 100}%`, background: a.color }}
                  onClick={(e) => p.onPickAnnotation(a, e.currentTarget.getBoundingClientRect())}
                />
              );
            })}
        </div>
      )}

      <InkLayer {...p} strokes={strokes} />
    </div>
  );
});

function InkLayer(p: Props & { strokes: Annotation[] }) {
  const ref = useRef<SVGSVGElement>(null);
  const [live, setLive] = useState<number[] | null>(null);
  const drawing = useRef<{ id: number; points: number[] } | null>(null);
  const aspect = p.size.h / p.size.w;
  const active = p.tool === "ink" || p.tool === "eraser";

  const toUnits = (e: React.PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    return [((e.clientX - box.left) / box.width) * INK_UNITS, ((e.clientY - box.top) / box.height) * INK_UNITS * aspect];
  };

  const erase = (e: React.PointerEvent) => {
    const [x, y] = toUnits(e);
    for (const s of p.strokes) if (hitsStroke(s.points!, x, y, Math.max(10, (s.size ?? 4) * 2))) p.onErase(s.id);
  };

  const onDown = (e: React.PointerEvent) => {
    if (!active || (e.pointerType === "mouse" && e.button !== 0)) return;
    // With a pen available, fingers keep scrolling and only the pen draws.
    if (e.pointerType === "touch" && penSeen) return;
    if (e.pointerType === "pen") penSeen = true;
    e.preventDefault();
    ref.current!.setPointerCapture(e.pointerId);
    if (p.tool === "eraser") {
      drawing.current = { id: e.pointerId, points: [] };
      erase(e);
      return;
    }
    const [x, y] = toUnits(e);
    drawing.current = { id: e.pointerId, points: [x, y, pressure(e)] };
    setLive(drawing.current.points);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    if (p.tool === "eraser") return erase(e);
    for (const ev of e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]) {
      const box = ref.current!.getBoundingClientRect();
      d.points.push(
        Math.round(((ev.clientX - box.left) / box.width) * INK_UNITS * 10) / 10,
        Math.round(((ev.clientY - box.top) / box.height) * INK_UNITS * aspect * 10) / 10,
        Math.round(pressure(ev) * 100) / 100,
      );
    }
    setLive([...d.points]);
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    drawing.current = null;
    setLive(null);
    if (p.tool === "ink" && d.points.length >= 3) p.onInk(p.page, d.points);
  };

  return (
    <svg
      ref={ref}
      className={`ink-layer ${active ? "active" : ""}`}
      viewBox={`0 0 ${INK_UNITS} ${INK_UNITS * aspect}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {p.strokes.map((s) => (
        <path key={s.id} d={inkPath(s.points!, s.size ?? 4)} fill={s.color} />
      ))}
      {live && <path d={inkPath(live, p.inkSize, true)} fill={p.inkColor} />}
    </svg>
  );
}

let penSeen = false;

/** Mice and some touchscreens report 0 or 0.5 constantly; treat those as "no pressure data". */
function pressure(e: PointerEvent | React.PointerEvent) {
  return e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
}

/**
 * Mark text-layer spans for a find. Spans holding the whole phrase win; failing that, spans with
 * every word; failing that, spans with any longer word. Spans are whole text runs, so this is close, not exact.
 */
function markFind(container: HTMLElement, terms: string[]) {
  const lower = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const spans = Array.from(container.querySelectorAll<HTMLElement>("span"));
  const texts = spans.map((s) => (s.textContent ?? "").toLowerCase().replace(/\s+/g, " "));
  const phrase = lower.join(" ");
  const tests: ((t: string) => boolean)[] = [
    (t) => t.includes(phrase),
    (t) => lower.every((w) => t.includes(w)),
    (t) => lower.some((w) => w.length > 1 && t.includes(w)),
  ];
  const test = lower.length ? tests.find((f) => texts.some(f)) : undefined;
  spans.forEach((span, i) => span.classList.toggle("find-hit", !!test?.(texts[i])));
}
