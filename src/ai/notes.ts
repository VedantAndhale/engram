/*
 * The AI notes beside a saved article. Each note is one thread: a question or action on a passage, its
 * answer, and the follow-ups under it. A note's thread key is `${item}:${id}`, so the engine keeps one
 * conversation per note. Notes live in memory and clear when the page reloads, as threads do.
 *
 * A note asked before the model is on this device waits. Downloading is the reader's own choice, made
 * from the note; once it finishes, the waiting notes answer without being asked again.
 */
import { create } from "zustand";
import type { QuickAction } from "./dialog";
import { dropThread, generate, refresh, useAiStatus } from "./engine";
import { clearThread } from "./thread";
import { answerTurn, askedOf, withKey, type Generate, type TurnContext, type TurnRequest } from "./turn";

export type NoteAction = "ask" | QuickAction | "summary";

export interface Note {
  id: string;
  item: string;
  action: NoteAction;
  /** Where it sits: the paragraph's number, and the selected words when it is about a selection. */
  anchor: { para: number; quote?: string };
  /** The sentence the selection sits in, for the quick actions. */
  sentence: string;
  /** The first question, for an Ask note. */
  question?: string;
  createdAt: number;
  /** The answer being written. */
  pending: { question: string; text: string } | null;
  /** A request waiting for the model to be downloaded. */
  waiting: TurnRequest | null;
  error: string | null;
}

export const NO_WEBGPU = "This device has no WebGPU, so the model cannot run here. Try a recent Chrome or Edge on a computer with a graphics card.";

interface NotesState {
  notes: Note[];
  /** The note the reader has open, or null. */
  active: string | null;
}

export const useNotes = create<NotesState>(() => ({ notes: [], active: null }));

/** What the notes call: the model and the device check. A test replaces them. */
export const env: { generate: Generate; refresh: () => Promise<void> } = { generate, refresh };

const uid = () => Math.random().toString(36).slice(2, 10);
export const threadKey = (n: Pick<Note, "item" | "id">) => `${n.item}:${n.id}`;

const patch = (id: string, change: Partial<Note> | ((n: Note) => Partial<Note>)) =>
  useNotes.setState((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, ...(typeof change === "function" ? change(n) : change) } : n)) }));

const noteOf = (id: string) => useNotes.getState().notes.find((n) => n.id === id);

/** The passages of each open article, cut once, so every note over it shares them. */
const contexts = new Map<string, TurnContext>();
export function setItemContext(item: string, ctx: TurnContext): void {
  contexts.set(item, ctx);
}

const controllers = new Map<string, AbortController>();

/** The first request of a note. */
function firstRequest(n: Note): TurnRequest {
  if (n.action === "summary") return { kind: "summary" };
  if (n.action === "ask") {
    // A question about a selection carries the selection, so the passages picked are the ones around it.
    const quote = n.anchor.quote;
    const about = quote ? `\n\nAbout this passage: “${quote.length > 300 ? `${quote.slice(0, 300)}…` : quote}”` : "";
    return { kind: "ask", question: `${n.question ?? ""}${about}` };
  }
  return { kind: "quick", action: n.action, selection: n.anchor.quote ?? "", context: n.sentence };
}

/** Start a note and answer it. Returns its id. */
export function addNote(spec: { item: string; action: NoteAction; para: number; quote?: string; sentence?: string; question?: string }): string {
  const note: Note = {
    id: uid(),
    item: spec.item,
    action: spec.action,
    anchor: { para: spec.para, quote: spec.quote },
    sentence: spec.sentence ?? "",
    question: spec.question?.trim() || undefined,
    createdAt: Date.now(),
    pending: null,
    waiting: null,
    error: null,
  };
  useNotes.setState((s) => ({ notes: [...s.notes, note], active: note.id }));
  void run(note.id, firstRequest(note));
  return note.id;
}

/** A follow-up question inside a note. */
export function followUp(id: string, question: string): void {
  const q = question.trim();
  if (q) void run(id, { kind: "ask", question: q });
}

async function run(id: string, req: TurnRequest): Promise<void> {
  const note = noteOf(id);
  if (!note) return;
  const base = contexts.get(note.item);
  if (!base) return patch(id, { error: "This article's text is not ready. Open the article again and try once more." });
  await env.refresh();
  const phase = useAiStatus.getState().phase;
  if (phase === "unsupported") return patch(id, { waiting: null, pending: null, error: NO_WEBGPU });
  // The model is not here yet. The question waits for the reader to choose to download it.
  if (phase === "absent" || phase === "downloading") return patch(id, { waiting: req, pending: null, error: null });
  patch(id, { waiting: null, error: null, pending: { question: askedOf(req), text: "" } });
  const ctl = new AbortController();
  controllers.set(id, ctl);
  const message = await answerTurn(
    withKey(base, threadKey(note)),
    req,
    env.generate,
    (piece) => patch(id, (n) => ({ pending: n.pending && { ...n.pending, text: n.pending.text + piece } })),
    ctl.signal,
  );
  controllers.delete(id);
  patch(id, { pending: null, error: message });
}

/** Ask a note's first request again, after it failed before any answer. */
export function retryNote(id: string): void {
  const note = noteOf(id);
  if (note) void run(id, firstRequest(note));
}

/** Answer every note that was waiting for the model. */
export function runWaiting(): void {
  for (const n of useNotes.getState().notes) if (n.waiting) void run(n.id, n.waiting);
}

/** Forget every note and its thread: the model that wrote them is gone from this device. */
export function clearNotes(): void {
  for (const n of useNotes.getState().notes) {
    stopNote(n.id);
    dropThread(threadKey(n));
    clearThread(threadKey(n));
  }
  useNotes.setState({ notes: [], active: null });
}

let last = useAiStatus.getState().phase;
useAiStatus.subscribe((s) => {
  // The download finished, whoever started it: the notes that waited for it answer now.
  if (last === "downloading" && s.phase === "ready") runWaiting();
  // The model was deleted: the answers it wrote go with it, as the dialog's threads do.
  if ((last === "ready" || last === "loaded" || last === "loading") && s.phase === "absent") clearNotes();
  last = s.phase;
});

/** Stop the answer being written. The words so far stay. */
export function stopNote(id: string): void {
  controllers.get(id)?.abort();
}

/** Take back a request that was waiting for the model. */
export function dropWaiting(id: string): void {
  patch(id, { waiting: null });
}

export function removeNote(id: string): void {
  const note = noteOf(id);
  if (!note) return;
  stopNote(id);
  dropThread(threadKey(note));
  clearThread(threadKey(note));
  useNotes.setState((s) => ({ notes: s.notes.filter((n) => n.id !== id), active: s.active === id ? null : s.active }));
}

export const openNote = (id: string | null) => useNotes.setState({ active: id });

/** The notes of one item, in the order they were made. */
export const notesOf = (notes: Note[], item: string) => notes.filter((n) => n.item === item);
