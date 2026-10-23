import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FEEDS, parseFeedsJson } from "./config";
import { planAddFeed, planRemoveFeed, type RawPlan } from "./raw";

const feeds = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `feed${i}`, url: `https://site${i}.example/feed`, title: `Site ${i}`, addedAt: i }));

// Unwraps a successful plan so a refused one shows its message in the test output.
function written(plan: RawPlan): string {
  if (!plan.ok) throw new Error(plan.error);
  return plan.text;
}

test("adding a feed keeps every entry already there exactly", () => {
  const text = JSON.stringify({
    version: 1,
    note: "kept by hand",
    feeds: [{ id: "blog1", url: "https://blog.example/rss", title: "Blog", addedAt: 5, extra: { keep: true } }],
  });
  const plan = planAddFeed(text, "https://news.example/feed", "News");
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const out = JSON.parse(plan.text);
  assert.equal(out.note, "kept by hand");
  assert.deepEqual(out.feeds[0], { id: "blog1", url: "https://blog.example/rss", title: "Blog", addedAt: 5, extra: { keep: true } });
  assert.equal(out.feeds[1].url, "https://news.example/feed");
  assert.equal(out.feeds[1].title, "News");
});

test("adding a feed that is already followed is refused", () => {
  const text = JSON.stringify({ version: 1, feeds: [{ id: "a", url: "https://a.example/rss", title: "A", addedAt: 1 }] });
  const plan = planAddFeed(text, "https://A.example/rss#top");
  assert.deepEqual(plan, { ok: false, error: "You already follow this feed." });
});

test("adding to a full list is refused", () => {
  const full = JSON.stringify({ version: 1, feeds: feeds(MAX_FEEDS) });
  assert.equal(planAddFeed(full, "https://b.example/feed").ok, false);
});

test("a broken file is refused by both add and remove", () => {
  assert.equal(planAddFeed('{ "feeds": [ ], }', "https://b.example/feed").ok, false);
  assert.equal(planRemoveFeed('{ "version": 1 }', "feed0").ok, false);
});

test("removing a feed keeps every other entry exactly", () => {
  const text = JSON.stringify({
    version: 1,
    feeds: [{ id: "blog1", url: "https://blog.example/rss", title: "Blog", addedAt: 5, extra: 1 }, { id: "gone", url: "https://x.example/rss", title: "X", addedAt: 6 }],
  });
  const plan = planRemoveFeed(text, "gone");
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.changed, true);
  assert.deepEqual(JSON.parse(plan.text).feeds, [{ id: "blog1", url: "https://blog.example/rss", title: "Blog", addedAt: 5, extra: 1 }]);
});

test("removing an id that is not in the file changes nothing", () => {
  const text = JSON.stringify({ version: 1, feeds: feeds(2) });
  const plan = planRemoveFeed(text, "nope");
  assert.deepEqual(plan, { ok: true, changed: false, text });
  assert.deepEqual(planRemoveFeed(null, "nope"), { ok: true, changed: false, text: "" });
});

test("only http and https addresses are accepted", () => {
  for (const bad of ["ftp://example.com/feed", "javascript:alert(1)", "file:///etc/passwd", "example.com/feed", "not a url", ""]) {
    assert.equal(planAddFeed(null, bad).ok, false, `expected a refusal for ${JSON.stringify(bad)}`);
  }
  assert.equal(planAddFeed(null, "http://example.com/feed").ok, true);
  assert.equal(planAddFeed(null, "https://example.com/feed").ok, true);
});

test("a new feed gets an 8 hex id, a hostname title and a timestamp", () => {
  const before = Date.now();
  const feed = JSON.parse(written(planAddFeed(null, "https://Blog.Example.com/rss"))).feeds[0];
  assert.match(feed.id, /^[0-9a-f]{8}$/);
  assert.equal(feed.url, "https://blog.example.com/rss");
  assert.equal(feed.title, "blog.example.com");
  assert.ok(feed.addedAt >= before && feed.addedAt <= Date.now());
});

test("a given title is tidied and capped at 120 characters, and a blank one falls back to the host", () => {
  const titleOf = (t: string | undefined) => JSON.parse(written(planAddFeed(null, "https://example.com/a", t))).feeds[0].title;
  assert.equal(titleOf("  My   feed "), "My feed");
  assert.equal(titleOf("   "), "example.com");
  assert.equal(titleOf(undefined), "example.com");
  assert.equal(titleOf("x".repeat(500)).length, 120);
});

test("duplicates are refused on the normalised address", () => {
  const text = written(planAddFeed(null, "https://example.com/feed"));
  for (const dup of ["https://example.com/feed", "HTTPS://EXAMPLE.COM/feed", "https://example.com/feed#latest"]) {
    assert.equal(planAddFeed(text, dup).ok, false, `expected a duplicate refusal for ${dup}`);
  }
  // A different path is a different feed.
  assert.equal(planAddFeed(text, "https://example.com/other").ok, true);
});

test("no more than MAX_FEEDS feeds can be added, each with its own id", () => {
  let text: string | null = null;
  for (let i = 0; i < MAX_FEEDS; i++) text = written(planAddFeed(text, `https://example.com/feed${i}`));
  const list = JSON.parse(text!).feeds;
  assert.equal(list.length, MAX_FEEDS);
  assert.equal(new Set(list.map((x: { id: string }) => x.id)).size, MAX_FEEDS);
  assert.equal(planAddFeed(text, "https://example.com/one-too-many").ok, false);
});

test("a written list reads back as the same feeds", () => {
  let text = written(planAddFeed(null, "https://example.com/a", "Alpha"));
  text = written(planAddFeed(text, "http://news.example.org/atom.xml"));
  assert.ok(text.endsWith("\n"));
  const f = parseFeedsJson(text);
  assert.deepEqual(
    f.feeds.map((x) => x.url),
    ["https://example.com/a", "http://news.example.org/atom.xml"],
  );
  assert.equal(f.feeds[0]!.title, "Alpha");
  // Plain JSON.stringify output reads back the same way.
  assert.deepEqual(parseFeedsJson(JSON.stringify(JSON.parse(text))), f);
});
