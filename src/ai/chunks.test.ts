import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, pickChunks, pickPassages, terms } from "./chunks";
import { coverageLine } from "./coverage";
import { pickTopics, sourceText, SOURCE_LIMIT } from "./prompts";

test("pickTopics keeps only topics from the list, in list order, at most three", () => {
  const topics = ["Rivers", "Economics", "History", "Health"];
  assert.deepEqual(pickTopics("- history\n2. Rivers\nTravel\n", topics), ["Rivers", "History"]);
  assert.deepEqual(pickTopics("nothing fits", topics), []);
  assert.equal(pickTopics("Rivers\nEconomics\nHistory\nHealth", topics).length, 3);
});

test("terms keeps content words and drops short and common ones", () => {
  assert.deepEqual(terms("What is the Rhine river about?"), ["rhine", "river"]);
});

test("chunkText keeps short paragraphs whole and packs them", () => {
  const text = ["First paragraph.", "Second paragraph.", "Third paragraph."].join("\n\n");
  assert.deepEqual(chunkText(text, 40), ["First paragraph.\n\nSecond paragraph.", "Third paragraph."]);
});

test("chunkText cuts a paragraph longer than the size", () => {
  const chunks = chunkText("x".repeat(250), 100);
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
});

test("pickChunks ranks by shared words and keeps the original order", () => {
  const chunks = ["Ocean tides and moons.", "Rivers carry silt to the delta.", "A river valley forms slowly.", "Unrelated trivia."];
  assert.deepEqual(pickChunks("How does a river form?", chunks, 1000), ["Rivers carry silt to the delta.", "A river valley forms slowly."]);
});

test("pickChunks falls back to the opening passages when nothing matches", () => {
  const chunks = ["Alpha.", "Beta.", "Gamma."];
  assert.deepEqual(pickChunks("zzz", chunks, 13), ["Alpha.", "Beta."]);
});

test("pickChunks respects the character budget", () => {
  const chunks = ["river ".repeat(100), "river short"];
  const picked = pickChunks("river", chunks, 50);
  assert.deepEqual(picked, ["river short"]);
});

test("sourceText returns short text whole and cuts long text at a paragraph break", () => {
  assert.equal(sourceText("  short  "), "short");
  const long = "a".repeat(SOURCE_LIMIT - 100) + "\n\n" + "b".repeat(5000);
  const cut = sourceText(long);
  assert.ok(cut.length <= SOURCE_LIMIT);
  assert.ok(!cut.includes("b"));
});

test("pickPassages leaves out the passages a thread already sent", () => {
  const chunks = ["Rivers carry silt.", "A river valley forms.", "Rivers flood the plain."];
  const p = pickPassages("river", chunks, 1000, 60, new Set([0]));
  assert.deepEqual(p.indexes, [1, 2]);
  assert.equal(p.sent, 2);
  assert.equal(p.fallback, false);
});

test("pickPassages with every passage already sent sends nothing and does not call it a fallback", () => {
  const chunks = ["Alpha.", "Beta."];
  const p = pickPassages("alpha", chunks, 1000, 12, new Set([0, 1]));
  assert.equal(p.sent, 0);
  assert.equal(p.fallback, false);
  assert.match(coverageLine({ kind: "ask", picked: p, pages: [] }) ?? "", /earlier in this thread/);
});
