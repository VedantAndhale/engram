import { test } from "node:test";
import assert from "node:assert/strict";
import { type AgingItem, agedFromInbox, INBOX_DAYS } from "./aging";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25);
const SINCE = NOW - 30 * DAY;

/** An item added `daysAgo` days back and in Inbox since then, unless `over` says otherwise. */
const item = (id: string, daysAgo: number, over: Partial<AgingItem> = {}): AgingItem => {
  const addedAt = NOW - daysAgo * DAY;
  return { id, type: "article", location: "inbox", addedAt, enteredInbox: addedAt, ...over };
};

test("a link waits in Inbox for seven days, then is due", () => {
  assert.equal(INBOX_DAYS, 7);
  assert.deepEqual(agedFromInbox([item("a", 6.9)], NOW, SINCE), []);
  assert.deepEqual(agedFromInbox([item("b", 7)], NOW, SINCE), ["b"]);
  assert.deepEqual(agedFromInbox([item("c", 20)], NOW, SINCE), ["c"]);
});

test("moving a link back to Inbox restarts its week", () => {
  // Added 10 days ago, but moved back to Inbox yesterday: it waits a fresh week.
  assert.deepEqual(agedFromInbox([item("back", 10, { enteredInbox: NOW - DAY })], NOW, SINCE), []);
});

test("every kind of link is aged, and nothing else is", () => {
  const links: AgingItem[] = (["article", "post", "tweet", "thread", "bookmark"] as const).map((type, i) => item(`l${i}`, 10, { type }));
  assert.equal(agedFromInbox(links, NOW, SINCE).length, 5);
  const others: AgingItem[] = (["note", "quote", "pdf", "book", "video", "playlist"] as const).map((type, i) => item(`o${i}`, 10, { type }));
  assert.deepEqual(agedFromInbox(others, NOW, SINCE), []);
});

test("only items still in Inbox are moved", () => {
  assert.deepEqual(agedFromInbox([item("later", 10, { location: "later" }), item("archive", 10, { location: "archive" })], NOW, SINCE), []);
});

test("deleted items are left alone", () => {
  assert.deepEqual(agedFromInbox([item("gone", 10, { deleted: true })], NOW, SINCE), []);
});

test("links added before the rule started are left where they are", () => {
  assert.deepEqual(agedFromInbox([item("old", 40)], NOW, SINCE), []);
});

test("an item with no location is not moved by this rule", () => {
  assert.deepEqual(agedFromInbox([item("legacy", 10, { location: undefined })], NOW, SINCE), []);
});
