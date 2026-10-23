import { test } from "node:test";
import assert from "node:assert/strict";
import { Awaiting } from "./awaiting";

test("removing the model ends every request still waiting, with the reason", () => {
  const waiting = new Awaiting<number | "load">();
  const ended: string[] = [];
  waiting.set("load", (err) => ended.push(`load: ${err.message}`));
  waiting.set(7, (err) => ended.push(`7: ${err.message}`));
  waiting.failAll(new Error("unloaded"));
  assert.deepEqual(ended, ["load: unloaded", "7: unloaded"]);
  assert.equal(waiting.size, 0);
});

test("a request that was answered is not ended later", () => {
  const waiting = new Awaiting<number>();
  let ended = 0;
  waiting.set(1, () => ended++);
  waiting.delete(1);
  waiting.failAll(new Error("unloaded"));
  assert.equal(ended, 0);
});

test("each request is ended once, even if failAll runs again", () => {
  const waiting = new Awaiting<number>();
  let ended = 0;
  waiting.set(1, () => ended++);
  waiting.failAll(new Error("unloaded"));
  waiting.failAll(new Error("unloaded"));
  assert.equal(ended, 1);
});
