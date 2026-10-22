import { test } from "node:test";
import assert from "node:assert/strict";
import { GEMMA } from "./model";
import { ANSWER_RESERVE, FIRST_CHARS, FOLLOW_UP_CHARS, MIN_CHARS, addTurn, clearAllThreads, clearThread, markAllRebuild, markRebuild, passageBudget, roomTokens, skippable, threadOf, useThreads, type Turn } from "./thread";
import { followUpPrompt } from "./prompts";

const turn = (q: string): Turn => ({ question: q, answer: `answer to ${q}`, note: null, sources: [], pages: [], stopped: false, textKey: "t1", quotes: {} });

test("a fresh thread has the whole window less the answer reserve", () => {
  clearAllThreads();
  const t = threadOf("a");
  assert.equal(roomTokens(t), GEMMA.contextTokens - ANSWER_RESERVE);
  assert.equal(passageBudget(t), FIRST_CHARS);
});

test("follow-ups are capped lower than the first question, and shrink as the window fills", () => {
  clearAllThreads();
  addTurn("b", turn("first"), 1900, [0, 1], false);
  const after = threadOf("b");
  assert.equal(passageBudget(after), FOLLOW_UP_CHARS);
  addTurn("b", turn("second"), 3300, [2], false);
  const late = threadOf("b");
  assert.ok(passageBudget(late) < FOLLOW_UP_CHARS);
  assert.ok(passageBudget(late) >= MIN_CHARS);
});

test("a thread with no room left is full: the budget is zero", () => {
  clearAllThreads();
  addTurn("c", turn("first"), GEMMA.contextTokens - ANSWER_RESERVE - 50, [0], false);
  assert.equal(passageBudget(threadOf("c")), 0);
});

test("addTurn keeps the passages sent, so the next question can skip them", () => {
  clearAllThreads();
  addTurn("d", turn("first"), 1500, [0, 3], false);
  addTurn("d", turn("second"), 1700, [3, 5], false);
  assert.deepEqual(threadOf("d").sent, [0, 3, 5]);
  assert.equal(threadOf("d").turns.length, 2);
});

test("after a rebuild, passages sent before the Stop are sent again, because the conversation lost them", () => {
  clearAllThreads();
  addTurn("j", turn("first"), 1500, [0, 1], false);
  addTurn("j", { ...turn("second"), stopped: true }, 0, [2], true);
  assert.deepEqual([...skippable(threadOf("j"))], []);
  addTurn("j", turn("third"), 1200, [0], false, true);
  assert.deepEqual(threadOf("j").sent, [0]);
  assert.deepEqual([...skippable(threadOf("j"))], [0]);
});

test("a turn that Stop ended marks the thread to rebuild, and keeps the turns", () => {
  clearAllThreads();
  addTurn("e", turn("first"), 1500, [0], false);
  addTurn("e", { ...turn("second"), stopped: true }, 0, [1], true);
  const t = threadOf("e");
  assert.equal(t.needsRebuild, true);
  assert.equal(t.turns.length, 2);
  assert.equal(t.tokens, 1500, "a stopped turn does not overwrite the last counted size");
});

test("a model unload marks every thread to rebuild, and keeps the turns", () => {
  clearAllThreads();
  addTurn("f", turn("first"), 1500, [0], false);
  addTurn("g", turn("first"), 1500, [0], false);
  markAllRebuild();
  assert.equal(threadOf("f").needsRebuild, true);
  assert.equal(threadOf("g").needsRebuild, true);
  assert.equal(threadOf("f").turns.length, 1);
});

test("markRebuild does nothing to a thread with no turns", () => {
  clearAllThreads();
  markRebuild("empty");
  assert.equal(useThreads.getState().threads["empty"], undefined);
});

test("starting a new thread clears only that thread", () => {
  clearAllThreads();
  addTurn("h", turn("first"), 1500, [0], false);
  addTurn("i", turn("first"), 1500, [0], false);
  clearThread("h");
  assert.equal(threadOf("h").turns.length, 0);
  assert.equal(threadOf("i").turns.length, 1);
});

test("a follow-up prompt says the earlier turns stand, and cites only when asked", () => {
  const p = followUpPrompt("What else?", ["[Page 4]\nText."], "Book", true, "page");
  assert.match(p, /earlier questions and answers in this conversation still stand/);
  assert.match(p, /cite the page it comes from as \[Page n\]/);
  assert.match(p, /<passage n="1">\n\[Page 4\]\nText\.\n<\/passage>/);
  assert.doesNotMatch(followUpPrompt("What else?", ["x"], "Book"), /cite the page/);
});

test("a follow-up with no new passage says so, and sends no passage tags", () => {
  const p = followUpPrompt("What else?", [], "Book");
  assert.match(p, /already in this conversation/);
  assert.match(p, /the item does not say/);
  assert.doesNotMatch(p, /<passage/);
});
