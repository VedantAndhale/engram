import { test } from "node:test";
import assert from "node:assert/strict";
import { pageBlocks, savedText, sentenceAround } from "./source";
import type { Item } from "../model";

const item = (patch: Partial<Item>): Item => ({ id: "x", type: "article", title: "x", addedAt: 1, updatedAt: 1, path: "x.md", ...patch });

test("savedText prefers the saved text, then your words, then the description", () => {
  assert.equal(savedText(item({ content: " article ", body: "mine", description: "d" })), "article");
  assert.equal(savedText(item({ body: "mine", description: "d" })), "mine");
  assert.equal(savedText(item({ description: "d" })), "d");
  assert.equal(savedText(item({})), "");
});

test("pageBlocks labels each page, keeps page order, and skips blank pages", () => {
  const rows = [
    { doc: "d", page: 3, text: "Third page." },
    { doc: "d", page: 1, text: "  First page.  " },
    { doc: "d", page: 2, text: "   " },
  ];
  assert.equal(pageBlocks(rows), "[Page 1]\nFirst page.\n\n[Page 3]\nThird page.");
});

test("pageBlocks returns an empty string when no page has text", () => {
  assert.equal(pageBlocks([]), "");
  assert.equal(pageBlocks([{ doc: "d", page: 1, text: " " }]), "");
});

test("sentenceAround returns the sentence a selection sits in", () => {
  const body = "The Rhine rises in the Alps. It flows north to the sea. Barges carry coal.";
  assert.equal(sentenceAround(body, "flows north"), "It flows north to the sea.");
  assert.equal(sentenceAround(body, "The Rhine rises"), "The Rhine rises in the Alps.");
  assert.equal(sentenceAround(body, "not in the text"), "");
  assert.equal(sentenceAround("", "anything"), "");
});

test("sentenceAround works on Markdown text by reading it without marks", () => {
  assert.equal(sentenceAround("A **bold** claim here. Then more.", "bold claim"), "A bold claim here.");
});
