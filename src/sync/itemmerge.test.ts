import { test } from "node:test";
import assert from "node:assert/strict";
import type { Annotation, Item } from "../model";
import { CONFLICT_END, CONFLICT_SPLIT, CONFLICT_START, mergeAnnotations, mergeItem, mergeText } from "./itemmerge";

const path = "items/2026/10/2026-10-13-n1.md";
const base: Item = { id: "n1", type: "note", title: "2026-10-13", body: "Morning\n\nNoon\n\nEvening", topics: ["sleep"], addedAt: 1_000, updatedAt: 1_000, path };

test("two devices editing different fields both keep their change", () => {
  const local = { ...base, title: "Tuesday", edited: { title: 2_000 }, updatedAt: 2_000 };
  const remote = { ...base, topics: ["sleep", "focus"], edited: { topics: 3_000 }, updatedAt: 3_000 };
  const m = mergeItem(base, local, remote);
  assert.equal(m.title, "Tuesday");
  assert.deepEqual(m.topics, ["sleep", "focus"]);
  assert.deepEqual(m.edited, { title: 2_000, topics: 3_000 });
  assert.equal(m.updatedAt, 3_000);
});

test("edits to different lines of the same note merge without markers", () => {
  const local = { ...base, body: "Morning run\n\nNoon\n\nEvening", updatedAt: 2_000 };
  const remote = { ...base, body: "Morning\n\nNoon\n\nEvening read", updatedAt: 3_000 };
  assert.equal(mergeItem(base, local, remote).body, "Morning run\n\nNoon\n\nEvening read");
});

test("both devices appending to today's note keeps both additions", () => {
  const local = { ...base, body: `${base.body}\n- from the laptop`, updatedAt: 2_000 };
  const remote = { ...base, body: `${base.body}\n- from the phone`, updatedAt: 3_000 };
  assert.equal(mergeItem(base, local, remote).body, `${base.body}\n- from the laptop\n- from the phone`);
});

test("the same line changed two ways keeps both versions between conflict markers", () => {
  const local = { ...base, body: "Morning\n\nLunch with A\n\nEvening", updatedAt: 2_000 };
  const remote = { ...base, body: "Morning\n\nLunch with B\n\nEvening", updatedAt: 3_000 };
  const body = mergeItem(base, local, remote).body!;
  assert.equal(body, ["Morning", "", CONFLICT_START, "Lunch with A", CONFLICT_SPLIT, "Lunch with B", CONFLICT_END, "", "Evening"].join("\n"));
});

test("a change on one side only wins, however old its clock", () => {
  // The remote device's clock is behind, but this device didn't touch the body.
  const local = { ...base, title: "Renamed", updatedAt: 9_000 };
  const remote = { ...base, body: "Rewritten by hand", updatedAt: 500 };
  const m = mergeItem(base, local, remote);
  assert.equal(m.body, "Rewritten by hand");
  assert.equal(m.title, "Renamed");
});

test("a background update never beats your own edit of the same field", () => {
  // Remote: an article fill-in changed the title later, without an edit stamp.
  const remote = { ...base, title: "Fetched title", content: "Article", updatedAt: 5_000 };
  const local = { ...base, title: "My title", edited: { title: 2_000 }, updatedAt: 2_000 };
  const m = mergeItem(base, local, remote);
  assert.equal(m.title, "My title");
  assert.equal(m.content, "Article");
  // And the same the other way round.
  assert.equal(mergeItem(base, remote, local).title, "My title");
});

test("deleting on one device while editing on another keeps both: deleted, with the edit inside", () => {
  const local = { ...base, deleted: true, edited: { deleted: 2_000 }, updatedAt: 2_000 };
  const remote = { ...base, body: `${base.body}\nlate thought`, edited: { body: 3_000 }, updatedAt: 3_000 };
  const m = mergeItem(base, local, remote);
  assert.equal(m.deleted, true);
  assert.equal(m.body, `${base.body}\nlate thought`);
  const restored = mergeItem(m, { ...m, deleted: undefined }, m);
  assert.equal(restored.deleted, undefined);
});

test("topics merge as a set: additions and removals on both sides apply", () => {
  const b = { ...base, topics: ["a", "b", "c"] };
  const m = mergeItem(b, { ...b, topics: ["a", "c", "d"] }, { ...b, topics: ["a", "b", "e"] });
  assert.deepEqual(m.topics, ["a", "d", "e"]);
});

test("the merge is the same whichever device runs it", () => {
  const local = { ...base, title: "L", body: "Morning\n\nNoon!\n\nEvening", edited: { title: 4_000 }, updatedAt: 4_000 };
  const remote = { ...base, title: "R", topics: [], edited: { title: 3_000 }, updatedAt: 3_000 };
  const a = mergeItem(base, local, remote);
  const b = mergeItem(base, remote, local);
  assert.equal(a.title, "L");
  assert.equal(b.title, "L");
  assert.equal(a.body, b.body);
  assert.equal(a.topics?.length ?? 0, 0);
  assert.equal(b.topics?.length ?? 0, 0);
});

test("without a base, text one side fully contains wins and different text is kept twice", () => {
  assert.equal(mergeText(undefined, "a", "a\nb"), "a\nb");
  assert.equal(mergeText(undefined, "a\nb", undefined), "a\nb");
  assert.equal(mergeText(undefined, "x", "y"), [CONFLICT_START, "x", CONFLICT_SPLIT, "y", CONFLICT_END].join("\n"));
});

test("clearing a note on one side clears it", () => {
  assert.equal(mergeText("old", undefined, "old"), undefined);
  assert.equal(mergeItem(base, { ...base, body: undefined }, base).body, undefined);
});

const hl: Annotation = { id: "h1", doc: "n1", kind: "highlight", page: 3, color: "yellow", quote: "q", note: "first\n\nsecond", createdAt: 1, updatedAt: 1 };

test("annotation notes merge line by line, and other fields by side", () => {
  const local = { ...hl, note: "first!\n\nsecond", updatedAt: 2 };
  const remote = { ...hl, color: "green", note: "first\n\nsecond!", updatedAt: 3 };
  const r = mergeAnnotations([hl], [local], [remote]);
  assert.equal(r.put.length, 1);
  assert.equal(r.put[0].note, "first!\n\nsecond!");
  assert.equal(r.put[0].color, "green");
  assert.equal(r.localAhead, true);
});

test("an annotation deleted on one side and edited on the other stays deleted with the edit", () => {
  const r = mergeAnnotations([hl], [{ ...hl, deleted: true, updatedAt: 2 }], [{ ...hl, note: "edited", updatedAt: 3 }]);
  assert.equal(r.put[0].deleted, true);
  assert.equal(r.put[0].note, "edited");
});

test("annotations only one side has are kept", () => {
  const other = { ...hl, id: "h2" };
  const r = mergeAnnotations([], [hl], [other]);
  assert.deepEqual(r.put, [other]);
  assert.equal(r.localAhead, true);
});
