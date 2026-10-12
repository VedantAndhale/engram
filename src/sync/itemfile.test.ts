import { test } from "node:test";
import assert from "node:assert/strict";
import type { Annotation, Item } from "../model";
import { parseItem, serializeItem } from "./itemfile";

const path = "items/2026/10/sleep-course-p1.md";

const playlist: Item = { id: "p1", type: "playlist", title: "Sleep course", addedAt: 1_000, updatedAt: 2_000, path };

const moment: Annotation = {
  id: "m1",
  doc: "v1",
  kind: "moment",
  page: 0,
  color: "",
  at: 90,
  note: "the point, with a picture ![shot](data:image/jpeg;base64,QUJD) and a --> arrow next line",
  author: "vedant",
  createdAt: 3_000,
  updatedAt: 4_000,
};

const entry: Annotation = { id: "e1", doc: "p1", kind: "entry", page: 0, color: "", ref: "v1", order: 1, createdAt: 1_000, updatedAt: 1_000 };
const removed: Annotation = { ...entry, id: "e2", ref: "v2", order: 2, updatedAt: 5_000, deleted: true };

const byId = (a: Annotation, b: Annotation) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

test("a playlist keeps its entries, in order and with their removals, through the item file", () => {
  const text = serializeItem(playlist, [entry, removed]);
  const back = parseItem(text, path);
  assert.ok(back, "the file parses as an item");
  assert.equal(back.item.type, "playlist");
  assert.equal(back.item.title, "Sleep course");
  assert.deepEqual([...back.annotations].sort(byId), [entry, { ...removed, doc: "p1" }].sort(byId));
});

test("a timed note keeps its time and its text, picture and all", () => {
  const text = serializeItem({ ...playlist, id: "v1", type: "video", title: "A video" }, [moment]);
  const back = parseItem(text, path);
  assert.ok(back);
  assert.equal(back.item.type, "video");
  assert.deepEqual(back.annotations, [{ ...moment, doc: "v1" }]);
});

test("a file with no annotations has no annotation lines", () => {
  const text = serializeItem(playlist, []);
  assert.doesNotMatch(text, /engram:annotation/);
  assert.deepEqual(parseItem(text, path)?.annotations, []);
});
