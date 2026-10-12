import { test } from "node:test";
import assert from "node:assert/strict";
import { orderAfterMove } from "./order";

/** The list after one entry takes its new order, sorted as the app sorts it. */
const apply = (orders: number[], i: number, dir: -1 | 1) => {
  const order = orderAfterMove(orders, i, dir);
  assert.notEqual(order, null);
  const next = [...orders];
  next[i] = order as number;
  return [...next].sort((a, b) => a - b);
};

test("moving up or down swaps an entry with its neighbour", () => {
  // Middle to the top: above the old first entry.
  assert.deepEqual(apply([1, 2, 3], 1, -1), [0, 1, 3]);
  // Bottom to the middle.
  assert.deepEqual(apply([1, 2, 3], 2, -1), [1, 1.5, 2]);
  // Top down past the second entry.
  assert.deepEqual(apply([1, 2, 3], 0, 1), [2, 2.5, 3]);
});

test("the ends can't move past the list", () => {
  assert.equal(orderAfterMove([1, 2, 3], 0, -1), null);
  assert.equal(orderAfterMove([1, 2, 3], 2, 1), null);
  assert.equal(orderAfterMove([], 0, 1), null);
  assert.equal(orderAfterMove([1], -1, 1), null);
});

test("two devices moving different entries from the same list both keep their change", () => {
  // Start: a=1, b=2, c=3, d=4. Device X moves b to the top; device Y moves c up past b.
  const x = orderAfterMove([1, 2, 3, 4], 1, -1);
  const y = orderAfterMove([1, 2, 3, 4], 2, -1);
  assert.equal(x, 0);
  assert.equal(y, 1.5);
  // Each device writes only its own entry, so the merged list has both moves.
  const merged = [
    { id: "a", order: 1 },
    { id: "b", order: x as number },
    { id: "c", order: y as number },
    { id: "d", order: 4 },
  ].sort((p, q) => p.order - q.order || (p.id < q.id ? -1 : 1));
  assert.deepEqual(
    merged.map((e) => e.id),
    ["b", "a", "c", "d"],
  );
});
