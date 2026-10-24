import { test } from "node:test";
import assert from "node:assert/strict";
import { BATCH_MAX_BYTES, BATCH_MAX_FILES, batchMessage, planBatches } from "./batch";

test("a batch message has the count, then one line per change", () => {
  assert.equal(batchMessage(["“A”", "“B”"]), "Sync 2 changes\n\n- “A”\n- “B”");
  assert.equal(batchMessage(["reader.json"]), "Sync 1 change\n\n- reader.json");
});

test("a batch message lists ten changes and counts the rest", () => {
  const lines = Array.from({ length: 12 }, (_, i) => `item ${i}`);
  const message = batchMessage(lines);
  assert.ok(message.startsWith("Sync 12 changes\n\n- item 0\n"));
  assert.ok(message.includes("- item 9"));
  assert.ok(!message.includes("- item 10"));
  assert.ok(message.endsWith("and 2 more"));
});

const files = (n: number, bytes = 1) => Array.from({ length: n }, (_, i) => ({ id: i, bytes }));
const sizes = (groups: { length: number }[]) => groups.map((g) => g.length);

test("nothing ready makes no batches", () => {
  assert.deepEqual(planBatches([]), []);
});

test("a few small files share one batch, in order", () => {
  const items = files(5);
  const groups = planBatches(items);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.map((x) => x.id), [0, 1, 2, 3, 4]);
});

test("the file count caps a batch at 200", () => {
  assert.equal(BATCH_MAX_FILES, 200);
  assert.deepEqual(sizes(planBatches(files(450))), [200, 200, 50]);
});

test("the byte total caps a batch at 20 MB, even with few files", () => {
  const mb = 1024 * 1024;
  // 9 MB + 9 MB fits; a third 9 MB file would be 27 MB, so it starts the next batch.
  const groups = planBatches(files(3, 9 * mb));
  assert.deepEqual(sizes(groups), [2, 1]);
  assert.ok(BATCH_MAX_BYTES === 20 * mb);
});

test("a file bigger than the cap goes alone and is not dropped", () => {
  const groups = planBatches([{ id: 1, bytes: 1 }, { id: 2, bytes: 25 }, { id: 3, bytes: 1 }], 200, 20);
  assert.deepEqual(groups.map((g) => g.map((x) => x.id)), [[1], [2], [3]]);
});

test("deletions count toward the file cap but not the byte cap", () => {
  const groups = planBatches(files(250, 0));
  assert.deepEqual(sizes(groups), [200, 50]);
});
