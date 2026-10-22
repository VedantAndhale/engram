import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_BAR, scaleSpans, viewTopFor, viewWindow } from "./minimap";

test("paragraphs are scaled down the strip in proportion, in order", () => {
  const bars = scaleSpans(
    [
      { top: 0, height: 100 },
      { top: 200, height: 300 },
    ],
    1000,
    100,
  );
  assert.equal(bars[0].top, 0);
  assert.equal(Math.round(bars[1].top), 20);
  assert.ok(bars[1].height > bars[0].height);
});

test("a very short paragraph is still drawn, and a bar at the end stays on the strip", () => {
  const [tiny, last] = scaleSpans(
    [
      { top: 10, height: 1 },
      { top: 990, height: 10 },
    ],
    1000,
    100,
  );
  assert.ok(tiny.height >= MIN_BAR);
  assert.ok(last.top + last.height <= 100);
});

test("a text with no height or a strip with none draws nothing", () => {
  assert.deepEqual(scaleSpans([{ top: 0, height: 5 }], 0, 100), []);
  assert.deepEqual(scaleSpans([{ top: 0, height: 5 }], 100, 0), []);
});

test("the view window is the share of the text on screen, and stays on the strip at both ends", () => {
  const start = viewWindow(0, 500, 2000, 200);
  assert.deepEqual([start.top, Math.round(start.height)], [0, 50]);
  const end = viewWindow(1500, 500, 2000, 200);
  assert.equal(Math.round(end.top + end.height), 200);
  const past = viewWindow(5000, 500, 2000, 200);
  assert.ok(past.top <= 200 && past.top + past.height <= 200 + 0.001);
});

test("clicking the middle of the strip centres that part of the text", () => {
  // A 2000px text, a 500px screen, a 200px strip: the middle of the strip is the 1000px mark.
  assert.equal(viewTopFor(100, 200, 2000, 500), 750);
});

test("clicking near the ends scrolls only as far as the text goes", () => {
  assert.equal(viewTopFor(0, 200, 2000, 500), 0);
  assert.equal(viewTopFor(200, 200, 2000, 500), 1500);
  assert.equal(viewTopFor(-50, 200, 2000, 500), 0);
  assert.equal(viewTopFor(900, 200, 2000, 500), 1500);
});

test("a text that fits on one screen has nowhere to scroll", () => {
  assert.equal(viewTopFor(100, 200, 400, 500), 0);
});
