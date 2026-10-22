/*
 * The graph of a folder: items are dots, a [[link]] from one item to another is a line, and a topic that
 * two or more items share is a small dot of its own that those items hang from. Built from what is already
 * in the items, on the device, with no model and no server. Layout is a small force simulation with a fixed
 * start, so the same folder always settles into the same picture.
 */
import { WIKI_LINK, parseTarget, sameTitle } from "../notes/links";

export interface GItem {
  id: string;
  title: string;
  type: string;
  body?: string;
  topics?: string[];
}

export interface GNode {
  id: string;
  label: string;
  kind: "item" | "topic";
  /** Lines touching it. */
  degree: number;
  /** The item's type, for items. */
  type?: string;
}

export interface GEdge {
  a: string;
  b: string;
  kind: "link" | "topic";
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  /** Items left out to keep the picture readable. */
  omitted: number;
}

const topicId = (name: string) => `topic:${name.trim().toLowerCase()}`;

/** The titles an item's words link to. */
export function linkedTitles(body: string | undefined): string[] {
  if (!body) return [];
  const titles: string[] = [];
  for (const m of body.matchAll(WIKI_LINK)) titles.push(parseTarget(m[1]).title);
  return titles;
}

/**
 * The graph of `items`. A link to a title no item has is dropped; a link an item makes to itself is too.
 * Past `max` items, those with the fewest lines are left out, and `omitted` says how many.
 */
export function buildGraph(items: GItem[], max = 400): Graph {
  const byTitle = new Map<string, GItem>();
  for (const item of items) {
    const key = item.title.trim().toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, item);
  }

  const seen = new Set<string>();
  const edges: GEdge[] = [];
  const add = (a: string, b: string, kind: GEdge["kind"]) => {
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, kind });
  };

  for (const item of items) {
    for (const title of linkedTitles(item.body)) {
      const target = byTitle.get(title.trim().toLowerCase()) ?? items.find((i) => sameTitle(i.title, title));
      if (target) add(item.id, target.id, "link");
    }
  }

  // A topic only joins items when two or more share it; alone it would be a dot with one line.
  const onTopic = new Map<string, { name: string; ids: string[] }>();
  for (const item of items)
    for (const name of new Set((item.topics ?? []).map((t) => t.trim()).filter(Boolean))) {
      const entry = onTopic.get(topicId(name)) ?? { name, ids: [] };
      entry.ids.push(item.id);
      onTopic.set(topicId(name), entry);
    }
  const topics: GNode[] = [];
  for (const [id, { name, ids }] of onTopic) {
    if (ids.length < 2) continue;
    topics.push({ id, label: name, kind: "topic", degree: 0 });
    for (const itemId of ids) add(itemId, id, "topic");
  }

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  let nodes: GNode[] = [
    ...items.map((i): GNode => ({ id: i.id, label: i.title || "Untitled", kind: "item", degree: degree.get(i.id) ?? 0, type: i.type })),
    ...topics.map((t) => ({ ...t, degree: degree.get(t.id) ?? 0 })),
  ];

  let omitted = 0;
  const itemNodes = nodes.filter((n) => n.kind === "item");
  if (itemNodes.length > max) {
    const keep = new Set([...itemNodes].sort((a, b) => b.degree - a.degree).slice(0, max).map((n) => n.id));
    omitted = itemNodes.length - max;
    nodes = nodes.filter((n) => n.kind === "topic" || keep.has(n.id));
  }
  const present = new Set(nodes.map((n) => n.id));
  const kept = edges.filter((e) => present.has(e.a) && present.has(e.b));
  // A topic left with fewer than two items has nothing to hang between.
  const topicLines = new Map<string, number>();
  for (const e of kept) if (e.kind === "topic") topicLines.set(e.b, (topicLines.get(e.b) ?? 0) + 1);
  const finalNodes = nodes.filter((n) => n.kind === "item" || (topicLines.get(n.id) ?? 0) >= 2);
  const finalIds = new Set(finalNodes.map((n) => n.id));
  return { nodes: finalNodes, edges: kept.filter((e) => finalIds.has(e.a) && finalIds.has(e.b)), omitted };
}

