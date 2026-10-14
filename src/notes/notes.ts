import type { ReaderDB } from "../db/db";
import { folderCtx } from "../folders/registry";
import type { Annotation, Item } from "../model";
import { createItem, renameItem, setItemBody } from "../store/actions";
import { type EmbedData, type HighlightChoice, highlightRef, linksIn, parseTarget, retarget, sameTitle, today, unescapeTitle, wikiLink } from "./links";

/*
 * Notes link to each other by title, the way Obsidian does: [[Title]] or [[Title|shown text]].
 * Titles are matched without regard to case, within one folder (folders never share notes).
 * A link may also name an item by its id ([[id|shown text]]), which is how two items with the
 * same title are told apart.
 */

/**
 * Which of several items with the same title a link means, the same on every device: one whose
 * title matches exactly (case included) first, then the oldest, then the lowest id.
 */
export function pickByTitle<T extends Pick<Item, "id" | "title" | "addedAt">>(items: T[], title: string): T | undefined {
  const want = title.trim();
  const rank = (i: T) => (i.title.trim() === want ? 0 : 1);
  return items
    .filter((i) => sameTitle(i.title, want))
    .sort((a, b) => rank(a) - rank(b) || a.addedAt - b.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

export async function findByTitle(db: ReaderDB, title: string): Promise<Item | undefined> {
  if (!title.trim()) return undefined;
  // A link written with an item's id names exactly that item.
  const byId = await db.items.get(title.trim());
  if (byId && !byId.deleted) return byId;
  return pickByTitle(await db.items.filter((i) => !i.deleted && sameTitle(i.title, title)).toArray(), title);
}

/**
 * The item a link's target names. An older link written before titles were escaped may hold a
 * raw "#" ([[C# notes]]); when the part before it names nothing, the whole target is tried as a title.
 */
async function findTarget(db: ReaderDB, target: string): Promise<{ item: Item; ref?: string } | undefined> {
  const { title, ref } = parseTarget(target);
  const item = await findByTitle(db, title);
  if (item) return { item, ref };
  const whole = target.includes("#") ? await findByTitle(db, unescapeTitle(target.trim())) : undefined;
  return whole && { item: whole };
}

/** Asked before a link to nothing makes a new note. */
const confirmNew = (title: string) => window.confirm(`Nothing is called “${title}” yet. Make a new note with that title?`);

/**
 * The item a [[link]] names. A link to something that doesn't exist yet makes a new note, once
 * `ask` agrees (pass false when the person already asked for a new note). Null when they decline,
 * or the link has no title: then there is nothing to open.
 */
export async function openOrCreate(
  folder: string,
  target: string,
  ask: ((title: string) => boolean | Promise<boolean>) | false = confirmNew,
): Promise<Item | null> {
  const found = await findTarget(folderCtx(folder).db, target);
  if (found) return found.item;
  const { title } = parseTarget(target);
  if (!title || (ask && !(await ask(title)))) return null;
  return createItem(folder, { type: "note", title });
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
  // Characters a link can't hold ([ ] | #) are escaped by retarget; only a line break can't be kept.
  if (!before || !next || sameTitle(before, next) || /\n/.test(next)) return;
  // Another item still answering to the old title keeps its links.
  if (await findByTitle(db, before)) return;
  for (const note of await backlinks(db, before, id)) {
    const body = retarget(note.body!, before, next);
    if (body !== note.body) await setItemBody(folder, note.id, body);
  }
}

/**
 * Everything in the folder whose own words link to this item: by its id, or by its title when
 * the title leads here (with two items of one title, a link by title leads to only one of them).
 */
export async function backlinks(db: ReaderDB, title: string, exceptId: string): Promise<Item[]> {
  const owner = await findByTitle(db, title);
  const byTitle = !owner || owner.id === exceptId;
  return db.items
    .filter(
      (i) =>
        !i.deleted &&
        i.id !== exceptId &&
        !!i.body?.includes("[[") &&
        linksIn(i.body).some((t) => t === exceptId || (byTitle && sameTitle(t, title))),
    )
    .toArray();
}

async function quotesOf(db: ReaderDB, id: string): Promise<Annotation[]> {
  return (await db.annotations.where("doc").equals(id).toArray())
    .filter((a) => !a.deleted && a.quote?.trim())
    .sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
}

/** The highlights in the item a title names, for linking to one of them. */
export async function highlightsOf(db: ReaderDB, title: string): Promise<HighlightChoice[]> {
  const item = await findByTitle(db, title);
  if (!item) return [];
  return (await quotesOf(db, item.id)).map((a) => ({ ref: highlightRef(a.id), quote: a.quote!.trim(), page: a.page || undefined }));
}

/** The highlight a link's #^ref names, if it's still there. */
export async function findHighlight(db: ReaderDB, itemId: string, ref: string): Promise<Annotation | undefined> {
  return (await quotesOf(db, itemId)).find((a) => highlightRef(a.id) === ref);
}

/** What ![[Title]] or ![[Title#^ref]] shows. Null when nothing has that title. */
export async function resolveEmbed(db: ReaderDB, target: string): Promise<EmbedData | null> {
  const found = await findTarget(db, target);
  if (!found) return null;
  const { item, ref } = found;
  if (ref) {
    const a = await findHighlight(db, item.id, ref);
    return a ? { title: item.title, quote: a.quote!.trim(), note: a.note?.trim() || undefined, page: a.page || undefined } : { title: item.title, missing: true };
  }
  const words = item.body?.trim();
  const excerpt = words ? words.slice(0, 320) + (words.length > 320 ? "…" : "") : (await quotesOf(db, item.id))[0]?.quote?.trim();
  return { title: item.title, excerpt };
}

/** Start a note from a highlight: the quote, where it came from, and room for your thoughts. */
export async function noteFromHighlight(folder: string, source: Item, quote: string, page?: number): Promise<Item> {
  const quoted = quote
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
  const from = `— ${wikiLink(source.title)}${page ? `, page ${page}` : ""}`;
  const first = quote.trim().split(/\s+/).slice(0, 8).join(" ");
  return createItem(folder, {
    type: "note",
    title: `On “${first}${quote.trim().split(/\s+/).length > 8 ? "…" : ""}”`,
    body: `${quoted}\n\n${from}\n\n`,
    topics: source.topics,
  });
}
