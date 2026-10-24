import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FEEDS, followedUrls, normalizeFeedUrl, parseFeedsJson } from "./config";

test("followedUrls reads every usable address, normalised, and ignores the rest", () => {
  const text = JSON.stringify({
    version: 1,
    feeds: [
      { id: "aaaaaaaa", url: "HTTPS://Blog.example/rss#top", title: "A", addedAt: 1 },
      { id: "cc", url: "https://news.example/feed", title: "C", addedAt: 2 },
      { id: "bad id!", url: "ftp://nope.example/feed", title: "B", addedAt: 3 },
      "text",
      null,
    ],
  });
  assert.deepEqual([...followedUrls(text)].sort(), ["https://blog.example/rss", "https://news.example/feed"]);
});

test("followedUrls is empty for a missing, empty or broken file", () => {
  assert.equal(followedUrls(null).size, 0);
  assert.equal(followedUrls("").size, 0);
  assert.equal(followedUrls("{not json").size, 0);
  assert.equal(followedUrls('{"version":1,"feeds":"nope"}').size, 0);
});

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

test("normalizeFeedUrl refuses anything that is not http or https", () => {
  for (const bad of ["ftp://example.com/feed", "javascript:alert(1)", "file:///etc/passwd", "example.com/feed", "not a url", ""]) {
    assert.equal(normalizeFeedUrl(bad), null, `expected no address for ${JSON.stringify(bad)}`);
  }
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
    ["aaaaaaaa", "cc", "ffffffff"],
  );
  assert.equal(f.feeds[1]!.title, "C");
  assert.equal(f.feeds[1]!.addedAt, 3);
});

test("parseFeedsJson keeps at most MAX_FEEDS feeds", () => {
  const feeds = Array.from({ length: MAX_FEEDS + 10 }, (_, i) => ({
    id: i.toString(16).padStart(8, "0"),
    url: `https://example.com/feed${i}`,
    title: `Feed ${i}`,
    addedAt: i,
  }));
  const f = parseFeedsJson(JSON.stringify({ version: 1, feeds }));
  assert.equal(f.feeds.length, MAX_FEEDS);
  assert.equal(f.feeds[0]!.title, "Feed 0");
});
