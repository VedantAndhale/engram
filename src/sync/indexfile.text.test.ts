import { test } from "node:test";
import assert from "node:assert/strict";
import { HIGHLIGHT_COLORS, type Annotation, type Item } from "../model";
import { buildIndex, plainText } from "./indexfile";

const folder = { id: "f1", name: "Reading" };

const article = (over: Partial<Item> = {}): Item => ({
  id: "a1",
  type: "article",
  title: "An essay",
  addedAt: 1_000,
  updatedAt: 2_000,
  path: "items/2026/10/an-essay-a1.md",
  ...over,
});

test("plainText drops a heading, emphasis, a link's address and code fences", () => {
  const md = "# A heading\n\nSome *emphasis*, **strong** and ~~struck~~ words with a [link](https://example.com/x).\n\n```ts\nconst answer = 42;\n```\n";
  assert.equal(plainText(md), "A heading Some emphasis, strong and struck words with a link. const answer = 42;");
});

test("plainText drops quote and list markers, bare addresses and image data", () => {
  const md = "> quoted line\n\n- one\n- two\n1. three\n\nsee https://example.com/a?b=1 now ![a pic](data:image/png;base64,AAA) _italic_ and snake_case";
  assert.equal(plainText(md), "quoted line one two three see now a pic italic and snake_case");
});

test("buildIndex stores the stripped start of the saved text beside the highlights", () => {
  const highlight: Annotation = {
    id: "h1",
    doc: "a1",
    kind: "highlight",
    page: 0,
    color: HIGHLIGHT_COLORS[0].value,
    quote: "a rare phrase",
    createdAt: 1_500,
    updatedAt: 1_500,
  };
  const index = buildIndex(folder, [article({ content: "# Title\n\nA *rare* phrase: zebra crossing.", contentFormat: "markdown" })], [highlight]);
  const entry = index.items[0];
  assert.equal(entry.text, "Title A rare phrase: zebra crossing.");
  assert.equal(entry.hasContent, true);
  assert.equal(entry.highlights?.length, 1);
});

test("buildIndex cuts long saved text to 6000 characters and marks the cut", () => {
  const long = buildIndex(folder, [article({ content: "word ".repeat(5_000), contentFormat: "markdown" })], []).items[0].text!;
  assert.ok(long.length <= 6_001);
  assert.ok(long.endsWith("word…"));

  // With no space to back up to, it cuts at the limit.
  const solid = buildIndex(folder, [article({ content: "x".repeat(10_000) })], []).items[0].text!;
  assert.equal(solid.length, 6_001);
  assert.ok(solid.endsWith("…"));

  // Short text is kept whole, without the mark.
  const short = buildIndex(folder, [article({ content: "A short note." })], []).items[0].text;
  assert.equal(short, "A short note.");
});

test("buildIndex has no text field for an item without saved text", () => {
  const none = buildIndex(folder, [article(), article({ id: "a2", content: "  \n " })], []);
  for (const entry of none.items) {
    assert.equal("text" in entry, false);
    assert.equal("hasContent" in entry, false);
  }
});

test("a deleted item is not in the index, and neither is its text", () => {
  const index = buildIndex(folder, [article({ deleted: true, content: "secret words" })], []);
  assert.equal(index.items.length, 0);
  assert.ok(!JSON.stringify(index).includes("secret"));
});