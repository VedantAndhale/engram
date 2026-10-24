import { test } from "node:test";
import assert from "node:assert/strict";
import { feedStatus, statusRank } from "./status";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");

test("a feed the Action has never recorded is new", () => {
  assert.deepEqual(feedStatus(undefined, NOW), { kind: "new" });
});

test("a feed a run ran out of time before reaching is waiting, not failing", () => {
  const run = { retryAfter: null, lastError: { message: "deadline", since: "2026-10-24T11:00:00.000Z" } };
  assert.deepEqual(feedStatus(run, NOW), { kind: "waiting" });
});

test("a feed the site asked us to wait on is paused until that time", () => {
  const until = "2026-10-25T00:00:00.000Z";
  const run = { retryAfter: until, lastError: { message: "HTTP 429", since: "2026-10-24T11:00:00.000Z" } };
  assert.deepEqual(feedStatus(run, NOW), { kind: "paused", until });
});

test("once the wait is over, a feed that failed is due for another try, not failing", () => {
  const run = { retryAfter: "2026-10-24T09:00:00.000Z", lastError: { message: "HTTP 503", since: "2026-10-24T08:00:00.000Z" } };
  assert.deepEqual(feedStatus(run, NOW), { kind: "due" });
});

test("a failing feed carries its message and the time it began failing", () => {
  const run = { retryAfter: null, lastError: { message: "parse error: no items", since: "2026-10-20T06:00:00.000Z" } };
  assert.deepEqual(feedStatus(run, NOW), { kind: "failing", message: "parse error: no items", since: "2026-10-20T06:00:00.000Z" });
});

test("a failing feed with no start time still shows as failing", () => {
  const run = { lastError: { message: "timeout", since: "" } };
  assert.deepEqual(feedStatus(run, NOW), { kind: "failing", message: "timeout", since: null });
});

test("a recorded feed with no error is working", () => {
  assert.deepEqual(feedStatus({ retryAfter: null, lastError: null }, NOW), { kind: "working" });
  assert.deepEqual(feedStatus({}, NOW), { kind: "working" });
});

test("an unreadable retry time is ignored", () => {
  assert.deepEqual(feedStatus({ retryAfter: "soon", lastError: null }, NOW), { kind: "working" });
});

test("problems sort before healthy feeds", () => {
  const ranks = [
    feedStatus({ lastError: { message: "x" } }, NOW),
    feedStatus({ retryAfter: "2026-10-25T00:00:00.000Z" }, NOW),
    feedStatus({ retryAfter: "2026-10-24T09:00:00.000Z", lastError: { message: "x" } }, NOW),
    feedStatus({ lastError: { message: "deadline" } }, NOW),
    feedStatus(undefined, NOW),
    feedStatus({}, NOW),
  ].map(statusRank);
  assert.deepEqual(ranks, [0, 1, 2, 3, 4, 5]);
});
