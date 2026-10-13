import { test } from "node:test";
import assert from "node:assert/strict";
import { DAILY_CAP, DAY, INTERVALS, intervalDays, isRetired, nextReview, retireReview, startOfDay, todaysShare } from "./schedule";

const now = new Date(2026, 9, 13, 9, 0).getTime();
const days = (s: { due: number }, from = now) => Math.round((s.due - from) / DAY);

test("still clear walks up the ladder; hazy goes back to tomorrow", () => {
  let r = nextReview(undefined, true, now, "k");
  assert.equal(r.step, 1);
  assert.equal(days(r), 3);
  assert.equal(r.count, 1);
  r = nextReview(r, false, now, "k");
  assert.equal(r.step, 0);
  assert.equal(days(r), 1);
  assert.equal(r.count, 2);
});

test("past the last fixed step the gap keeps growing, about 2.5 times each time", () => {
  assert.equal(intervalDays(INTERVALS.length - 1), 90);
  assert.equal(intervalDays(INTERVALS.length), 225);
  assert.equal(intervalDays(INTERVALS.length + 1), 563);
  assert.equal(intervalDays(100), 3650);
  let r = nextReview(undefined, true, now, "k");
  const gaps: number[] = [];
  for (let i = 0; i < 9; i++) {
    r = nextReview(r, true, now, "k");
    gaps.push(days(r));
  }
  // Each gap is longer than the one before, within the ±10% nudge.
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] >= gaps[i - 1], `gap ${i}: ${gaps}`);
  assert.ok(gaps.at(-1)! > 1000);
});

test("the nudge is repeatable and stays within 10%", () => {
  const prev = { step: 3, due: now, last: now, count: 4 };
  const a = nextReview(prev, true, now, "card-a");
  assert.deepEqual(nextReview(prev, true, now, "card-a"), a);
  for (const key of ["a", "b", "c", "d", "e", "f"]) {
    const d = days(nextReview(prev, true, now, key));
    assert.ok(d >= 35 * 0.9 - 1 && d <= 35 * 1.1 + 1, `${key}: ${d}`);
  }
  // Tomorrow means tomorrow.
  assert.equal(days(nextReview(prev, false, now, "x")), 1);
});

test("a retired highlight is never due, and keeps its history", () => {
  const r = retireReview({ step: 4, due: now, last: now - DAY, count: 7 }, now);
  assert.ok(isRetired(r));
  assert.equal(r.count, 7);
  assert.ok(r.due > now + 50 * 365 * DAY);
  // Still a real date, since the folder index writes it out.
  assert.doesNotThrow(() => new Date(r.due).toISOString());
  const { today } = todaysShare([{ due: now - DAY, review: r }], now);
  assert.equal(today.length, 0);
});

test("a day brings at most the cap, oldest due first; the rest wait", () => {
  const cards = Array.from({ length: 50 }, (_, i) => ({ id: i, due: now - (i + 1) * 3_600_000 }));
  const { today, waiting } = todaysShare(cards, now);
  assert.equal(today.length, DAILY_CAP);
  assert.equal(waiting, 50 - DAILY_CAP);
  assert.equal(today[0].id, 49);
  // Not yet due isn't offered.
  assert.equal(todaysShare([{ due: now + DAY }], now).today.length, 0);
});

test("what was already reviewed today counts against the cap", () => {
  const reviewed = Array.from({ length: 28 }, () => ({ due: now + 3 * DAY, review: { last: startOfDay(now) + 1000 } }));
  const due = Array.from({ length: 5 }, (_, i) => ({ due: now - i * 1000 }));
  const { today, waiting } = todaysShare([...reviewed, ...due], now);
  assert.equal(today.length, 2);
  assert.equal(waiting, 3);
  // Yesterday's reviews don't.
  const yesterday = reviewed.map((c) => ({ ...c, review: { last: startOfDay(now) - 1000 } }));
  assert.equal(todaysShare([...yesterday, ...due], now).today.length, 5);
});
