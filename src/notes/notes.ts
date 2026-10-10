import type { ReaderDB } from "../db/db";
import { folderCtx } from "../folders/registry";
import type { Item } from "../model";
import { createItem, renameItem, setItemBody } from "../store/actions";
import { linksIn, retarget, sameTitle, today } from "./links";

/*
 * Notes link to each other by title, the way Obsidian does: [[Title]] or [[Title|shown text]].
 * Titles are matched without regard to case, within one folder (folders never share notes).
 */

export async function findByTitle(db: ReaderDB, title: string): Promise<Item | undefined> {
  return db.items.filter((i) => !i.deleted && sameTitle(i.title, title)).first();
}

/** The item a [[link]] names. A link to something that doesn't exist yet makes a new note. */
export async function openOrCreate(folder: string, title: string): Promise<Item> {
  const found = await findByTitle(folderCtx(folder).db, title);
  return found ?? createItem(folder, { type: "note", title: title.trim() });
}

/** Today's note, made on first use. Its id is the date, so two devices make the same one. */
export async function dailyNote(folder: string): Promise<Item> {
  const date = today();
  const id = `daily-${date}`;
  const existing = await folderCtx(folder).db.items.get(id);
  if (existing && !existing.deleted) return existing;
  if (existing) {
    await folderCtx(folder).db.items.update(id, { deleted: undefined, updatedAt: Date.now() });
    return (await folderCtx(folder).db.items.get(id))!;
  }
  return createItem(folder, { type: "note", title: date }, id);
}

/**
 * Rename an item and point every [[link]] to its old title at the new one, so renaming never
 * breaks a link. Each changed note is saved (and synced) like any other edit.
 */
export async function renameWithLinks(folder: string, id: string, title: string): Promise<void> {
  const { db } = folderCtx(folder);
  const before = (await db.items.get(id))?.title;
  const next = title.trim();
  await renameItem(folder, id, next);
  // A title with [ ] | in it can't be written inside a link; leave links alone rather than break them.
  if (!before || !next || sameTitle(before, next) || /[[\]|\n]/.test(next)) return;
  // Another item still answering to the old title keeps its links.
  if (await findByTitle(db, before)) return;
  for (const note of await backlinks(db, before, id)) {
    const body = retarget(note.body!, before, next);
    if (body !== note.body) await setItemBody(folder, note.id, body);
  }
}

/** Everything in the folder whose own words link to this title. */
export async function backlinks(db: ReaderDB, title: string, exceptId: string): Promise<Item[]> {
  return db.items
    .filter((i) => !i.deleted && i.id !== exceptId && !!i.body?.includes("[[") && linksIn(i.body).some((t) => sameTitle(t, title)))
    .toArray();
}

/** Start a note from a highlight: the quote, where it came from, and room for your thoughts. */
export async function noteFromHighlight(folder: string, source: Item, quote: string, page?: number): Promise<Item> {
  const quoted = quote
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
  const from = `— [[${source.title}]]${page ? `, page ${page}` : ""}`;
  const first = quote.trim().split(/\s+/).slice(0, 8).join(" ");
  return createItem(folder, {
    type: "note",
    title: `On “${first}${quote.trim().split(/\s+/).length > 8 ? "…" : ""}”`,
    body: `${quoted}\n\n${from}\n\n`,
    topics: source.topics,
  });
}
