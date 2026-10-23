import { test } from "node:test";
import assert from "node:assert/strict";
import type { Note } from "./notes";
import { INTERRUPTED, fromNoteRecord, fromThreadRecord, plan, toNoteRecord } from "./notestate";
import type { Thread } from "./thread";

const note = (patch: Partial<Note> = {}): Note => ({
  id: "n1",
  item: "i1",
  action: "ask",
  anchor: { para: 2, quote: "The Nile runs north." },
  sentence: "The Nile runs north.",
  question: "Where does it end?",
  createdAt: 1,
  pending: null,
  waiting: null,
  error: null,
  ...patch,
});

const thread = (patch: Partial<Thread> = {}): Thread => ({
  turns: [],
  tokens: 0,
  sent: [],
  needsRebuild: false,
  textKey: null,
  ...patch,
});

test("a note is stored without its answer in progress, and remembers the question that was being answered", () => {
  const record = toNoteRecord(note({ pending: { question: "Where does it end?", text: "At the sea" } }));
  assert.equal(record.asking, "Where does it end?");
  assert.equal("pending" in record, false);
  assert.equal(toNoteRecord(note()).asking, null);
});

test("a question waiting for the model survives the round trip", () => {
  const waiting = { kind: "ask" as const, question: "Where does it end?" };
  const back = fromNoteRecord(toNoteRecord(note({ waiting })), false);
  assert.deepEqual(back.waiting, waiting);
  assert.equal(back.pending, null);
});

test("an answer cut off by a reload says so, and does not look finished", () => {
  const back = fromNoteRecord(toNoteRecord(note({ pending: { question: "Where does it end?", text: "At the" } })), false);
  assert.equal(back.error, INTERRUPTED);
  assert.equal(back.pending, null);
});

test("a note with no answer in progress keeps its own error, and its kept count", () => {
  const back = fromNoteRecord(toNoteRecord(note({ error: "This device has no WebGPU.", kept: 2 })), false);
  assert.equal(back.error, "This device has no WebGPU.");
  assert.equal(back.kept, 2);
});

test("a note saved before its request started, with nothing in it, says the request was cut off", () => {
  const back = fromNoteRecord(toNoteRecord(note()), false);
  assert.equal(back.error, INTERRUPTED);
});

test("a note with answers, or with a question waiting, is not called cut off", () => {
  assert.equal(fromNoteRecord(toNoteRecord(note()), true).error, null);
  const waiting = { kind: "ask" as const, question: "Where does it end?" };
  assert.equal(fromNoteRecord(toNoteRecord(note({ waiting })), false).error, null);
});

test("a thread with turns is rebuilt on the next question, since its model conversation is gone", () => {
  const turn = { question: "Q", answer: "A", note: null, sources: [], pages: [], stopped: false, textKey: "t", quotes: {} };
  const [key, back] = fromThreadRecord({ key: "i1:n1", ...thread({ turns: [turn], tokens: 900 }) });
  assert.equal(key, "i1:n1");
  assert.equal(back.needsRebuild, true);
  assert.equal(back.tokens, 900);
  assert.equal(back.turns.length, 1);
});

test("a thread with no turns is not marked for a rebuild", () => {
  const [, back] = fromThreadRecord({ key: "i1:n1", ...thread() });
  assert.equal(back.needsRebuild, false);
});

test("only the records that changed are written, and records that are gone are removed", () => {
  const written = new Map<string, string>();
  const first = plan(written, new Map([["a", { v: 1 }], ["b", { v: 1 }]]));
  assert.deepEqual(
    first.put.map(([id]) => id),
    ["a", "b"],
  );
  assert.deepEqual(first.remove, []);

  const same = plan(written, new Map([["a", { v: 1 }], ["b", { v: 1 }]]));
  assert.deepEqual(same.put, []);

  const later = plan(written, new Map([["a", { v: 2 }]]));
  assert.deepEqual(later.put, [["a", { v: 2 }]]);
  assert.deepEqual(later.remove, ["b"]);
  assert.deepEqual([...written.keys()], ["a"]);
});
