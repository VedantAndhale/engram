import { test } from "node:test";
import assert from "node:assert/strict";
import type { Annotation, Item } from "../model";
import { LibrarySearch, type SearchSource } from "./index";

let clock = 1;
const item = (id: string, patch: Partial<Item>): Item => ({ id, type: "article", title: id, addedAt: clock, updatedAt: clock++, path: `${id}.md`, ...patch });
const highlight = (id: string, doc: string, quote: string, note?: string): Annotation => ({
  id,
  doc,
  kind: "highlight",
  page: 0,
  color: "yellow",
  quote,
  note,
  createdAt: clock,
  updatedAt: clock++,
});

/** A folder's database as plain arrays, which tests can change between searches. */
function source(items: Item[], annotations: Annotation[] = [], pages: { doc: string; page: number; text: string }[] = []) {
  const db = { items, annotations, pages };
  const src: SearchSource = {
    items: { toArray: async () => db.items },
    annotations: { toArray: async () => db.annotations },
    pageText: { toArray: async () => db.pages },
  };
  return { db, search: new LibrarySearch(src) };
}

test("a title match outranks the same words in a highlight, a note and the text", async () => {
  const { search } = source(
    [
      item("body", { content: "Long text that mentions entropy once among many other words about other things." }),
      item("mine", { type: "note", body: "My thoughts on entropy." }),
      item("hl", { content: "Unrelated." }),
      item("title", { title: "Entropy" }),
    ],
    [highlight("h1", "hl", "Entropy always increases.")],
  );
  const hits = await search.search("entropy");
  assert.deepEqual(
    hits.map((h) => h.doc),
    ["title", "hl", "mine", "body"],
  );
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
  assert.equal(hits[1].kind, "annotation");
});

test("prefixes and small typos match; short words aren't fuzzed", async () => {
  const { search } = source([item("a", { title: "Thermodynamics primer" }), item("b", { title: "Cat facts" })]);
  assert.deepEqual((await search.search("thermo")).map((h) => h.doc), ["a"]);
  assert.deepEqual((await search.search("thermodinamics")).map((h) => h.doc), ["a"]);
  assert.deepEqual((await search.search("cot")).map((h) => h.doc), []);
});

test("results are ranked before they are cut", async () => {
  const many = Array.from({ length: 30 }, (_, i) => item(`filler${i}`, { content: `filler text about gardens number ${i}` }));
  const { search } = source([...many, item("best", { title: "Gardens" })]);
  const hits = await search.search("gardens", 5);
  assert.equal(hits.length, 5);
  assert.equal(hits[0].doc, "best");
});

test("filters by type and by topic", async () => {
  const { search } = source([
    item("a", { title: "Stoic letters", type: "pdf", topics: ["Philosophy"] }),
    item("b", { title: "Stoic habits", type: "note", topics: ["Health"] }),
    item("c", { title: "Stoic essays", type: "article", topics: ["philosophy"] }),
  ]);
  assert.deepEqual((await search.search("stoic", 10, { types: ["note"] })).map((h) => h.doc), ["b"]);
  assert.deepEqual((await search.search("stoic", 10, { topic: "Philosophy" })).map((h) => h.doc).sort(), ["a", "c"]);
  assert.deepEqual((await search.search("stoic", 10, { types: ["pdf"], topic: "Health" })).map((h) => h.doc), []);
});

test("edits, deletions and new PDF pages are picked up", async () => {
  const { db, search } = source([item("a", { title: "Old name" })], [], [{ doc: "a", page: 2, text: "a page about volcanoes" }]);
  assert.deepEqual((await search.search("volcanoes")).map((h) => [h.doc, h.page]), [["a", 2]]);
  db.items = [item("a", { title: "New name" })];
  assert.equal((await search.search("old name")).length, 0);
  assert.equal((await search.search("new name")).length, 1);
  db.annotations = [highlight("h", "a", "Glaciers move slowly")];
  assert.equal((await search.search("glaciers"))[0].kind, "annotation");
  db.annotations = [{ ...highlight("h", "a", "Glaciers move slowly"), deleted: true }];
  assert.equal((await search.search("glaciers")).length, 0);
  await search.addPage("a", 3, "notes on tectonics");
  assert.equal((await search.search("tectonics"))[0].page, 3);
  db.items = [{ ...item("a", { title: "New name" }), deleted: true }];
  assert.equal((await search.search("volcanoes")).length, 0);
});

test("notes on moments in a video are found", async () => {
  const moment: Annotation = { ...highlight("m", "v", ""), kind: "moment", quote: undefined, note: "the bit about photosynthesis", at: 42 };
  const { search } = source([item("v", { type: "video", title: "Plants" })], [moment]);
  const hits = await search.search("photosynthesis");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "annotation");
});
