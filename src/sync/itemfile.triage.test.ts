import { test } from "node:test";
import assert from "node:assert/strict";
import { itemLocation, type Item } from "../model";
import { parseItem, serializeItem } from "./itemfile";
import { mergeItem } from "./itemmerge";

const path = "items/2026/10/an-essay-a1.md";
const essay: Item = { id: "a1", type: "article", title: "An essay", addedAt: 1_000, updatedAt: 2_000, path };

test("location, read time, favourite and purge go through the item file", () => {
  const item: Item = { ...essay, location: "later", readAt: 1_760_000_000_123, favorite: true, deleted: true, purged: true };
  const text = serializeItem(item, []);
  assert.match(text, /^location: "later"$/m);
  assert.match(text, /^read_at: "2025-10-09T08:53:20\.123Z"$/m);
  assert.match(text, /^favorite: true$/m);
  assert.match(text, /^purged: true$/m);
  assert.deepEqual(parseItem(text, path)?.item, item);
});

test("an untriaged item writes none of the triage fields", () => {
  const text = serializeItem(essay, []);
  assert.doesNotMatch(text, /^(location|read_at|favorite|purged):/m);
  assert.deepEqual(parseItem(text, path)?.item, essay);
});

test("a location typed by hand that isn't one of the three is ignored", () => {
  const text = serializeItem(essay, []).replace(/^---\n/, '---\nlocation: "somewhere"\n');
  assert.equal(parseItem(text, path)?.item.location, undefined);
});

test("archiving on one device and starring on another both stick", () => {
  const base: Item = { ...essay, location: "inbox" };
  const local: Item = { ...base, location: "archive", edited: { location: 3_000 }, updatedAt: 3_000 };
  const remote: Item = { ...base, favorite: true, edited: { favorite: 4_000 }, updatedAt: 4_000 };
  const m = mergeItem(base, local, remote);
  assert.equal(m.location, "archive");
  assert.equal(m.favorite, true);
});

test("the later move wins when two devices move the same item", () => {
  const base: Item = { ...essay, location: "inbox" };
  const local: Item = { ...base, location: "archive", edited: { location: 5_000 }, updatedAt: 5_000 };
  const remote: Item = { ...base, location: "later", edited: { location: 4_000 }, updatedAt: 6_000 };
  assert.equal(mergeItem(base, local, remote).location, "archive");
});

test("older items with no location: unread is Inbox, read is Archive, daily notes are neither", () => {
  assert.equal(itemLocation(essay), "inbox");
  assert.equal(itemLocation({ ...essay, readAt: 5 }), "archive");
  assert.equal(itemLocation(essay, true), "archive");
  assert.equal(itemLocation({ ...essay, location: "later", readAt: 5 }), "later");
  assert.equal(itemLocation({ ...essay, id: "daily-2026-10-13", type: "note" }), null);
});
