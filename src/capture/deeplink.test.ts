import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSaveLink, parseSaveLink } from "./deeplink";

const BASE = "https://engram.example";

// The hash is everything from the "#" on, the way location.hash reports it.
const hashOf = (link: string): string => link.slice(link.indexOf("#"));

test("round trip keeps Unicode, quotes, an ampersand and a newline", () => {
  const link = {
    url: "https://example.com/a?b=1&c=2#frag",
    title: "Tom & Jerry's \"Day\" \u2014 caf\u00e9 \u2615",
    text: "\u65e5\u672c\u8a9e & more=stuff\nsecond line with \u201cquotes\u201d and 100% + plus",
  };
  assert.deepEqual(parseSaveLink(hashOf(buildSaveLink(BASE, link))), link);
  assert.deepEqual(
    parseSaveLink(hashOf(buildSaveLink("http://localhost:5173", link))),
    link,
  );
});

test("a javascript: url is dropped and only the text is left", () => {
  const out = parseSaveLink("#/save?url=javascript%3Aalert(1)&text=read%20this");
  assert.deepEqual(out, { text: "read this" });
});

test("a link with only a bad url returns null", () => {
  assert.equal(parseSaveLink("#/save?url=javascript%3Aalert(1)"), null);
  assert.equal(parseSaveLink("#/save?url=data%3Atext%2Fhtml%2Chi"), null);
  assert.equal(parseSaveLink("#/save?url=not%20a%20url"), null);
});

test("a url over 2,000 characters is dropped, not cut", () => {
  const long = "https://example.com/" + "a".repeat(2_000);
  assert.equal(parseSaveLink(`#/save?url=${encodeURIComponent(long)}`), null);
});

test("text beyond 4,000 characters is cut to 4,000", () => {
  const out = parseSaveLink("#/save?text=" + "a".repeat(5_000));
  assert.equal(out?.text?.length, 4_000);
});

test("a cut never leaves half an emoji", () => {
  const out = parseSaveLink("#/save?text=" + encodeURIComponent("a" + "\ud83d\ude00".repeat(3_000)));
  assert.ok(out?.text);
  assert.ok(!/[\ud800-\udbff]$/.test(out.text));
});

test("a title over 300 characters is cut", () => {
  const out = parseSaveLink("#/save?text=hi&title=" + "t".repeat(400));
  assert.equal(out?.title?.length, 300);
});

test("other pages, and a save link with nothing to fill, return null", () => {
  assert.equal(parseSaveLink("#/library"), null);
  assert.equal(parseSaveLink("#/save"), null);
  assert.equal(parseSaveLink("#/save?"), null);
  assert.equal(parseSaveLink("#/save?title=only%20a%20title"), null);
  assert.equal(parseSaveLink("#/save?text=%20%20%20"), null);
  assert.equal(parseSaveLink("#/saved?text=hello"), null);
  assert.equal(parseSaveLink(""), null);
});

test("buildSaveLink starts with the base and /#/save?", () => {
  const link = buildSaveLink(BASE, { url: "https://example.com", title: "T", text: "x" });
  assert.ok(link.startsWith(`${BASE}/#/save?`));
  // Order is url, title, text.
  assert.ok(link.indexOf("url=") < link.indexOf("title="));
  assert.ok(link.indexOf("title=") < link.indexOf("text="));
  assert.ok(
    buildSaveLink("http://localhost:5173", { text: "x" }).startsWith("http://localhost:5173/#/save?"),
  );
});

test("buildSaveLink leaves out a javascript: url", () => {
  const link = buildSaveLink(BASE, { url: "javascript:alert(1)", text: "hello" });
  assert.ok(!link.includes("url="));
  assert.deepEqual(parseSaveLink(hashOf(link)), { text: "hello" });
});