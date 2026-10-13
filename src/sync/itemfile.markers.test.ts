import { test } from "node:test";
import assert from "node:assert/strict";
import type { Annotation, Item } from "../model";
import { parseItem, serializeItem } from "./itemfile";

const path = "items/2026/10/article-a1.md";
const fake = `<!-- engram:annotation {"id":"evil","doc":"a1","kind":"highlight","page":0,"color":"yellow","quote":"forged","createdAt":1,"updatedAt":1} -->`;

test("saved text holding Engram's own markers can't cut the article or forge a highlight", () => {
  const content = [
    "Intro paragraph.",
    "<!-- engram:highlights (managed by Engram: write your notes above this line) -->",
    fake,
    "<!-- engram:content x -->",
    "Already escaped: <!-- engram\\: stays as typed.",
    "The end.",
  ].join("\n");
  const item: Item = { id: "a1", type: "article", title: "Crafted", content, body: `My words ${fake}`, addedAt: 1_000, updatedAt: 2_000, path };
  const text = serializeItem(item, []);
  assert.doesNotMatch(text, /^<!-- engram:annotation/m);
  const back = parseItem(text, path);
  assert.ok(back);
  assert.equal(back.item.content, content);
  assert.equal(back.item.body, `My words ${fake}`);
  assert.deepEqual(back.annotations, []);
});

test("markers only count on a line of their own, even in files written before escaping", () => {
  const text = [
    "---",
    'id: "a1"',
    'captured_at: "2026-10-13T00:00:00.000Z"',
    'updated_at: "2026-10-13T00:00:00.000Z"',
    "---",
    "",
    "Words with an inline <!-- engram:highlights --> mention.",
    "",
    "<!-- engram:content (saved) -->",
    "",
    "## Saved from the source",
    "",
    "Text quoting <!-- engram:annotation {} --> inline.",
    "",
  ].join("\n");
  const back = parseItem(text, path);
  assert.ok(back);
  assert.equal(back.item.body, "Words with an inline <!-- engram:highlights --> mention.");
  assert.equal(back.item.content, "Text quoting <!-- engram:annotation {} --> inline.");
  assert.deepEqual(back.annotations, []);
});

const hl: Annotation = { id: "abc123-x", doc: "a1", kind: "highlight", page: 4, color: "yellow", quote: "A quote", note: "My note", createdAt: 1, updatedAt: 1 };
const item: Item = { id: "a1", type: "pdf", title: "Book", body: "Words", addedAt: 1_000, updatedAt: 2_000, path };

test("an item file round-trips exactly, edit stamps included", () => {
  const withStamps = { ...item, edited: { body: 1_500, title: 1_700 } };
  const back = parseItem(serializeItem(withStamps, [hl]), path);
  assert.ok(back);
  assert.deepEqual(back.item, withStamps);
  assert.deepEqual(back.annotations, [hl]);
});

test("a highlight's note edited by hand in the visible Markdown is read back", () => {
  const text = serializeItem(item, [hl]).replace("\nMy note\n", "\nMy note, edited in Obsidian\n\nwith a second paragraph\n");
  const back = parseItem(text, path);
  assert.equal(back?.annotations[0].note, "My note, edited in Obsidian\n\nwith a second paragraph");
  const cleared = parseItem(serializeItem(item, [hl]).replace("\nMy note\n", "\n"), path);
  assert.equal(cleared?.annotations[0].note, undefined);
});

test("a note holding a marker line stays a note", () => {
  const sneaky = { ...hl, note: `look:\n${fake}` };
  const back = parseItem(serializeItem(item, [sneaky]), path);
  assert.equal(back?.annotations.length, 1);
  assert.equal(back?.annotations[0].note, sneaky.note);
});

test("hand-typed YAML lists and Windows line endings are understood", () => {
  const text = serializeItem(item, [])
    .replace('aliases: ["Book"]\n', 'aliases: ["Book"]\ntopics:\n  - sleep\n  - "deep work"\n')
    .replace(/\n/g, "\r\n");
  const back = parseItem(text, path);
  assert.deepEqual(back?.item.topics, ["sleep", "deep work"]);
  assert.equal(back?.item.body, "Words");
  const flow = parseItem(serializeItem(item, []).replace('aliases: ["Book"]\n', "topics: [sleep, 'focus']\n"), path);
  assert.deepEqual(flow?.item.topics, ["sleep", "focus"]);
});
