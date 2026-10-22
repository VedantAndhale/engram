import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { paragraphsOf } from "./paragraphs";
import { ArticleBody } from "./markdown";
import { articlePassages } from "../ai/chunks";

const article = [
  "# Title",
  "",
  "First paragraph, on one line.",
  "It continues here.",
  "",
  "- item one",
  "- item two",
  "",
  "```",
  "code line",
  "```",
  "",
  "<div>raw html block</div>",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "Last paragraph.",
].join("\n");

test("markdown paragraphs are the top-level blocks, numbered in reading order", () => {
  const ps = paragraphsOf(article, true);
  assert.deepEqual(
    ps.map((p) => p.n),
    [1, 2, 3, 4, 5, 6],
  );
  assert.match(ps[0].text, /^# Title/);
  assert.match(ps[1].text, /First paragraph, on one line\.\nIt continues here\./);
  assert.match(ps[2].text, /^- item one/);
  assert.doesNotMatch(ps.map((p) => p.text).join("\n"), /raw html/, "raw HTML is drawn as nothing, so it is not numbered");
});

test("a plain-text save is one paragraph per line", () => {
  const ps = paragraphsOf("One line.\nAnother line.\n\nA third.", false);
  assert.deepEqual(ps, [
    { n: 1, text: "One line." },
    { n: 2, text: "Another line." },
    { n: 3, text: "A third." },
  ]);
});

test("the article view puts the same numbers on the blocks the model is told about", () => {
  const html = renderToStaticMarkup(createElement(ArticleBody, { text: article, markdown: true }));
  const numbers = [...html.matchAll(/data-para="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(
    numbers,
    paragraphsOf(article, true).map((p) => p.n),
  );
});

test("a plain-text article is numbered the same way in the view and in the paragraph list", () => {
  const text = "One line.\nAnother line.";
  const html = renderToStaticMarkup(createElement(ArticleBody, { text, markdown: false }));
  assert.deepEqual(
    [...html.matchAll(/data-para="(\d+)"/g)].map((m) => Number(m[1])),
    paragraphsOf(text, false).map((p) => p.n),
  );
});

test("article passages label each paragraph with its number, and keep long paragraphs' number", () => {
  const passages = articlePassages([
    { n: 1, text: "Short one." },
    { n: 2, text: "x".repeat(2500) },
    { n: 3, text: "" },
  ], 1200);
  assert.match(passages[0], /^\[¶1\]\nShort one\./);
  const pieces = passages.join("\n\n").split(/\[¶2\]\n/).length - 1;
  assert.ok(pieces >= 2, "a long paragraph is cut into pieces that share its number");
  assert.ok(passages.every((p) => p.length <= 1200 + 2), "every passage fits the size");
  assert.doesNotMatch(passages.join("\n"), /\[¶3\]/, "an empty paragraph is not sent");
});
