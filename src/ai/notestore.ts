/*
 * Keeps the AI notes on this device between reloads: writes them to the app's database as they change, and
 * reads them back when the app starts. Writes wait a moment, so a streamed answer is not written on every
 * word, and they are flushed when the page is hidden. Nothing here is synced (see notestate.ts).
 */
import { appDb } from "../db/db";
import { refresh } from "./engine";
import { threadKey, useNotes, type Note } from "./notes";
import { fromNoteRecord, fromThreadRecord, plan, toNoteRecord, toThreadRecord, type NoteRecord, type ThreadRecord } from "./notestate";
import { useThreads, type Thread } from "./thread";

const SAVE_DELAY_MS = 300;

/** False until the stored notes are read back. Until then nothing is written, so an empty start cannot erase them. */
let restored = false;
/** What the database holds, by id. It moves on only when a write has committed, so a failed write is tried again. */
let stored = { notes: new Map<string, string>(), threads: new Map<string, string>() };
let timer: ReturnType<typeof setTimeout> | undefined;

/** Only a note's own thread is kept. An Ask dialog's thread is keyed by its item, and is not kept. */
function noteThreads(notes: Note[], threads: Record<string, Thread>): [string, Thread][] {
  const keys = new Set(notes.map(threadKey));
  return Object.entries(threads).filter(([k]) => keys.has(k));
}

function save(): void {
  if (!restored) return;
  const notes = useNotes.getState().notes;
  const next = { notes: new Map(stored.notes), threads: new Map(stored.threads) };
  const n = plan(next.notes, new Map(notes.map((x) => [x.id, toNoteRecord(x)])));
  const t = plan(next.threads, new Map(noteThreads(notes, useThreads.getState().threads).map(([k, v]) => [k, toThreadRecord(k, v)])));
  if (!n.put.length && !n.remove.length && !t.put.length && !t.remove.length) return;
  void appDb
    .transaction("rw", appDb.aiNotes, appDb.aiThreads, async () => {
      await appDb.aiNotes.bulkPut(n.put.map(([, r]) => r as NoteRecord));
      await appDb.aiNotes.bulkDelete(n.remove);
      await appDb.aiThreads.bulkPut(t.put.map(([, r]) => r as ThreadRecord));
      await appDb.aiThreads.bulkDelete(t.remove);
    })
    .then(() => {
      stored = next;
    })
    .catch(() => {
      // Nothing is marked as written, so the next change writes the difference again, removals included.
      console.error("Engram: couldn't keep the AI notes.");
    });
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(save, SAVE_DELAY_MS);
}

useNotes.subscribe(schedule);
useThreads.subscribe(schedule);
window.addEventListener("pagehide", () => {
  clearTimeout(timer);
  save();
});

/**
 * Reads the notes kept on this device back in, and drops any thread that no note belongs to. Then it checks the
 * model, so a note whose question is waiting knows whether the model is already here.
 */
export async function restoreAiNotes(): Promise<void> {
  let notes: NoteRecord[];
  let threads: ThreadRecord[];
  try {
    [notes, threads] = await Promise.all([appDb.aiNotes.toArray(), appDb.aiThreads.toArray()]);
  } catch {
    console.error("Engram: couldn't read the AI notes.");
    return;
  }
  const noteKeys = new Set(notes.map((r) => threadKey(r)));
  const withTurns = new Set(threads.filter((t) => noteKeys.has(t.key) && t.turns.length > 0).map((t) => t.key));
  useThreads.setState({ threads: Object.fromEntries(threads.filter((t) => noteKeys.has(t.key)).map((t) => fromThreadRecord(t))) });
  useNotes.setState({ notes: notes.map((r) => fromNoteRecord(r, withTurns.has(threadKey(r)))), active: null });
  // Threads kept for no note (a note removed while its thread was being written) are removed from the database.
  const orphans = threads.filter((t) => !noteKeys.has(t.key)).map((t) => t.key);
  if (orphans.length) void appDb.aiThreads.bulkDelete(orphans).catch(() => {});
  restored = true;
  // Writes what the restore changed, such as an answer that was cut off by the reload.
  save();
  await refresh().catch(() => {});
}
