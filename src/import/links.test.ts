import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFormat } from "./detect";
import { isWebAddress, parseLinks } from "./links";

test("columns are read by name, in any order, with topics split on semicolons", () => {
  const csv = [
    "topics,link,title,author,publication,description",
    "AI & Tech; Culture & Society,https://aeon.co/essays/x,Holes in the web,Deepak Varuvel Dennison,Aeon,Huge swathes of knowledge",
  ].join("\n");
  const { links, warnings } = parseLinks(csv);
  assert.deepEqual(warnings, []);
  assert.deepEqual(links, [
    {
      url: "https://aeon.co/essays/x",
      title: "Holes in the web",
      author: "Deepak Varuvel Dennison",
      publication: "Aeon",
      description: "Huge swathes of knowledge",
      topics: ["AI & Tech", "Culture & Society"],
    },
  ]);
});

test("a row with no web address is left out and reported, and a blank row is silent", () => {
  const csv = [
    "title,link",
    "Kept,https://example.com/a",
    "Broken one,",
    ",",
    "Not a link,www.example.com/b",
    "Kept too,http://example.org/c",
  ].join("\n");
  const { links, warnings } = parseLinks(csv);
  assert.deepEqual(
    links.map((l) => l.url),
    ["https://example.com/a", "http://example.org/c"],
  );
  assert.deepEqual(warnings, ["Row 3 has no web address, so it was left out.", "Row 5 has no web address, so it was left out."]);
});

test("a url column works as a link column, and a title may be missing", () => {
  const { links } = parseLinks("url\nhttps://example.com/x\n");
  assert.equal(links.length, 1);
  assert.equal(links[0].url, "https://example.com/x");
  assert.equal(links[0].title, "");
  assert.deepEqual(links[0].topics, []);
});

test("with both a link and a url column, each row takes the first one that holds a web address", () => {
  const { links, warnings } = parseLinks("title,link,url\nA,,https://a.com\nB,not a link,https://b.com\nC,https://c.com,https://other.com\n");
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    links.map((l) => l.url),
    ["https://a.com", "https://b.com", "https://c.com"],
  );
});

test("a fake address is left out: a bare scheme or a space in the host is not a web address", () => {
  const { links, warnings } = parseLinks("title,link\nA,https://\nB,https://exa mple.com\nC,https://example.com/ok\n");
  assert.deepEqual(
    links.map((l) => l.url),
    ["https://example.com/ok"],
  );
  assert.deepEqual(warnings, ["Row 2 has no web address, so it was left out.", "Row 3 has no web address, so it was left out."]);
  assert.equal(isWebAddress("https://"), false);
  assert.equal(isWebAddress("ftp://example.com/file"), false);
  assert.equal(isWebAddress("http://example.com"), true);
});

test("a row with text past the header is left out, since a stray comma moved its columns", () => {
  const { links, warnings } = parseLinks("title,link\nEight patterns, mostly,https://example.com/p\nClean,https://example.com/q\n");
  assert.deepEqual(
    links.map((l) => l.url),
    ["https://example.com/q"],
  );
  // The CSV reader also reports the ragged row itself; both messages are shown.
  assert.ok(warnings.includes("Row 2 has more fields than the header, so it was left out."), warnings.join(" | "));
});

test("empty cells past the header (a trailing comma) do not cost the row", () => {
  const { links, warnings } = parseLinks("title,link\nA,https://example.com/a,\n");
  assert.equal(links.length, 1);
  // The CSV reader still notes the extra cell as ragged; the link itself is not left out.
  assert.equal(warnings.filter((w) => w.includes("left out")).length, 0);
});

test("a CSV with no link or url column is refused", () => {
  assert.throws(() => parseLinks("title,author\nA,B\n"), /no link or url column/);
});

test("a quoted field with a comma stays one field", () => {
  const { links } = parseLinks('title,link\n"Eight patterns, mostly",https://example.com/p\n');
  assert.equal(links[0].title, "Eight patterns, mostly");
});

test("detection: a link column is a links file, Readwise and Kindle keep their own formats", () => {
  assert.equal(detectFormat("id,title,author,link\n1,A,B,https://example.com\n"), "links");
  assert.equal(detectFormat("Highlight,Book Title,Book Author\nSome words,A Book,Someone\n"), "readwise");
  assert.equal(detectFormat("Just some text\nwith no table in it\n"), "unknown");
  // A highlights export that lacks Book Title is a Readwise file that is wrong, not a list of links.
  assert.equal(detectFormat("Highlight,Title,Author,URL,Note\n\"Some quote\",A Book,Someone,https://book.example/x,\n"), "readwise");
});
