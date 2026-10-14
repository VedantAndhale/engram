import { itemLocation, type Annotation, type Item, type ItemType, type Location } from "../model.js";
import { highlightRef } from "../notes/links.js";
import { withoutPictures } from "../notes/images.js";

/*
 * index.json: everything an agent searches, in one file per folder, so a search reads one file
 * instead of every item. Rebuilt from the items on each change; never merged (the item files
 * are the truth). Your own words and highlights only: text saved from the source stays in the
 * item files, which keeps the index small and keeps someone else's words out of search results.
 *
 * Imports carry ".js" so the MCP server (plain Node ESM) can load this file as is.
 */

export const INDEX_FORMAT = "engram/index@1";

export interface IndexHighlight {
  /** The #^ref a link to this highlight uses. */
  ref: string;
  quote: string;
  note?: string;
  page?: number;
  created: string;
  /** Next review; absent when never reviewed (then due a day after it was made). */
  due?: string;
  reviews?: number;
}

export interface IndexItem {
  id: string;
  path: string;
  type: ItemType;
  title: string;
  url?: string;
  topics?: string[];
  added: string;
  updated: string;
  /** Your own words about it (the item's Markdown body). */
  words?: string;
  /** Saved text from the source exists in the item file (read_item returns it, marked untrusted). */
  hasContent?: true;
  highlights?: IndexHighlight[];
  /** Where it sits in the library: inbox, later or archive. Unset for daily notes. */
  location?: Location;
  favorite?: true;
}

export interface IndexFile {
  engram: typeof INDEX_FORMAT;
  folder: { id: string; name: string };
  items: IndexItem[];
}

/** Long notes are cut so one item can't swamp the index; read_item has the rest. */
const MAX_WORDS = 20_000;

const iso = (t: number) => new Date(t).toISOString();

export function buildIndex(folder: { id: string; name: string }, items: Item[], annotations: Annotation[]): IndexFile {
  const byItem = new Map<string, Annotation[]>();
  for (const a of annotations) {
    if (a.deleted || a.kind !== "highlight" || !a.quote?.trim()) continue;
    const list = byItem.get(a.doc) ?? [];
    list.push(a);
    byItem.set(a.doc, list);
  }
  const out: IndexItem[] = [];
  for (const it of [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (it.deleted) continue;
    const entry: IndexItem = { id: it.id, path: it.path, type: it.type, title: it.title, added: iso(it.addedAt), updated: iso(it.updatedAt) };
    if (it.sourceUrl) entry.url = it.sourceUrl;
    if (it.topics?.length) entry.topics = it.topics;
    // A picture in a note is its data, which means nothing to a search: it is indexed as a word.
    const words = it.body ? withoutPictures(it.body).trim() : "";
    if (words) entry.words = words.length > MAX_WORDS ? `${words.slice(0, MAX_WORDS)}…` : words;
    if (it.content?.trim()) entry.hasContent = true;
    const location = itemLocation(it);
    if (location) entry.location = location;
    if (it.favorite) entry.favorite = true;
    const hl = (byItem.get(it.id) ?? []).sort((a, b) => a.page - b.page || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    if (hl.length) {
      entry.highlights = hl.map((a) => {
        const h: IndexHighlight = { ref: highlightRef(a.id), quote: a.quote!.trim(), created: iso(a.createdAt) };
        if (a.note?.trim()) h.note = a.note.trim();
        if (a.page > 0) h.page = a.page;
        if (a.review) {
          h.due = iso(a.review.due);
          h.reviews = a.review.count;
        }
        return h;
      });
    }
    out.push(entry);
  }
  return { engram: INDEX_FORMAT, folder: { id: folder.id, name: folder.name }, items: out };
}

/** Stable text, so an unchanged index is the same git blob and isn't uploaded again. */
export const serializeIndex = (index: IndexFile) => JSON.stringify(index) + "\n";

export function parseIndex(text: string): IndexFile | null {
  try {
    const f = JSON.parse(text) as IndexFile;
    return f?.engram === INDEX_FORMAT && Array.isArray(f.items) ? f : null;
  } catch {
    return null;
  }
}
