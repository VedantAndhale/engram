import { test } from "node:test";
import assert from "node:assert/strict";
import { GEMMA } from "./model";
import { ANSWER_RESERVE, addTurn, clearAllThreads, threadOf, type Turn } from "./thread";
import { FULL, answerTurn, askedOf, build, turnContext, withKey, type Generate } from "./turn";

const article = ["# Rivers", "", "The Nile runs north through Egypt.", "", "The Amazon carries more water than any other river.", "", "The Danube crosses ten countries."].join("\n");
const ctx = () => turnContext({ key: "item:n1", title: "Rivers", text: article, article: { markdown: true } });

/** A model that answers with fixed words and records what it was asked. */
function fake(text: string, outcome: Partial<{ cancelled: boolean; tokens: number; threadEnded: boolean }> = {}) {
  const calls: { prompt: string; thread?: Parameters<Generate>[3] }[] = [];
  const generate: Generate = async (prompt, onToken, _signal, thread) => {
    calls.push({ prompt, thread });
    for (const piece of text.split(" ")) onToken(`${piece} `);
    return { text, tokens: 300, cancelled: false, threadEnded: false, ...outcome };
  };
  return { generate, calls };
}

const turn = (q: string): Turn => ({ question: q, answer: `answer to ${q}`, note: null, sources: [], pages: [], stopped: false, textKey: "t1", quotes: {} });

test("an article's context numbers its paragraphs the way the article view does, and cites them", () => {
  const c = ctx();
  assert.equal(c.cite, "para");
  assert.deepEqual(
    c.paragraphs.map((p) => p.n),
    [1, 2, 3, 4],
  );
  assert.ok(c.chunks[0].startsWith("[¶1]"));
});

test("notes over one article share its passages but not its thread", () => {
  const a = ctx();
  const b = withKey(a, "item:n2");
  assert.equal(b.chunks, a.chunks);
  assert.equal(b.textKey, a.textKey);
  assert.notEqual(b.key, a.key);
});

test("a question is recorded with the paragraphs it cited and their words", async () => {
  clearAllThreads();
  const { generate, calls } = fake("The Nile runs north [¶2].");
  const seen: string[] = [];
  const error = await answerTurn(ctx(), { kind: "ask", question: "Which way does the Nile run?" }, generate, (p) => seen.push(p));
  assert.equal(error, null);
  assert.equal(seen.join("").trim(), "The Nile runs north [¶2].");
  assert.match(calls[0].prompt, /Which way does the Nile run\?/);
  const t = threadOf("item:n1");
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0].answer, "The Nile runs north [¶2].");
  assert.ok(t.turns[0].pages.includes(2));
  assert.match(t.turns[0].quotes[2], /Nile/);
  assert.equal(t.tokens, 300);
});

test("a follow-up is asked as a follow-up and brings only passages the thread has not sent", async () => {
  clearAllThreads();
  const small = turnContext({ key: "item:n1", title: "Rivers", text: article, article: { markdown: true } });
  const { generate, calls } = fake("ok");
  await answerTurn(small, { kind: "ask", question: "Nile" }, generate, () => {});
  await answerTurn(small, { kind: "ask", question: "Danube" }, generate, () => {});
  assert.match(calls[1].prompt, /follow-up/);
  assert.equal(calls[1].thread?.turns.length, 1);
  assert.equal(threadOf("item:n1").turns.length, 2);
});

test("a quick action on a selection is recorded as a turn the thread can continue from", async () => {
  clearAllThreads();
  const { generate, calls } = fake("It means the river flows toward the Mediterranean.");
  const error = await answerTurn(ctx(), { kind: "quick", action: "explain", selection: "runs north", context: "The Nile runs north through Egypt." }, generate, () => {});
  assert.equal(error, null);
  assert.match(calls[0].prompt, /runs north/);
  const t = threadOf("item:n1");
  assert.equal(t.turns[0].question, "Explain: “runs north”");
  assert.deepEqual(t.turns[0].sources, ["runs north"]);
  // The next question rebuilds nothing: this turn is already in the conversation.
  assert.equal(t.needsRebuild, false);
  assert.equal(t.textKey, ctx().textKey);
});

test("a summary is recorded under a plain question", async () => {
  clearAllThreads();
  const { generate } = fake("Three rivers.");
  await answerTurn(ctx(), { kind: "summary" }, generate, () => {});
  assert.equal(threadOf("item:n1").turns[0].question, "Summarize this item.");
});

test("a selection longer than the limit says only the start was used", () => {
  clearAllThreads();
  const long = "word ".repeat(1000);
  const built = build(ctx(), { kind: "quick", action: "explain", selection: long, context: "" }, threadOf("item:n1"));
  assert.match(built?.turn.note ?? "", /Only the first/);
});

test("stopping before any words keeps no turn and marks the thread to rebuild", async () => {
  clearAllThreads();
  addTurn("item:n1", turn("earlier"), 500, [0], false);
  const { generate } = fake("", { cancelled: true, threadEnded: true });
  const error = await answerTurn(ctx(), { kind: "ask", question: "Nile" }, generate, () => {});
  assert.match(error ?? "", /Stopped before the answer started/);
  const t = threadOf("item:n1");
  assert.equal(t.turns.length, 1);
  assert.equal(t.needsRebuild, true);
});

test("stopping partway keeps the words so far and ends the conversation", async () => {
  clearAllThreads();
  const { generate } = fake("The Nile runs", { cancelled: true, threadEnded: true });
  assert.equal(await answerTurn(ctx(), { kind: "ask", question: "Nile" }, generate, () => {}), null);
  const t = threadOf("item:n1");
  assert.equal(t.turns[0].stopped, true);
  assert.equal(t.turns[0].answer, "The Nile runs");
  assert.equal(t.needsRebuild, true);
});

test("a failed answer returns its message and marks the thread to rebuild", async () => {
  clearAllThreads();
  const generate: Generate = async () => {
    throw new Error("The model stopped unexpectedly.");
  };
  assert.equal(await answerTurn(ctx(), { kind: "ask", question: "Nile" }, generate, () => {}), "The model stopped unexpectedly.");
  assert.equal(threadOf("item:n1").needsRebuild, false, "no turns yet, so nothing to rebuild");
  addTurn("item:n1", turn("earlier"), 500, [0], false);
  await answerTurn(ctx(), { kind: "ask", question: "Nile" }, generate, () => {});
  assert.equal(threadOf("item:n1").needsRebuild, true);
});

test("a thread with no room says so and does not call the model", async () => {
  clearAllThreads();
  addTurn("item:n1", turn("earlier"), GEMMA.contextTokens - ANSWER_RESERVE - 50, [0], false);
  const { generate, calls } = fake("never");
  assert.equal(await answerTurn(ctx(), { kind: "ask", question: "Nile" }, generate, () => {}), FULL);
  assert.equal(calls.length, 0);
});

test("a quick action reads in the thread as a question about the selection", () => {
  assert.equal(askedOf({ kind: "quick", action: "simplify", selection: "  a   b ", context: "" }), "Simplify: “a b”");
  assert.equal(askedOf({ kind: "ask", question: "  why?  " }), "why?");
});
