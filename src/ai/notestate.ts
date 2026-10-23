/*
 * The AI notes beside an article, as they are kept on this device between reloads: the pure rules for what is
 * stored and how it comes back. The database and the timing of writes are in notestore.ts. Nothing here is
 * synced: a note's question, answer and passages stay on this device, as the model's answers always have.
 */
import type { Note } from "./notes";
import type { Thread } from "./thread";

/** A note as it is stored. The answer being written is not stored; only that one was being written (`asking`). */
export interface NoteRecord extends Omit<Note, "pending"> {
  /** The question whose answer was being written when the page reloaded, or null. */
  asking: string | null;
}

/** A thread as it is stored, under its note's key. */
export interface ThreadRecord extends Thread {
  key: string;
}

/** What a note says when the answer it was writing was lost to a reload. */
export const INTERRUPTED = "The answer was cut off when the page reloaded. Ask again.";

export function toNoteRecord(n: Note): NoteRecord {
  const { pending, ...rest } = n;
  return { ...rest, asking: pending?.question ?? null };
}

/**
 * `hasTurns` is whether the note has answers kept with it. A note with no answer, no question waiting and no
 * error was saved in the moment before its request started (a reload during the model check): it says so.
 */
export function fromNoteRecord(r: NoteRecord, hasTurns: boolean): Note {
  const { asking, ...rest } = r;
  const stuck = !asking && !hasTurns && !rest.waiting && !rest.error;
  return { ...rest, pending: null, error: asking || stuck ? INTERRUPTED : rest.error };
}

export function toThreadRecord(key: string, t: Thread): ThreadRecord {
  return { key, ...t };
}

export function fromThreadRecord(r: ThreadRecord): [string, Thread] {
  const { key, ...t } = r;
  // The model's conversation did not survive the reload, so the next question rebuilds it from the turns.
  return [key, { ...t, needsRebuild: t.needsRebuild || t.turns.length > 0 }];
}

/**
 * What to write and what to remove, given the JSON last written for each id and the records now. Records
 * that have not changed are not written again. `written` is updated to match what is now stored.
 */
export function plan(written: Map<string, string>, now: Map<string, unknown>): { put: [string, unknown][]; remove: string[] } {
  const put: [string, unknown][] = [];
  for (const [id, record] of now) {
    const json = JSON.stringify(record);
    if (written.get(id) !== json) {
      put.push([id, record]);
      written.set(id, json);
    }
  }
  const remove: string[] = [];
  for (const id of [...written.keys()]) {
    if (!now.has(id)) {
      remove.push(id);
      written.delete(id);
    }
  }
  return { put, remove };
}
