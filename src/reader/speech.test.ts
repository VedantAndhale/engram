import { test } from "node:test";
import assert from "node:assert/strict";
import { Speaker, speechChunks, type Clip, type Para, type Synth } from "./speech";

/** A speech engine that records what it was asked and lets a test end each clip by hand. */
function fakeSynth() {
  const spoken: Clip[] = [];
  const log: string[] = [];
  const synth: Synth = {
    speak: (c) => void (spoken.push(c), log.push(`speak:${c.text}`)),
    cancel: () => void log.push("cancel"),
    pause: () => void log.push("pause"),
    resume: () => void log.push("resume"),
  };
  /** The clip being spoken ends. */
  const finish = () => spoken.shift()?.onend?.();
  return { synth, spoken, log, finish };
}

const make = (text: string): Clip => ({ text, onend: null, onerror: null });
const paras: Para[] = [
  { n: 2, text: "First one. Second sentence." },
  { n: 3, text: "   " },
  { n: 5, text: "Last paragraph." },
];

function setup(list = paras) {
  const f = fakeSynth();
  const marks: (number | null)[] = [];
  const states: string[] = [];
  const speaker = new Speaker(f.synth, list, make, { onPara: (n) => marks.push(n), onChange: (s) => states.push(s) });
  return { ...f, marks, states, speaker };
}

test("a paragraph is cut into clips at sentence ends, none longer than the limit", () => {
  assert.deepEqual(speechChunks("One. Two! Three?"), ["One. Two! Three?"]);
  const long = `${"word ".repeat(30).trim()}. ${"more ".repeat(30).trim()}.`;
  const clips = speechChunks(long, 100);
  assert.ok(clips.length >= 3);
  assert.ok(clips.every((c) => c.length <= 100), clips.map((c) => c.length).join(","));
  assert.equal(clips.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "));
});

test("a sentence with no spaces is still cut, and nothing is empty", () => {
  const clips = speechChunks("x".repeat(250), 100);
  assert.deepEqual(clips.map((c) => c.length), [100, 100, 50]);
  assert.deepEqual(speechChunks("   "), []);
});

test("it reads the paragraphs in order, marking each as it starts, and says when it is done", () => {
  const t = setup();
  t.speaker.start(0);
  assert.deepEqual(t.marks, [2]);
  assert.equal(t.states.at(-1), "speaking");
  t.finish(); // the whole of paragraph 2 is one clip
  // The blank paragraph is passed over; the last is read.
  assert.deepEqual(t.marks, [2, 5]);
  t.finish();
  assert.deepEqual(t.marks, [2, 5, null]);
  assert.equal(t.speaker.state, "idle");
});

test("pause and resume reach the engine and the state follows", () => {
  const t = setup();
  t.speaker.start(0);
  t.speaker.pause();
  assert.equal(t.speaker.state, "paused");
  t.speaker.pause();
  assert.equal(t.log.filter((l) => l === "pause").length, 1, "a second pause does nothing");
  t.speaker.resume();
  assert.equal(t.speaker.state, "speaking");
  assert.ok(t.log.includes("resume"));
});

test("skipping goes to the next paragraph, and a clip still queued from before does nothing", () => {
  const t = setup([{ n: 1, text: "A. B." }, { n: 2, text: "C." }]);
  t.speaker.start(0);
  const stale = t.spoken[0];
  t.speaker.next();
  assert.deepEqual(t.marks, [1, 2]);
  stale.onend?.();
  assert.deepEqual(t.marks, [1, 2], "the old clip ending must not move it on");
});

test("stopping silences it, clears the mark, and a late error from the cancelled clip does not restart anything", () => {
  const t = setup();
  t.speaker.start(0);
  const clip = t.spoken[0];
  t.speaker.stop();
  assert.equal(t.speaker.state, "idle");
  assert.equal(t.marks.at(-1), null);
  clip.onerror?.();
  clip.onend?.();
  assert.equal(t.spoken.length, 1, "nothing new was spoken");
});

test("an error in the middle of reading stops it", () => {
  const t = setup();
  t.speaker.start(0);
  t.spoken[0].onerror?.();
  assert.equal(t.speaker.state, "idle");
});

test("nothing to read stays idle", () => {
  const t = setup([]);
  t.speaker.start(0);
  assert.equal(t.speaker.state, "idle");
  assert.equal(t.spoken.length, 0);
});
