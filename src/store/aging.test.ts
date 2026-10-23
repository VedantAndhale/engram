import { test } from "node:test";
import assert from "node:assert/strict";
import { type AgingItem, INBOX_DAYS, isAgedOutOfInbox } from "./aging";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25);
const SINCE = NOW - 30 * DAY;

/** An item added `daysAgo` days back and in Inbox since then, unless `over` says otherwise. */
const item = (id: string, daysAgo: number, over: Partial<AgingItem> = {}): AgingItem => {
  const addedAt = NOW - daysAgo * DAY;
  return { id, type: "article", location: "inbox", addedAt, enteredInbox: addedAt, ...over };
};

test("a link leaves Inbox after seven days, not before", () => {
  assert.equal(INBOX_DAYS, 7);
  assert.equal(isAgedOutOfInbox(item("a", 6.9), NOW, SINCE), false);
  assert.equal(isAgedOutOfInbox(item("b", 7), NOW, SINCE), true);
  assert.equal(isAgedOutOfInbox(item("c", 20), NOW, SINCE), true);
});

test("moving a link back to Inbox restarts its week", () => {
  // Added 10 days ago, but moved back to Inbox yesterday: it waits a fresh week.
  assert.equal(isAgedOutOfInbox(item("back", 10, { enteredInbox: NOW - DAY }), NOW, SINCE), false);
});

test("every kind of link is aged, and nothing else is", () => {
  for (const type of ["article", "post", "tweet", "thread", "bookmark"] as const) {
    assert.equal(isAgedOutOfInbox(item(type, 10, { type }), NOW, SINCE), true, type);
  }
  for (const type of ["note", "quote", "pdf", "book", "video", "playlist"] as const) {
    assert.equal(isAgedOutOfInbox(item(type, 10, { type }), NOW, SINCE), false, type);
  }
});

test("only items in Inbox are aged", () => {
  assert.equal(isAgedOutOfInbox(item("later", 10, { location: "later" }), NOW, SINCE), false);
  assert.equal(isAgedOutOfInbox(item("archive", 10, { location: "archive" }), NOW, SINCE), false);
});

test("deleted items are left alone", () => {
  assert.equal(isAgedOutOfInbox(item("gone", 10, { deleted: true }), NOW, SINCE), false);
});

test("links added before the rule started keep their place in Inbox", () => {
  assert.equal(isAgedOutOfInbox(item("old", 40), NOW, SINCE), false);
});

test("an item with no location is not aged by this rule", () => {
  assert.equal(isAgedOutOfInbox(item("legacy", 10, { location: undefined }), NOW, SINCE), false);
});
