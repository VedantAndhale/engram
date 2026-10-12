import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTime, parseMoment, parseTime, videosIn, watchUrl, youtubeId } from "./youtube";

const ID = "dQw4w9WgXcQ";

test("a YouTube link of any usual form gives its video id", () => {
  assert.equal(youtubeId(`https://www.youtube.com/watch?v=${ID}`), ID);
  assert.equal(youtubeId(`https://www.youtube.com/watch?v=${ID}&t=42s&list=PL1`), ID);
  assert.equal(youtubeId(`https://youtu.be/${ID}?si=abc`), ID);
  assert.equal(youtubeId(`https://m.youtube.com/watch?v=${ID}`), ID);
  assert.equal(youtubeId(`https://www.youtube.com/shorts/${ID}`), ID);
  assert.equal(youtubeId(`https://www.youtube.com/embed/${ID}`), ID);
  assert.equal(youtubeId(`  https://www.youtube.com/live/${ID}  `), ID);
});

test("anything else gives no id", () => {
  assert.equal(youtubeId("https://www.coursera.org/learn/x/lecture/abc"), null);
  assert.equal(youtubeId("https://www.udemy.com/course/x/"), null);
  assert.equal(youtubeId("https://vimeo.com/123456"), null);
  assert.equal(youtubeId("https://www.youtube.com/watch?v=short"), null);
  assert.equal(youtubeId("ftp://youtube.com/watch?v=" + ID), null);
  assert.equal(youtubeId("not a link"), null);
  assert.equal(youtubeId("https://www.youtube.com/"), null);
});

test("the watch link is the same for every form of the same video", () => {
  assert.equal(watchUrl(ID), `https://www.youtube.com/watch?v=${ID}`);
  assert.equal(youtubeId(watchUrl(ID)), ID);
});

test("a paste gives its videos once each, in order, and what it skipped", () => {
  const paste = [
    `https://youtu.be/${ID}`,
    "",
    "Some words without a link",
    `https://www.youtube.com/watch?v=${ID}&t=5`,
    "https://www.coursera.org/learn/x",
    "https://www.youtube.com/watch?v=abcdefghijk",
  ].join("\n");
  const { ids, rejected } = videosIn(paste);
  assert.deepEqual(ids, [ID, "abcdefghijk"]);
  assert.deepEqual(rejected, ["Some words without a link", "https://www.coursera.org/learn/x"]);
});

test("times as typed: minutes and seconds, or hours too", () => {
  assert.equal(parseTime("1:15"), 75);
  assert.equal(parseTime("0:05"), 5);
  assert.equal(parseTime("1:02:03"), 3723);
  assert.equal(parseTime("12:60"), null);
  assert.equal(parseTime("1:60:00"), null);
  assert.equal(parseTime("75"), null);
  assert.equal(parseTime("x:10"), null);
  assert.equal(parseTime(""), null);
});

test("times as shown", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(75), "1:15");
  assert.equal(formatTime(3723), "1:02:03");
  assert.equal(formatTime(-4), "0:00");
});

test("a typed moment: @time sets its time, anything else is at the current time", () => {
  assert.deepEqual(parseMoment("@1:30 the point"), { at: 90, text: "the point" });
  assert.deepEqual(parseMoment("the point"), { at: null, text: "the point" });
  assert.deepEqual(parseMoment("@ the point"), { at: null, text: "the point" });
  assert.deepEqual(parseMoment("@"), { at: null, text: "" });
  assert.deepEqual(parseMoment("@word note"), { at: null, text: "@word note" });
  assert.deepEqual(parseMoment("  @12:05   spaced  "), { at: 725, text: "spaced" });
});
