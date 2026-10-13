import MiniSearch, { type SearchResult } from "minisearch";
import type { Annotation, Item, ItemType } from "../model";
import { withoutPictures } from "../notes/images";

export interface SearchHit {
  id: string;
  doc: string;
  page: number;
  kind: "page" | "annotation";
  text: string;
  color?: string;
  terms: string[];
  /** How well it matches; higher is better. Hits come best first. */
  score: number;
}

/** Narrow a search to some items: by type, by topic. Unset or empty means any. */
export interface SearchFilter {
  types?: ItemType[];
  topic?: string;
}

/** What the index reads from a folder's database (a ReaderDB). Plain arrays behind toArray work too, as in the tests. */
export interface SearchSource {
  items: { toArray(): Promise<Item[]> };
  annotations: { toArray(): Promise<Annotation[]> };
  pageText: { toArray(): Promise<{ doc: string; page: number; text: string }[]> };
}

/** One indexed thing: an item (its title, topics, your words and saved text), a highlight or note, or a PDF page. */
interface Entry {
  id: string;
  kind: "item" | "annotation" | "page";
  doc: string;
  page: number;
  title?: string;
  topics?: string;
  quote?: string;
  note?: string;
  body?: string;
  content?: string;
  pageText?: string;
}

/**
 * How much a match in each field counts: a title above your highlights, highlights above your
 * notes, notes above the text of the thing itself.
 */
const BOOST = { title: 6, topics: 4, quote: 3, note: 2.5, body: 2, content: 1, pageText: 1 };

/** Highlights, and notes on moments in a video. */
const searchable = (a: Annotation) => !a.deleted && (a.kind === "highlight" || a.kind === "moment") && !!(a.quote?.trim() || a.note?.trim());

/**
 * One folder's search over titles, saved text, PDF pages, highlights and notes, ranked by
 * MiniSearch (word prefixes, small typos forgiven). The index lives in memory: it is built from
 * IndexedDB on first use and brought up to date before each search, indexing again only what
 * changed, so edits that just synced in are found. It costs nothing in GitHub storage.
 */
export class LibrarySearch {
  private ms = new MiniSearch<Entry>({
    fields: Object.keys(BOOST),
    storeFields: ["kind", "doc", "page", "pageText"],
    searchOptions: {
      boost: BOOST,
      prefix: true,
      // Typos are forgiven in longer words only; in short ones they match too much.
      fuzzy: (term) => (term.length > 3 ? 0.2 : false),
      combineWith: "AND",
    },
  });
  /** What each entry was indexed from (its updatedAt), so an unchanged one isn't indexed again. */
  private seen = new Map<string, number>();
  private annotations = new Map<string, Annotation>();
  private pages: Promise<void> | null = null;

  constructor(private db: SearchSource) {}

  private put(entry: Entry, version: number) {
    if (this.seen.get(entry.id) === version) return;
    if (this.ms.has(entry.id)) this.ms.replace(entry);
    else this.ms.add(entry);
    this.seen.set(entry.id, version);
  }

  private drop(id: string) {
    if (this.ms.has(id)) this.ms.discard(id);
    this.seen.delete(id);
  }

  /** PDF page text, read once; pages extracted later come in through addPage. */
  init() {
    this.pages ??= (async () => {
      for (const p of await this.db.pageText.toArray()) if (p.text.trim()) this.put(pageEntry(p.doc, p.page, p.text), 0);
    })();
    return this.pages;
  }

  async addPage(doc: string, page: number, text: string) {
    await this.init();
    const id = `p:${doc}:${page}`;
    this.drop(id);
    if (text.trim()) this.put(pageEntry(doc, page, text), 0);
  }

  /** Bring items and annotations up to date with the database; returns the items not deleted. */
  private async refresh(): Promise<Map<string, Item>> {
    await this.init();
    const [items, annotations] = await Promise.all([this.db.items.toArray(), this.db.annotations.toArray()]);
    const live = new Map(items.filter((i) => !i.deleted).map((i) => [i.id, i]));
    const keep = new Set<string>();
    for (const i of live.values()) {
      const id = `i:${i.id}`;
      keep.add(id);
      const entry: Entry = {
        id,
        kind: "item",
        doc: i.id,
        page: 0,
        title: i.title,
        topics: (i.topics ?? []).join(", "),
        body: i.body ? withoutPictures(i.body) : undefined,
        // A PDF's words are on its pages.
        content: i.type === "pdf" ? undefined : i.content,
      };
      this.put(entry, i.updatedAt);
    }
    for (const a of annotations) {
      if (!searchable(a) || !live.has(a.doc)) continue;
      const id = `a:${a.id}`;
      keep.add(id);
      this.put({ id, kind: "annotation", doc: a.doc, page: a.page, quote: a.quote, note: a.note }, a.updatedAt);
    }
    for (const id of [...this.seen.keys()]) if (!id.startsWith("p:") && !keep.has(id)) this.drop(id);
    this.annotations = new Map(annotations.map((a) => [a.id, a]));
    return live;
  }

  /** The best `limit` matches, best first, among the items `filter` lets through. Ranked before it is cut. */
  async search(query: string, limit = 40, filter: SearchFilter = {}): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const live = await this.refresh();
    const topic = filter.topic?.toLowerCase();
    const wanted = (d: Item) => (!filter.types?.length || filter.types.includes(d.type)) && (!topic || (d.topics ?? []).some((t) => t.toLowerCase() === topic));

    const out: SearchHit[] = [];
    for (const r of this.ms.search(q)) {
      if (out.length >= limit) break;
      const item = live.get(r.doc as string);
      if (!item || !wanted(item)) continue;
      const hit = this.hit(r, item);
      if (hit) out.push(hit);
    }
    return out;
  }

  private hit(r: SearchResult, item: Item): SearchHit | null {
    const base = { doc: item.id, terms: r.terms, score: r.score };
    if (r.kind === "annotation") {
      const a = this.annotations.get(String(r.id).slice(2));
      if (!a) return null;
      const text = [a.quote, a.note].filter((t) => t?.trim()).join(" — ");
      return { ...base, id: a.id, page: a.page, kind: "annotation", text, color: a.color };
    }
    if (r.kind === "page") return { ...base, id: String(r.id), page: r.page as number, kind: "page", text: (r.pageText as string) ?? "" };
    // An item: show the field the words were found in, your own words first.
    const fields = new Set(Object.values(r.match).flat());
    const body = item.body ? withoutPictures(item.body) : "";
    const text =
      (fields.has("body") && body) || (fields.has("content") && item.content) || (fields.has("topics") && (item.topics ?? []).join(", ")) || item.title;
    return { ...base, id: `${item.id}:0`, page: 0, kind: "page", text };
  }
}

const pageEntry = (doc: string, page: number, pageText: string): Entry => ({ id: `p:${doc}:${page}`, kind: "page", doc, page, pageText });

/** A short excerpt around the first matching term. */
export function snippet(text: string, terms: string[], radius = 70): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    at = lower.indexOf(t.toLowerCase());
    if (at >= 0) break;
  }
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  if (at < 0) return flat(text.slice(0, radius * 2));
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return (start > 0 ? "…" : "") + flat(text.slice(start, end)) + (end < text.length ? "…" : "");
}
