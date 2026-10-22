import { test } from "node:test";
import assert from "node:assert/strict";
import { appendKept, keptBlock } from "./keep";
import type { Turn } from "./thread";

const turn = (question: string, answer: string, stopped = false): Turn => ({ question, answer, note: null, sources: [], pages: [], stopped, textKey: "t", quotes: {} });

test("an explanation of a selection names the passage, quotes it, and signs the answer as the model's", () => {
  const block = keptBlock({ action: "explain", anchor: { para: 7, quote: "runs  north" }, question: undefined }, [turn("Explain: “runs north”", "It flows to the sea.")], "Gemma 4 E2B", "Rivers");
  assert.match(block, /^\*\*Explain\*\* on “Rivers”, ¶7/);
  assert.match(block, /> “runs north”/);
  assert.match(block, /> It flows to the sea\./);
  assert.match(block, /> \*Gemma 4 E2B, on this device\*/);
  // The generated question that rebuilds the conversation is not shown as if the reader asked it.
  assert.doesNotMatch(block, /Explain: “runs north”\*\*/);
});

test("a question and its follow-up are both kept, each under the words that were asked", () => {
  const block = keptBlock(
    { action: "ask", anchor: { para: 3 }, question: "Which way?" },
    [turn("Which way?", "North."), turn("And the Amazon?", "East.")],
    "Gemma 4 E2B",
    "Rivers",
  );
  assert.match(block, /^\*\*Question\*\* on “Rivers”\n/, "a whole-article note names no paragraph");
  assert.match(block, /\*\*Which way\?\*\*/);
  assert.match(block, /\*\*And the Amazon\?\*\*/);
  assert.ok(block.indexOf("North.") < block.indexOf("And the Amazon?"));
});

test("the passage a question was about is not repeated inside the question", () => {
  const block = keptBlock({ action: "ask", anchor: { para: 2, quote: "subject 5" }, question: "Why?" }, [turn("Why?\n\nAbout this passage: “subject 5”", "Because.")], "M", "T");
  assert.doesNotMatch(block, /About this passage/);
  assert.match(block, /\*\*Why\?\*\*/);
});

test("an answer cut short says so, and blank lines inside an answer stay inside the quote", () => {
  const block = keptBlock({ action: "summary", anchor: { para: 1 }, question: undefined }, [turn("Summarize this item.", "One.\n\nTwo.", true)], "M", "T");
  assert.match(block, /> One\.\n>\n> Two\./);
  assert.match(block, /stopped early/);
});

test("kept blocks go after what is there, with one blank line, and the first one needs no gap", () => {
  assert.equal(appendKept("", "BLOCK"), "BLOCK\n");
  assert.equal(appendKept("my words\n\n", "BLOCK"), "my words\n\nBLOCK\n");
  assert.equal(appendKept(appendKept("a", "ONE"), "TWO"), "a\n\nONE\n\nTWO\n");
});
