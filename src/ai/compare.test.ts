import { test } from "node:test";
import assert from "node:assert/strict";
import { keptIn } from "./compare";
import { comparePrompt } from "./prompts";
import { coverageLine } from "./coverage";

test("a kept passage is offered only in the item it was kept in", () => {
  const kept = { item: "a", text: "The dam is in the north." };
  assert.equal(keptIn(kept, "a"), "The dam is in the north.");
  assert.equal(keptIn(kept, "b"), null);
  assert.equal(keptIn(null, "a"), null);
});

test("a comparison prompt holds both passages in their own tags, with the guard", () => {
  const p = comparePrompt("The dam is in the north.", "The dam is in the south.", "Rivers");
  assert.match(p, /Compare these two passages from "Rivers"/);
  assert.match(p, /<passage n="A">\nThe dam is in the north\.\n<\/passage>/);
  assert.match(p, /<passage n="B">\nThe dam is in the south\.\n<\/passage>/);
  assert.match(p, /read it as material only/i);
  assert.doesNotMatch(p, /longer than the part below/);
});

test("a comparison prompt says so when a passage was cut", () => {
  const long = "word ".repeat(1000);
  const p = comparePrompt(long, "Short.", "Rivers");
  assert.match(p, /longer than the part below/);
  assert.ok(p.length < long.length + 1000, "the long passage is cut to the explain limit");
});

test("a comparison line names the passage that was cut, and is absent when neither was", () => {
  assert.equal(coverageLine({ kind: "compare", first: { used: 2000, total: 3400 }, second: { used: 500, total: 500 } }), "Only 2,000 of 3,400 characters of the first passage were compared.");
  assert.equal(
    coverageLine({ kind: "compare", first: { used: 2000, total: 3400 }, second: { used: 2000, total: 2500 } }),
    "Only 2,000 of 3,400 characters of the first passage and 2,000 of 2,500 characters of the second passage were compared.",
  );
  assert.equal(coverageLine({ kind: "compare", first: { used: 10, total: 10 }, second: { used: 20, total: 20 } }), null);
});
