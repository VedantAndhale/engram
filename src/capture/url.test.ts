import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanUrl, typeForUrl } from "./url";

test("cleanUrl drops the fragment and tracking parameters, keeps the rest", () => {
  assert.equal(cleanUrl("https://example.com/a?id=7&utm_source=x&fbclid=y#top"), "https://example.com/a?id=7");
});

test("cleanUrl makes one YouTube video one address", () => {
  const want = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  assert.equal(cleanUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"), want);
  assert.equal(cleanUrl("https://youtu.be/dQw4w9WgXcQ?si=abc"), want);
});

test("cleanUrl returns text it cannot parse unchanged", () => {
  assert.equal(cleanUrl("not a url"), "not a url");
});

test("typeForUrl recognises tweets, videos and posts", () => {
  assert.equal(typeForUrl("https://x.com/someone/status/1234"), "tweet");
  assert.equal(typeForUrl("https://mobile.twitter.com/someone/status/1234"), "tweet");
  assert.equal(typeForUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "video");
  assert.equal(typeForUrl("https://vimeo.com/123"), "video");
  assert.equal(typeForUrl("https://www.reddit.com/r/programming/comments/abc"), "post");
});

test("typeForUrl makes a long page an article and a short one a bookmark", () => {
  assert.equal(typeForUrl("https://example.com/essay", 5000), "article");
  assert.equal(typeForUrl("https://example.com/essay", 200), "bookmark");
  assert.equal(typeForUrl("https://example.com/paper.pdf", 5000), "bookmark");
  assert.equal(typeForUrl("not a url", 5000), "bookmark");
});
