import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "./settle";

const item = (id: string, desired: number, h = 100) => ({ id, desired, h });

test("notes far apart each stand level with their passage", () => {
  const tops = settle([item("a", 0), item("b", 400), item("c", 900)], null);
  assert.deepEqual(tops, { a: 0, b: 400, c: 900 });
});

test("crowded notes stack downward with a gap, none covering another", () => {
  const tops = settle([item("a", 100), item("b", 120), item("c", 130)], null);
  assert.equal(tops.a, 100);
  assert.ok(tops.b >= tops.a + 100);
  assert.ok(tops.c >= tops.b + 100);
});

test("the open note stays level with its passage and the others make way on both sides", () => {
  const tops = settle([item("a", 300), item("b", 310), item("c", 320)], "b");
  assert.equal(tops.b, 310);
  assert.ok(tops.a + 100 <= tops.b);
  assert.ok(tops.c >= tops.b + 100);
});

test("a note pushed above the top of the column is pinned there and the rest settle below it", () => {
  const tops = settle([item("a", 10), item("b", 20)], "b");
  assert.equal(tops.a, 0);
  assert.ok(tops.b >= 100);
});

test("with no notes there is nothing to place", () => {
  assert.deepEqual(settle([], null), {});
});
