import { test } from "node:test";
import assert from "node:assert/strict";
import { itemLocation } from "./model";

const link = { id: "a1", type: "article" as const };

test("a new item added by hand waits under Unread, not Inbox", () => {
  assert.equal(itemLocation({ ...link, location: "unread" }), "unread");
});

test("a hand-added item is archived once it is read, like an item saved before triage", () => {
  assert.equal(itemLocation({ ...link, location: "unread", readAt: 5 }), "archive");
  assert.equal(itemLocation({ ...link, location: "unread" }, true), "archive");
});

test("items saved before triage, agent entries and filed items keep their places", () => {
  assert.equal(itemLocation({ ...link }), "inbox");
  assert.equal(itemLocation({ ...link, readAt: 5 }), "archive");
  assert.equal(itemLocation({ ...link, location: "inbox" }), "inbox");
  assert.equal(itemLocation({ ...link, location: "later" }), "later");
});
