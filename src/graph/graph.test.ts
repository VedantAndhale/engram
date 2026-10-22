import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, labelAt, layout, linkedTitles, neighbourhood, type GItem } from "./graph";

const item = (id: string, title: string, body = "", topics: string[] = []): GItem => ({ id, title, type: "note", body, topics });

test("links are read from the words, with a shown name, a highlight ref, and an embed", () => {
  assert.deepEqual(linkedTitles("See [[Rivers]] and [[Lakes|the lakes]] and [[Deltas#^abc]].\n\n![[Seas#^f00]]"), ["Rivers", "Lakes", "Deltas", "Seas"]);
  assert.deepEqual(linkedTitles(undefined), []);
});

test("a link joins two items once, whichever way and however often it is written", () => {
  const g = buildGraph([item("a", "Alpha", "[[Beta]] [[beta]]"), item("b", "Beta", "[[Alpha]]"), item("c", "Gamma")]);
  assert.equal(g.edges.filter((e) => e.kind === "link").length, 1);
  assert.equal(g.nodes.find((n) => n.id === "a")!.degree, 1);
  assert.equal(g.nodes.find((n) => n.id === "c")!.degree, 0);
});

test("a link to nothing, and a link to itself, draw no line", () => {
  const g = buildGraph([item("a", "Alpha", "[[Nowhere]] [[Alpha]]")]);
  assert.deepEqual(g.edges, []);
});

test("a topic joins items only when two or more share it", () => {
  const g = buildGraph([item("a", "A", "", ["Rivers"]), item("b", "B", "", ["rivers", "Lakes"]), item("c", "C", "", ["Lakes ", "Solo"])]);
  const topics = g.nodes.filter((n) => n.kind === "topic").map((n) => n.label).sort();
  assert.deepEqual(topics, ["Lakes", "Rivers"]);
  assert.ok(!g.nodes.some((n) => n.label === "Solo"));
  assert.equal(g.edges.filter((e) => e.kind === "topic").length, 4);
});

test("past the limit the least connected items go, and the count is kept", () => {
  const items = [item("hub", "Hub", "[[A]] [[B]]"), item("a", "A"), item("b", "B"), item("x", "X"), item("y", "Y")];
  const g = buildGraph(items, 3);
  assert.equal(g.omitted, 2);
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["a", "b", "hub"]);
  assert.equal(g.edges.length, 2);
});

test("a neighbourhood is the item, what touches it, and the items on its topics", () => {
  const g = buildGraph([item("a", "A", "[[B]]", ["T"]), item("b", "B"), item("c", "C", "", ["T"]), item("d", "D", "[[C]]")]);
  const local = neighbourhood(g, "a");
  const ids = local.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["a", "b", "c", "topic:t"]);
  assert.ok(!ids.includes("d"), "two steps away is not a neighbour");
});

test("the layout gives every node a finite place inside the box, and is the same every time", () => {
  const g = buildGraph([item("a", "A", "[[B]] [[C]]"), item("b", "B", "[[C]]"), item("c", "C"), item("d", "D"), item("e", "E")]);
  const one = layout(g, 600, 400);
  const two = layout(g, 600, 400);
  for (const [id, p] of one) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), id);
    assert.ok(p.x >= 0 && p.x <= 600 && p.y >= 0 && p.y <= 400, `${id} ${p.x},${p.y}`);
    assert.deepEqual(p, two.get(id));
  }
  assert.equal(one.size, 5);
});

test("linked items end up closer than items with no link", () => {
  const items = [item("a", "A", "[[B]]"), item("b", "B"), item("c", "C", "[[D]]"), item("d", "D"), item("e", "E"), item("f", "F")];
  const pos = layout(buildGraph(items), 800, 600);
  const dist = (p: string, q: string) => Math.hypot(pos.get(p)!.x - pos.get(q)!.x, pos.get(p)!.y - pos.get(q)!.y);
  assert.ok(dist("a", "b") < dist("a", "e"));
  assert.ok(dist("c", "d") < dist("c", "f"));
});

test("a name sits right of its dot, and goes left when the right side has no room", () => {
  assert.deepEqual(labelAt(100, 4, 80, 0, 300), { x: 109, align: "left" });
  assert.deepEqual(labelAt(280, 4, 80, 0, 300), { x: 271, align: "right" });
});

test("a name too wide for either side is pulled in from the edge on the side with more room", () => {
  // Right side has 30px, left side 180px, a 200px name fits neither: it goes left and stays on screen.
  const left = labelAt(170, 4, 200, 0, 200);
  assert.equal(left.align, "right");
  assert.ok(left.x - 200 >= 0 && left.x <= 200, JSON.stringify(left));
  // Left side has 30px, right side 180px: the name goes right, and its end stays on screen.
  const right = labelAt(30, 4, 200, 0, 210);
  assert.equal(right.align, "left");
  assert.ok(right.x >= 0 && right.x + 200 <= 210, JSON.stringify(right));
});

test("an empty folder and a single item lay out without trouble", () => {
  assert.equal(layout(buildGraph([]), 300, 200).size, 0);
  const one = layout(buildGraph([item("a", "A")]), 300, 200);
  assert.deepEqual(one.get("a"), { x: 150, y: 100 });
});

test("a few hundred items lay out quickly", () => {
  const items = Array.from({ length: 300 }, (_, i) => item(`i${i}`, `Item ${i}`, i > 0 ? `[[Item ${Math.floor(i / 3)}]]` : "", [`t${i % 12}`]));
  const t0 = Date.now();
  const pos = layout(buildGraph(items), 1000, 700);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.ok([...pos.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
});
