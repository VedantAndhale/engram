import { useEffect, useMemo, useRef, useState } from "react";
import { layout, type GNode, type Graph, type Point } from "../graph/graph";
import "../styles/graph.css";

interface View {
  k: number;
  tx: number;
  ty: number;
}

const radius = (n: GNode, focus: boolean) => (n.kind === "topic" ? 3.2 : 3.6 + Math.min(6, Math.sqrt(n.degree) * 1.7) + (focus ? 2.5 : 0));

/**
 * A folder's graph drawn on a canvas. Items are dots sized by their lines, a topic is a small square their
 * lines meet at, and a line between items is a link. Pointing names a dot; pressing opens its item. Unless
 * `compact`, drag moves the picture and the wheel zooms. A list of the same items sits beside it for keyboards
 * and screen readers, since a canvas has nothing to tab to.
 */
export function GraphCanvas({
  graph,
  focus,
  height = 520,
  compact = false,
  onOpen,
  hrefFor,
  label,
}: {
  graph: Graph;
  /** The item to stand out, such as the one being read. */
  focus?: string;
  height?: number;
  compact?: boolean;
  onOpen: (id: string) => void;
  hrefFor: (id: string) => string;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const view = useRef<View>({ k: 1, tx: 0, ty: 0 });
  const hover = useRef<string | null>(null);
  const frame = useRef(0);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);

  // The picture is laid out for the width in steps of 40px, so a small resize does not shuffle it.
  const w = Math.max(240, Math.round(width / 40) * 40);
  const positions = useMemo<Map<string, Point>>(() => (width > 0 ? layout(graph, w, height) : new Map()), [graph, w, height, width]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    setWidth(el.clientWidth);
    return () => watch.disconnect();
  }, []);

  const draw = () => {
    frame.current = 0;
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const css = getComputedStyle(cv);
    const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const text = color("--text", "#222");
    const muted = color("--muted", "#777");
    const accent = color("--accent", "#c60");
    const border = color("--border", "#ccc");
    const bg = color("--bg", "#fff");
    const v = view.current;
    ctx.translate(v.tx, v.ty);
    ctx.scale(v.k, v.k);

    const near = new Set<string>();
    if (hover.current) {
      near.add(hover.current);
      for (const e of graph.edges) {
        if (e.a === hover.current) near.add(e.b);
        if (e.b === hover.current) near.add(e.a);
      }
    }
    // Lines first, the ones touching the hovered dot last and strongest.
    for (const pass of [false, true])
      for (const e of graph.edges) {
        const touching = !!hover.current && (e.a === hover.current || e.b === hover.current);
        if (touching !== pass) continue;
        const a = positions.get(e.a);
        const b = positions.get(e.b);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.setLineDash(e.kind === "topic" ? [3, 4] : []);
        ctx.strokeStyle = touching ? accent : e.kind === "topic" ? border : muted;
        ctx.globalAlpha = hover.current && !touching ? 0.25 : e.kind === "topic" ? 0.8 : 0.55;
        ctx.lineWidth = touching ? 1.6 : 1;
        ctx.stroke();
      }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const labelled = graph.nodes.length <= 30;
    for (const n of graph.nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const isFocus = n.id === focus;
      const r = radius(n, isFocus);
      ctx.globalAlpha = hover.current && !near.has(n.id) ? 0.3 : 1;
      ctx.beginPath();
      if (n.kind === "topic") ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
      else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n.kind === "topic" ? muted : isFocus || n.id === hover.current ? accent : text;
      ctx.fill();
      if (isFocus) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      const show = n.id === hover.current || isFocus || n.kind === "topic" || labelled || n.degree >= 3;
      if (show && (v.k >= 0.7 || n.id === hover.current)) {
        const t = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
        ctx.fillStyle = n.kind === "topic" ? muted : text;
        ctx.strokeStyle = bg;
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        ctx.strokeText(t, p.x + r + 5, p.y);
        ctx.fillText(t, p.x + r + 5, p.y);
      }
    }
    ctx.globalAlpha = 1;
  };
  const invalidate = () => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  };
  // Drawn as soon as anything it shows changes, not on the next frame, so it is there at once and does not
  // wait on a page that is not being painted. Moving the pointer or the wheel redraws on frames instead.
  useEffect(() => {
    draw();
    return () => cancelAnimationFrame(frame.current);
  });

  /** The item or topic under a pointer, in the picture's own coordinates. */
  const at = (clientX: number, clientY: number): GNode | null => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return null;
    const v = view.current;
    const wx = (clientX - rect.left - v.tx) / v.k;
    const wy = (clientY - rect.top - v.ty) / v.k;
    let best: GNode | null = null;
    let bestD = Infinity;
    for (const n of graph.nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const d = Math.hypot(p.x - wx, p.y - wy);
      if (d <= radius(n, n.id === focus) + 5 / v.k && d < bestD) (best = n), (bestD = d);
    }
    return best;
  };

  // The wheel zooms about the pointer. It has to be a listener of its own to stop the page scrolling.
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || compact) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const v = view.current;
      const k = Math.min(4, Math.max(0.4, v.k * Math.exp(-e.deltaY * 0.0015)));
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      view.current = { k, tx: px - ((px - v.tx) / v.k) * k, ty: py - ((py - v.ty) / v.k) * k };
      invalidate();
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  });

  const items = graph.nodes.filter((n) => n.kind === "item").sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));

  return (
    <div ref={box} className={`graph-box${compact ? " is-compact" : ""}`} style={{ height }}>
      <canvas
        ref={canvas}
        className="graph-canvas"
        style={{ width, height }}
        role="img"
        aria-label={label}
        onPointerDown={(e) => {
          if (compact) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d && e.buttons === 1) {
            if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
            if (d.moved) {
              view.current = { ...view.current, tx: d.tx + e.clientX - d.x, ty: d.ty + e.clientY - d.y };
              invalidate();
            }
            return;
          }
          const hit = at(e.clientX, e.clientY);
          if ((hit?.id ?? null) !== hover.current) {
            hover.current = hit?.id ?? null;
            if (canvas.current) canvas.current.style.cursor = hit?.kind === "item" ? "pointer" : "";
            invalidate();
          }
        }}
        onPointerLeave={() => {
          hover.current = null;
          invalidate();
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d?.moved) return;
          const hit = at(e.clientX, e.clientY);
          if (hit?.kind === "item") onOpen(hit.id);
        }}
        onClick={(e) => {
          // In the compact picture there is no drag, so a click opens.
          if (!compact) return;
          const hit = at(e.clientX, e.clientY);
          if (hit?.kind === "item") onOpen(hit.id);
        }}
        onDoubleClick={() => {
          view.current = { k: 1, tx: 0, ty: 0 };
          invalidate();
        }}
      />
      <ul className="sr-only">
        {items.map((n) => (
          <li key={n.id}>
            <a href={hrefFor(n.id)}>
              {n.label}
              {n.degree ? `, ${n.degree} ${n.degree === 1 ? "line" : "lines"}` : ""}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
