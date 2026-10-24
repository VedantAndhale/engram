import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "../model";
import { parseItem, serializeItem } from "./itemfile";

const path = "items/2026/10/a-link-a1.md";
const item = { id: "a1", type: "article", title: "A link", addedAt: 1_000, updatedAt: 2_000, path, location: "unread" } as Item;

test("an item waiting under Unread keeps that place when it is saved and read back", () => {
  const text = serializeItem(item, []);
  assert.match(text, /^location: "unread"$/m);
  assert.equal(parseItem(text, path)?.item.location, "unread");
});
