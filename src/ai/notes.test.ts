import { test } from "node:test";
import assert from "node:assert/strict";
import { useAiStatus } from "./engine";
import { NO_WEBGPU, addNote, dropWaiting, env, followUp, notesOf, removeNote, setItemContext, stopNote, threadKey, useNotes } from "./notes";
import { clearAllThreads, threadOf } from "./thread";
import { turnContext, type Generate } from "./turn";

const article = ["# Rivers", "", "The Nile runs north through Egypt.", "", "The Amazon carries more water than any other river."].join("\n");

/** Each test starts with no notes and a model in the given phase, answering with `text`. */
function setup(phase: "ready" | "absent" | "unsupported", text = "The Nile runs north [¶2].") {
  clearAllThreads();
  useNotes.setState({ notes: [], active: null });
  useAiStatus.setState({ phase, progress: undefined, message: undefined });
  setItemContext("i1", turnContext({ key: "i1", title: "Rivers", text: article, article: { markdown: true } }));
  const prompts: string[] = [];
  const generate: Generate = async (prompt, onToken) => {
    prompts.push(prompt);
    onToken(text);
    return { text, tokens: 200, cancelled: false, threadEnded: false };
  };
  // The device check leaves the phase the test set.
  env.generate = generate;
  env.refresh = async () => {};
  return prompts;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("a question asked beside a passage is answered in its own thread", async () => {
  const prompts = setup("ready");
  const id = addNote({ item: "i1", action: "ask", para: 2, question: "Which way does the Nile run?" });
  await settle();
  const note = useNotes.getState().notes[0];
  assert.equal(note.pending, null);
  assert.equal(note.error, null);
  assert.match(prompts[0], /Which way does the Nile run\?/);
  assert.equal(threadOf(threadKey({ item: "i1", id })).turns[0].answer, "The Nile runs north [¶2].");
  assert.equal(useNotes.getState().active, id);
});

test("an action on a selection explains that selection", async () => {
  const prompts = setup("ready", "It flows toward the sea.");
  const id = addNote({ item: "i1", action: "explain", para: 2, quote: "runs north", sentence: "The Nile runs north through Egypt." });
  await settle();
  assert.match(prompts[0], /runs north/);
  assert.equal(threadOf(threadKey({ item: "i1", id })).turns[0].question, "Explain: “runs north”");
});

test("a follow-up continues the same note's thread", async () => {
  const prompts = setup("ready");
  const id = addNote({ item: "i1", action: "ask", para: 1, question: "Nile" });
  await settle();
  followUp(id, "And the Amazon?");
  await settle();
  assert.equal(threadOf(threadKey({ item: "i1", id })).turns.length, 2);
  assert.match(prompts[1], /follow-up/);
  followUp(id, "   ");
  await settle();
  assert.equal(prompts.length, 2, "a blank question asks nothing");
});

test("two notes keep separate threads", async () => {
  setup("ready");
  const a = addNote({ item: "i1", action: "ask", para: 1, question: "Nile" });
  const b = addNote({ item: "i1", action: "ask", para: 2, question: "Amazon" });
  await settle();
  assert.equal(threadOf(threadKey({ item: "i1", id: a })).turns.length, 1);
  assert.equal(threadOf(threadKey({ item: "i1", id: b })).turns.length, 1);
  assert.equal(notesOf(useNotes.getState().notes, "i1").length, 2);
  assert.equal(notesOf(useNotes.getState().notes, "other").length, 0);
});

test("without the model a note waits, and answers by itself once the reader's download finishes", async () => {
  const prompts = setup("absent");
  addNote({ item: "i1", action: "ask", para: 1, question: "Which way does the Nile run?" });
  await settle();
  const waiting = useNotes.getState().notes[0];
  assert.equal(prompts.length, 0, "nothing runs without the model");
  assert.equal(waiting.waiting?.kind, "ask");
  assert.equal(waiting.pending, null);
  // The reader downloads from the note: the engine goes downloading, then ready.
  useAiStatus.setState({ phase: "downloading" });
  useAiStatus.setState({ phase: "ready" });
  await settle();
  const done = useNotes.getState().notes[0];
  assert.equal(done.waiting, null);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Which way does the Nile run\?/);
});

