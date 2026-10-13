import { test } from "node:test";
import assert from "node:assert/strict";
import { needsTitle } from "./youtube";

test("a video saved by pasting its link gets its real title looked up", () => {
  assert.equal(needsTitle("youtube.com/watch"), true);
  assert.equal(needsTitle("youtu.be/dQw4w9WgXcQ"), true);
  assert.equal(needsTitle("m.youtube.com/shorts/dQw4w9WgXcQ"), true);
  assert.equal(needsTitle("YouTube video dQw4w9WgXcQ"), true);
  assert.equal(needsTitle(""), true);
  assert.equal(needsTitle(undefined), true);
});

test("a title the video has, or the reader gave it, is kept", () => {
  assert.equal(needsTitle("Never Gonna Give You Up"), false);
  assert.equal(needsTitle("YouTube video essays I liked"), false);
  assert.equal(needsTitle("youtube.com is great"), false);
});
