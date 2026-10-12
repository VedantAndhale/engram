import { test } from "node:test";
import assert from "node:assert/strict";
import type { Annotation, Item } from "../model";
import { parseItem, serializeItem } from "./itemfile";

// The Unicode line separator, built from its code point so it is written the same way every time.
const LS = String.fromCharCode(0x2028);
const ESCAPED_LS = String.fromCharCode(92) + "u2028";
const path = "items/2026/10/line-abc.md";

test("a title with a line separator reads back whole", () => {
  const item: Item = { id: "i1", type: "note", title: "Line" + LS + "one", body: "words", addedAt: 1_000, updatedAt: 2_000, path };
  const back = parseItem(serializeItem(item, []), path);
  assert.ok(back);
  assert.equal(back.item.title, "Line" + LS + "one");
  assert.equal(back.item.body, "words");
});

test("an annotation written with a raw separator by an older build still reads", () => {
  const item: Item = { id: "i1", type: "note", title: "T", addedAt: 1_000, updatedAt: 2_000, path };
  const ann: Annotation = { id: "a1", doc: "i1", kind: "highlight", page: 0, color: "#f7d154", quote: "q", note: "a" + LS + "b", createdAt: 1, updatedAt: 2 };
  // The current build writes the escape; an older one wrote the character itself. Simulate the older file.
  const older = serializeItem(item, [ann]).split(ESCAPED_LS).join(LS);
  assert.ok(older.includes(LS), "the older file holds the raw separator");
  const back = parseItem(older, path);
  assert.ok(back);
  assert.equal(back.annotations.length, 1);
  assert.equal(back.annotations[0].note, "a" + LS + "b");
});
