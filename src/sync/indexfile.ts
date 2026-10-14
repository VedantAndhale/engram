import { itemLocation, type Annotation, type Item, type ItemType, type Location } from "../model.js";
import { highlightRef } from "../notes/links.js";
import { withoutPictures } from "../notes/images.js";

/*
 * index.json: everything an agent searches, in one file per folder, so a search reads one file
 * instead of every item. Rebuilt from the items on each change; never merged (the item files
 * are the truth). Your own words and highlights in full, plus only the start of the text saved
 * from the source (so a phrase that appears only in an article can be found). That text is
 * someone else's words: search fences it, and read_item has the whole of it.
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
  /** The start of the saved text, Markdown stripped, for agent search. Someone else's words: never shown unfenced. */
  text?: string;
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
/** Saved text is cut much harder: enough to find an article by its phrasing, not to copy it. */
const MAX_TEXT = 6_000;

const iso = (t: number) => new Date(t).toISOString();

/**
 * Saved Markdown as plain words, for searching: the markers carry no meaning to a search and
 * would split phrases ("**very** good" must still match "very good").
 */
export function plainText(content: string): string {
  return (
    content
      .replace(/\r\n?/g, "\n")
      // Fence lines go, the code inside stays searchable.
      .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gm, "")
      // Images and links keep their words; the address is no use to a search.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/<?https?:\/\/[^\s<>]+>?/g, " ")
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
      .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm, "")
      .replace(/[*~`]+/g, "")
      // Underscores only at a word's edge, so snake_case stays one word.
      .replace(/(^|[\s(\[{"'])_+|_+(?=$|[\s)\]}.,;:!?"'])/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** At most MAX_TEXT characters, backing up to a word end when that costs little. */
function cut(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  const head = text.slice(0, MAX_TEXT);
  const space = head.lastIndexOf(" ");
  return `${(space > MAX_TEXT * 0.8 ? head.slice(0, space) : head).trimEnd()}…`;
}

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
    if (it.content?.trim()) {
      entry.hasContent = true;
      const text = cut(plainText(it.content));
      if (text) entry.text = text;
    }
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