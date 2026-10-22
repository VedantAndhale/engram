import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPassages, type Picked } from "./chunks";
import { coverageLine, labelsIn, pagesIn, paragraphsIn } from "./coverage";
import { askPrompt, explainPrompt, EXPLAIN_LIMIT, sourceCut, summarizePrompt, SOURCE_LIMIT } from "./prompts";

const picked = (patch: Partial<Picked>): Picked => ({ texts: [], indexes: [], sent: 2, passages: 4, usedChars: 900, totalChars: 3000, fallback: false, ...patch });

test("sourceCut reports the used and total length when it cuts", () => {
  const long = "a".repeat(SOURCE_LIMIT + 500);
  const cut = sourceCut(long);
  assert.equal(cut.cut, true);
  assert.equal(cut.total, SOURCE_LIMIT + 500);
  assert.equal(cut.used, SOURCE_LIMIT);
});

test("sourceCut leaves short text whole and reports it as not cut", () => {
  assert.deepEqual(sourceCut("  short text  "), { text: "short text", cut: false, used: 10, total: 10 });
});

test("a summary of a long item says it covers only the start, in the prompt and the line", () => {
  const long = "word ".repeat(3000);
  assert.match(summarizePrompt("T", long), /covers only the start/);
  const cut = sourceCut(long);
  assert.equal(coverageLine({ kind: "summary", used: cut.used, total: cut.total }), `Covers the first ${cut.used.toLocaleString("en-GB")} of ${cut.total.toLocaleString("en-GB")} characters of this item. The rest was not used.`);
});

test("a short summary has no coverage line", () => {
  assert.equal(coverageLine({ kind: "summary", used: 100, total: 100 }), null);
});

test("an explanation of a long selection is capped and says so", () => {
  const long = "x ".repeat(EXPLAIN_LIMIT);
  assert.match(explainPrompt(long, "T"), /longer than the part below/);
  assert.match(coverageLine({ kind: "explain", used: EXPLAIN_LIMIT, total: long.trim().length }) ?? "", /Only the first 2,000 of/);
});

test("pickPassages reports how much was sent", () => {
  const chunks = ["Rivers carry silt.", "Ocean tides.", "A river valley forms."];
  const p = pickPassages("river", chunks, 1000, 1000);
  assert.equal(p.sent, 2);
  assert.equal(p.passages, 3);
  assert.equal(p.fallback, false);
  assert.equal(p.totalChars, 1000);
});

test("pickPassages marks a fallback when no passage matched", () => {
  const p = pickPassages("zzz", ["Alpha.", "Beta."], 1000);
  assert.equal(p.fallback, true);
  assert.equal(coverageLine({ kind: "ask", picked: p, pages: [] }), "No passage matched your question, so these are the opening passages.");
});

test("an Ask line names the passages and pages used", () => {
  const line = coverageLine({ kind: "ask", picked: picked({ sent: 4, passages: 12, usedChars: 6000, totalChars: 19400 }), pages: [3, 4, 9] });
  assert.equal(line, "Based on 4 of 12 passages (pages 3, 4, 9), about 6,000 of 19,400 characters. The rest of this item was not used.");
});

test("an Ask that used everything has no coverage line", () => {
  assert.equal(coverageLine({ kind: "ask", picked: picked({ sent: 4, passages: 4, usedChars: 3000, totalChars: 3000 }), pages: [] }), null);
});

test("askPrompt adds the partial note only when some passages were left out", () => {
  assert.match(askPrompt("q", ["p"], "T", true), /Only some passages/);
  assert.doesNotMatch(askPrompt("q", ["p"], "T", false), /Only some passages/);
});

test("pagesIn reads the page labels, in order, without repeats", () => {
  assert.deepEqual(pagesIn(["[Page 9]\nx", "[Page 3]\ny\n\n[Page 9]\nz"]), [3, 9]);
  assert.deepEqual(pagesIn(["no labels"]), []);
});

test("paragraphsIn reads the paragraph labels, in order, without repeats", () => {
  assert.deepEqual(paragraphsIn(["[¶9]\nx", "[¶3]\ny\n\n[¶9]\nz"]), [3, 9]);
  assert.deepEqual(labelsIn(["[¶2]\nx"], "para"), [2]);
  assert.deepEqual(labelsIn(["[Page 5]\nx"], "page"), [5]);
});
