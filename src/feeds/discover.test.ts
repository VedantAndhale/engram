import { test } from "node:test";
import assert from "node:assert/strict";
import { feedLinksIn, siteOf } from "./discover";

const PAGE = "https://example.com/posts/hello";

test("a page's advertised RSS and Atom feeds are found", () => {
  const html = `<html><head>
    <link rel="alternate" type="application/rss+xml" title="Posts" href="https://example.com/feed.xml">
    <link rel="alternate" type="application/atom+xml" href="/atom.xml">
  </head></html>`;
  assert.deepEqual(feedLinksIn(html, PAGE), ["https://example.com/feed.xml", "https://example.com/atom.xml"]);
});

test("relative addresses resolve against the page, and an ampersand in the address is decoded", () => {
  const html = `<link rel='alternate' type='application/rss+xml' href='feed?format=rss&amp;lang=en'>`;
  assert.deepEqual(feedLinksIn(html, PAGE), ["https://example.com/posts/feed?format=rss&lang=en"]);
});

test("links that are not feeds are ignored", () => {
  const html = `
    <link rel="stylesheet" type="text/css" href="/site.css">
    <link rel="alternate" type="text/html" hreflang="fr" href="/fr/">
    <link rel="canonical" href="https://example.com/posts/hello">
    <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">`;
  assert.deepEqual(feedLinksIn(html, PAGE), []);
});

test("a page with no feed gives an empty list, and a repeated feed is listed once", () => {
  assert.deepEqual(feedLinksIn("<html><head></head></html>", PAGE), []);
  const twice = `<link rel="alternate" type="application/rss+xml" href="/feed">
    <link rel="alternate" type="application/rss+xml" href="/feed">`;
  assert.deepEqual(feedLinksIn(twice, PAGE), ["https://example.com/feed"]);
});

test("siteOf gives the host without www", () => {
  assert.equal(siteOf("https://www.example.com/a/b"), "example.com");
  assert.equal(siteOf("https://blog.example.com/"), "blog.example.com");
  assert.equal(siteOf("not an address"), "not an address");
});