test("a stopped or failed download leaves the question waiting", async () => {
  const prompts = setup("absent");
  addNote({ item: "i1", action: "summary", para: 1 });
  await settle();
  useAiStatus.setState({ phase: "downloading" });
  useAiStatus.setState({ phase: "absent" });
  await settle();
  assert.equal(prompts.length, 0);
  assert.equal(useNotes.getState().notes[0].waiting?.kind, "summary");
});

test("a waiting question can be taken back", async () => {
  setup("absent");
  const id = addNote({ item: "i1", action: "ask", para: 1, question: "Nile" });
  await settle();
  dropWaiting(id);
  assert.equal(useNotes.getState().notes[0].waiting, null);
});

test("on a device without WebGPU the note says so and keeps nothing waiting", async () => {
  setup("unsupported");
  addNote({ item: "i1", action: "ask", para: 1, question: "Nile" });
  await settle();
  const note = useNotes.getState().notes[0];
  assert.equal(note.error, NO_WEBGPU);
  assert.equal(note.waiting, null);
});

test("stopping keeps the words so far in the note's thread", async () => {
  setup("ready");
  env.generate = async (_prompt, onToken, signal) => {
    onToken("The Nile ");
    await new Promise((r) => signal?.addEventListener("abort", r));
    return { text: "The Nile ", tokens: 0, cancelled: true, threadEnded: true };
  };
  const id = addNote({ item: "i1", action: "ask", para: 1, question: "Nile" });
  await settle();
  assert.equal(useNotes.getState().notes[0].pending?.text, "The Nile ");
  stopNote(id);
  await settle();
  const t = threadOf(threadKey({ item: "i1", id }));
  assert.equal(t.turns[0].stopped, true);
  assert.equal(useNotes.getState().notes[0].pending, null);
});

test("a note over an article whose text was never given says so instead of doing nothing", async () => {
  const prompts = setup("ready");
  addNote({ item: "unknown-item", action: "ask", para: 1, question: "Nile" });
  await settle();
  assert.equal(prompts.length, 0);
  assert.match(useNotes.getState().notes[0].error ?? "", /text is not ready/);
});

test("deleting the model clears the notes it wrote, and their threads", async () => {
  setup("ready");
  const a = addNote({ item: "i1", action: "ask", para: 1, question: "Nile" });
  const b = addNote({ item: "i1", action: "explain", para: 2, quote: "runs north", sentence: "s" });
  await settle();
  assert.equal(threadOf(threadKey({ item: "i1", id: a })).turns.length, 1);
  // What removeModel ends with: the engine goes from holding the model to having none.
  useAiStatus.setState({ phase: "absent" });
  assert.equal(useNotes.getState().notes.length, 0);
  assert.equal(useNotes.getState().active, null);
  assert.equal(threadOf(threadKey({ item: "i1", id: a })).turns.length, 0);
  assert.equal(threadOf(threadKey({ item: "i1", id: b })).turns.length, 0);
});

test("deleting the model while an answer is being written stops it", async () => {
  setup("ready");
  let aborted = false;
  env.generate = async (_prompt, onToken, signal) => {
    onToken("The Nile ");
    await new Promise((r) => signal?.addEventListener("abort", r));
    aborted = true;
    return { text: "The Nile ", tokens: 0, cancelled: true, threadEnded: true };
  };
  addNote({ item: "i1", action: "ask", para: 1, question: "Nile" });
  await settle();
  useAiStatus.setState({ phase: "absent" });
  await settle();
  assert.equal(aborted, true);
  assert.equal(useNotes.getState().notes.length, 0);
});

test("a question waiting for the download is not cleared when a download is stopped", async () => {
  setup("absent");
  addNote({ item: "i1", action: "ask", para: 1, question: "Nile" });
  await settle();
  useAiStatus.setState({ phase: "downloading" });
  useAiStatus.setState({ phase: "absent" });
  assert.equal(useNotes.getState().notes.length, 1);
});

test("deleting a note forgets its thread", async () => {
  setup("ready");
  const id = addNote({ item: "i1", action: "ask", para: 1, question: "Nile" });
  await settle();
  removeNote(id);
  assert.equal(useNotes.getState().notes.length, 0);
  assert.equal(useNotes.getState().active, null);
  assert.equal(threadOf(threadKey({ item: "i1", id })).turns.length, 0);
});
