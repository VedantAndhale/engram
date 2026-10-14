import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FEEDS,
  addFeed,
  feedsToJson,
  normalizeFeedUrl,
  parseFeedsJson,
  removeFeed,
  type FeedsFile,
} from "./config";

// Unwraps a successful result so a failing add shows its message in the test output.
function must(r: FeedsFile | { error: string }): FeedsFile {
  if ("error" in r) throw new Error(r.error);
  return r;
}

test("parseFeedsJson gives an empty list for missing or damaged input", () => {
  const empty = { version: 1, feeds: [] };
  assert.deepEqual(parseFeedsJson(null), empty);
  assert.deepEqual(parseFeedsJson(""), empty);
  assert.deepEqual(parseFeedsJson("{not json"), empty);
  assert.deepEqual(parseFeedsJson("42"), empty);
  assert.deepEqual(parseFeedsJson('{"version":1,"feeds":"nope"}'), empty);
});

test("normalizeFeedUrl lowercases scheme and host and drops the hash", () => {
  assert.equal(normalizeFeedUrl("HTTPS://Example.COM/Feed.xml#top"), "https://example.com/Feed.xml");
  assert.equal(normalizeFeedUrl("  http://example.com/rss  "), "http://example.com/rss");
});

test("only http and https addresses are accepted", () => {
  const f = parseFeedsJson(null);
  for (const bad of [
    "ftp://example.com/feed",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "example.com/feed",
    "not a url",
    "",
  ]) {
    const r = addFeed(f, bad);
    assert.ok("error" in r, `expected an error for ${JSON.stringify(bad)}`);
  }
  assert.ok(!("error" in addFeed(f, "http://example.com/feed")));
  assert.ok(!("error" in addFeed(f, "https://example.com/feed")));
});

test("addFeed fills in an 8 hex id, a hostname title and a timestamp", () => {
  const before = Date.now();
  const f = must(addFeed(parseFeedsJson(null), "https://Blog.Example.com/rss"));
  assert.equal(f.version, 1);
  assert.equal(f.feeds.length, 1);
  const feed = f.feeds[0]!;
  assert.match(feed.id, /^[0-9a-f]{8}$/);
  assert.equal(feed.url, "https://blog.example.com/rss");
  assert.equal(feed.title, "blog.example.com");
  assert.ok(feed.addedAt >= before && feed.addedAt <= Date.now());
});

test("addFeed keeps a given title and falls back to the hostname when it is blank", () => {
  const a = must(addFeed(parseFeedsJson(null), "https://example.com/a", "  My   feed "));
  assert.equal(a.feeds[0]!.title, "My feed");
  const b = must(addFeed(parseFeedsJson(null), "https://example.com/b", "   "));
  assert.equal(b.feeds[0]!.title, "example.com");
  const long = must(addFeed(parseFeedsJson(null), "https://example.com/c", "x".repeat(500)));
  assert.equal(long.feeds[0]!.title.length, 120);
});

test("addFeed does not change the file it was given", () => {
  const start = parseFeedsJson(null);
  must(addFeed(start, "https://example.com/feed"));
  assert.equal(start.feeds.length, 0);
});

test("duplicates are rejected on the normalised address", () => {
  const f = must(addFeed(parseFeedsJson(null), "https://example.com/feed"));
  for (const dup of [
    "https://example.com/feed",
    "HTTPS://EXAMPLE.COM/feed",
    "https://example.com/feed#latest",
  ]) {
    const r = addFeed(f, dup);
    assert.ok("error" in r, `expected a duplicate error for ${dup}`);
  }
  // A different path is a different feed.
  assert.ok(!("error" in addFeed(f, "https://example.com/other")));
});

test("no more than 50 feeds can be added", () => {
  let f = parseFeedsJson(null);
  for (let i = 0; i < MAX_FEEDS; i++) {
    f = must(addFeed(f, `https://example.com/feed${i}`));
  }
  assert.equal(f.feeds.length, 50);
  assert.equal(new Set(f.feeds.map((x) => x.id)).size, 50);
  const r = addFeed(f, "https://example.com/one-too-many");
  assert.ok("error" in r);
  assert.equal(f.feeds.length, 50);
});

test("removeFeed drops one feed by id and ignores unknown ids", () => {
  let f = must(addFeed(parseFeedsJson(null), "https://example.com/a"));
  f = must(addFeed(f, "https://example.com/b"));
  const [a, b] = f.feeds;
  const after = removeFeed(f, a!.id);
  assert.deepEqual(after.feeds, [b]);
  assert.deepEqual(removeFeed(f, "00000000").feeds, f.feeds);
});

test("a feed list survives a write and read round trip", () => {
  let f = must(addFeed(parseFeedsJson(null), "https://example.com/a", "Alpha"));
  f = must(addFeed(f, "http://news.example.org/atom.xml"));
  const text = feedsToJson(f);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(parseFeedsJson(text), f);
  // Plain JSON.stringify output reads back the same way.
  assert.deepEqual(parseFeedsJson(JSON.stringify(f)), f);
});

test("parseFeedsJson skips bad entries and duplicates but keeps the good ones", () => {
  const text = JSON.stringify({
    version: 1,
    feeds: [
      { id: "aaaaaaaa", url: "https://example.com/a", title: "A", addedAt: 1 },
      { id: "bbbbbbbb", url: "ftp://example.com/b", title: "B", addedAt: 2 },
      { id: "cc", url: "https://example.com/c", title: "C", addedAt: 3 },
      { id: "dddddddd", url: "https://EXAMPLE.com/a#x", title: "dup of A", addedAt: 4 },
      { id: "aaaaaaaa", url: "https://example.com/e", title: "same id", addedAt: 5 },
      null,
      "text",
      { id: "ffffffff", url: "https://example.com/f" },
    ],
  });
  const f = parseFeedsJson(text);
  assert.deepEqual(
    f.feeds.map((x) => x.id),
    ["aaaaaaaa", "ffffffff"],
  );
  assert.equal(f.feeds[1]!.title, "example.com");
  assert.equal(f.feeds[1]!.addedAt, 0);
});

test("parseFeedsJson keeps at most 50 feeds", () => {
  const feeds = Array.from({ length: 60 }, (_, i) => ({
    id: i.toString(16).padStart(8, "0"),
    url: `https://example.com/feed${i}`,
    title: `Feed ${i}`,
    addedAt: i,
  }));
  const f = parseFeedsJson(JSON.stringify({ version: 1, feeds }));
  assert.equal(f.feeds.length, 50);
  assert.equal(f.feeds[0]!.title, "Feed 0");
});