/** `focus`, what it links to or is linked from, and the topics it sits on with the items that share them. */
export function neighbourhood(graph: Graph, focus: string): Graph {
  const keep = new Set([focus]);
  for (const e of graph.edges) {
    if (e.a === focus) keep.add(e.b);
    if (e.b === focus) keep.add(e.a);
  }
  // Items on a topic the focus is on.
  const topics = [...keep].filter((id) => id.startsWith("topic:"));
  for (const e of graph.edges) if (e.kind === "topic" && topics.includes(e.b)) keep.add(e.a);
  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const edges = graph.edges.filter((e) => keep.has(e.a) && keep.has(e.b) && (e.a === focus || e.b === focus || e.kind === "topic"));
  return { nodes, edges, omitted: 0 };
}

export interface Point {
  x: number;
  y: number;
}

/** A small deterministic random number generator, so the same graph always lays out the same way. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Positions for `graph` in a box of `width` × `height`, from a force simulation: nodes push apart, lines
 * pull their ends together, and a light pull keeps everything near the middle. The result is scaled to fill
 * the box with a margin.
 */
export function layout(graph: Graph, width: number, height: number, steps = 220): Map<string, Point> {
  const n = graph.nodes.length;
  const out = new Map<string, Point>();
  if (n === 0) return out;
  if (n === 1) return out.set(graph.nodes[0].id, { x: width / 2, y: height / 2 });

  const rand = rng(n * 7919 + graph.edges.length);
  const index = new Map(graph.nodes.map((node, i) => [node.id, i]));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  // Start on a spiral, so nothing begins on top of another.
  for (let i = 0; i < n; i++) {
    const r = 12 * Math.sqrt(i + 1);
    const a = i * 2.399963 + rand() * 0.1;
    x[i] = r * Math.cos(a);
    y[i] = r * Math.sin(a);
  }
  const links = graph.edges.flatMap((e) => (index.has(e.a) && index.has(e.b) ? [{ a: index.get(e.a)!, b: index.get(e.b)!, w: e.kind === "link" ? 1 : 0.5 }] : []));

  const rest = 46;
  for (let step = 0; step < steps; step++) {
    const cool = 1 - step / steps;
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        let vx = x[i] - x[j];
        let vy = y[i] - y[j];
        let d2 = vx * vx + vy * vy;
        if (d2 < 0.01) {
          vx = rand() - 0.5;
          vy = rand() - 0.5;
          d2 = 0.25;
        }
        const f = 1800 / d2;
        const d = Math.sqrt(d2);
        dx[i] += (vx / d) * f;
        dy[i] += (vy / d) * f;
        dx[j] -= (vx / d) * f;
        dy[j] -= (vy / d) * f;
      }
    for (const l of links) {
      const vx = x[l.b] - x[l.a];
      const vy = y[l.b] - y[l.a];
      const d = Math.sqrt(vx * vx + vy * vy) || 0.01;
      const f = (d - rest) * 0.06 * l.w;
      dx[l.a] += (vx / d) * f;
      dy[l.a] += (vy / d) * f;
      dx[l.b] -= (vx / d) * f;
      dy[l.b] -= (vy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      dx[i] -= x[i] * 0.012;
      dy[i] -= y[i] * 0.012;
      // Each move is capped, and the cap falls as the picture settles.
      const m = Math.hypot(dx[i], dy[i]);
      const cap = 14 * cool + 0.5;
      const k = m > cap ? cap / m : 1;
      x[i] += dx[i] * k;
      y[i] += dy[i] * k;
    }
  }

  // Scale to the box, keeping the picture's proportions.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]);
    minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]);
  }
  const margin = 28;
  const scale = Math.min((width - 2 * margin) / Math.max(1, maxX - minX), (height - 2 * margin) / Math.max(1, maxY - minY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  graph.nodes.forEach((node, i) => out.set(node.id, { x: width / 2 + (x[i] - cx) * scale, y: height / 2 + (y[i] - cy) * scale }));
  return out;
}
