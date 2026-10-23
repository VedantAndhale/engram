import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "../model";
import { mergeItem } from "./itemmerge";

// The inbox sweep moves links to Later without an edit stamp, as fillItem writes background changes. Merging must
// keep a move made by hand, even one made earlier on another device.
const DAY = 24 * 60 * 60 * 1000;
const path = "items/2026/10/a-a1.md";
const base: Item = { id: "a1", type: "article", title: "A link", addedAt: 1_000, updatedAt: 2_000, path, location: "inbox" };
const now = 100 * DAY;

test("an unstamped sweep to Later does not beat an archive made by hand on another device", () => {
  const sweptHere: Item = { ...base, location: "later", updatedAt: now };
  const archivedElsewhere: Item = { ...base, location: "archive", updatedAt: now - 3 * DAY, edited: { location: now - 3 * DAY } };
  assert.equal(mergeItem(base, sweptHere, archivedElsewhere).location, "archive");
});

test("a move by hand on this device still wins over an unstamped change", () => {
  const archivedHere: Item = { ...base, location: "archive", updatedAt: now, edited: { location: now } };
  const sweptElsewhere: Item = { ...base, location: "later", updatedAt: now - DAY };
  assert.equal(mergeItem(base, archivedHere, sweptElsewhere).location, "archive");
});
