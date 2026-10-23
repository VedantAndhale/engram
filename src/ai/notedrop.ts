/*
 * When an item is deleted for good, or its folder is removed from this device, the AI notes and threads kept for it
 * go too: a note holds the article's own words and the answers written from them.
 */
import { appDb } from "../db/db";
import { stopNote, useNotes } from "./notes";
import { useThreads } from "./thread";

export async function dropItemAiNotes(item: string): Promise<void> {
  const mine = useNotes.getState().notes.filter((n) => n.item === item);
  for (const n of mine) stopNote(n.id);
  useNotes.setState((s) => ({
    notes: s.notes.filter((n) => n.item !== item),
    active: mine.some((n) => n.id === s.active) ? null : s.active,
  }));
  // A note's thread is keyed `${item}:${id}`; an Ask dialog's thread is keyed by the item itself.
  useThreads.setState((s) => ({
    threads: Object.fromEntries(Object.entries(s.threads).filter(([k]) => k !== item && !k.startsWith(`${item}:`))),
  }));
  await appDb.transaction("rw", appDb.aiNotes, appDb.aiThreads, async () => {
    await appDb.aiNotes.where("item").equals(item).delete();
    await appDb.aiThreads.where("key").startsWith(`${item}:`).delete();
    await appDb.aiThreads.delete(item);
  });
}
