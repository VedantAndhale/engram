import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FEEDS, checkFeedsText, planFollow } from "./config";

const existing = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `feed${i}`, url: `https://site${i}.example/feed`, title: `Site ${i}`, addedAt: i }));

test("following keeps every entry already in the file exactly as it was", () => {
  const text = JSON.stringify({
    version: 1,
    note: "kept by hand",
    feeds: [{ id: "blog1", url: "https://blog.example/rss", title: "Blog", addedAt: 5, extra: { keep: true } }],
  });
  const plan = planFollow(text, ["https://news.example/feed"]);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.changed, true);
  assert.equal(plan.added, 1);
  const written = JSON.parse(plan.text);
  assert.equal(written.note, "kept by hand");
  assert.deepEqual(written.feeds[0], { id: "blog1", url: "https://blog.example/rss", title: "Blog", addedAt: 5, extra: { keep: true } });
  assert.equal(written.feeds[1].url, "https://news.example/feed");
  assert.deepEqual(plan.done, ["https://news.example/feed"]);
});

test("a file that is not valid JSON is refused, not overwritten", () => {
  const plan = planFollow('{ "feeds": [ { "url": "https://a.example/rss" }, ]', ["https://b.example/feed"]);
  assert.equal(plan.ok, false);
});

test("a file with no feeds list is refused", () => {
  assert.equal(planFollow('{ "version": 1 }', ["https://b.example/feed"]).ok, false);
  assert.match(checkFeedsText('{ "feeds": "nope" }') ?? "", /no feeds list/);
});

test("a file with more feeds than the limit is refused rather than truncated", () => {
  const text = JSON.stringify({ version: 1, feeds: existing(MAX_FEEDS + 1) });
  assert.equal(planFollow(text, ["https://b.example/feed"]).ok, false);
});

test("an empty or missing file starts a new list", () => {
  const plan = planFollow(null, ["https://b.example/feed"]);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(JSON.parse(plan.text).feeds.length, 1);
});

test("a feed already followed is reported as done, and nothing is written", () => {
  const text = JSON.stringify({ version: 1, feeds: [{ id: "a", url: "https://a.example/rss", title: "A", addedAt: 1 }] });
  const plan = planFollow(text, ["https://A.example/rss#top"]);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.done, ["https://A.example/rss#top"]);
  assert.equal(plan.added, 0);
});

test("when the list is full, the extra feeds are refused and say why", () => {
  const text = JSON.stringify({ version: 1, feeds: existing(MAX_FEEDS) });
  const plan = planFollow(text, ["https://b.example/feed"]);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.added, 0);
  assert.equal(plan.refused, 1);
  assert.deepEqual(plan.done, []);
  assert.match(plan.reason ?? "", new RegExp(`up to ${MAX_FEEDS} feeds`));
});

test("in a batch that only partly fits, the feeds that fit are added and the rest are reported", () => {
  const text = JSON.stringify({ version: 1, feeds: existing(MAX_FEEDS - 1) });
  const plan = planFollow(text, ["https://b.example/feed", "https://c.example/feed"]);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.added, 1);
  assert.equal(plan.refused, 1);
  assert.deepEqual(plan.done, ["https://b.example/feed"]);
  assert.equal(JSON.parse(plan.text).feeds.length, MAX_FEEDS);
});

test("an address that is not web http or https is refused with a reason", () => {
  const plan = planFollow(null, ["javascript:alert(1)"]);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.added, 0);
  assert.equal(plan.refused, 1);
  assert.match(plan.reason ?? "", /http/);
});
