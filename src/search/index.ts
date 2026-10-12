import MiniSearch from "minisearch";
import type { ReaderDB } from "../db/db";
import type { Item } from "../model";

export interface SearchHit {
  id: string;
  doc: string;
  page: number;
  kind: "page" | "annotation";
  text: string;
  color?: string;
  terms: string[];
}

interface PageEntry {
  id: string;
  doc: string;
  page: number;
  text: string;
}

/**
 * One folder's search over page text, highlights and notes. The page index lives in memory
 * and is rebuilt from IndexedDB on start, so it costs nothing in GitHub storage.
 */
export class LibrarySearch {
  private ms = new MiniSearch<PageEntry>({
    fields: ["text"],
    storeFields: ["doc", "page", "text"],
    searchOptions: { prefix: true, fuzzy: 0.15, combineWith: "AND" },
  });
  private ready: Promise<void> | null = null;

  constructor(private db: ReaderDB) {}

  init() {
    this.ready ??= (async () => {
      const pages = await this.db.pageText.toArray();
      this.ms.addAll(pages.map((p) => ({ id: `${p.doc}:${p.page}`, doc: p.doc, page: p.page, text: p.text })));
    })();
    return this.ready;
  }

  async addPage(doc: string, page: number, text: string) {
    await this.init();
    const id = `${doc}:${page}`;
    if (this.ms.has(id)) this.ms.discard(id);
    if (text.trim()) this.ms.add({ id, doc, page, text });
  }

  async search(query: string, limit = 40): Promise<SearchHit[]> {
    await this.init();
    const q = query.trim();
    if (!q) return [];
    const words = q.toLowerCase().split(/\s+/);
    const live = new Set((await this.db.items.filter((d) => !d.deleted).primaryKeys()) as string[]);

    // Highlights and notes are small, so a direct scan is always fresh, including edits that just synced in.
    const annotations = await this.db.annotations
      .filter((a) => {
        if (a.deleted || a.kind !== "highlight" || !live.has(a.doc)) return false;
        const hay = `${a.quote ?? ""} ${a.note ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .limit(limit)
      .toArray();

    // Items that aren't PDFs (links, posts, quotes, notes) have no pages; scan their text directly.
    // Topics are searched on every item, PDFs included, so a topic finds the documents filed under it.
    const items = await this.db.items
      .filter((i) => {
        if (i.deleted) return false;
        const hay = itemText(i).join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .limit(limit)
      .toArray();

    const pages = this.ms
      .search(q)
      .filter((r) => live.has(r.doc))
      .slice(0, limit);

    return [
      ...annotations.map<SearchHit>((a) => ({
        id: a.id,
        doc: a.doc,
        page: a.page,
        kind: "annotation",
        text: [a.quote, a.note].filter(Boolean).join(" — "),
        color: a.color,
        terms: words,
      })),
      ...items.map<SearchHit>((i) => ({
        id: `${i.id}:0`,
        doc: i.id,
        page: 0,
        kind: "page",
        text: itemText(i).find((t) => t && words.some((w) => t.toLowerCase().includes(w))) ?? i.title,
        terms: words,
      })),
      ...pages.map<SearchHit>((r) => ({
        id: r.id,
        doc: r.doc,
        page: r.page,
        kind: "page",
        text: r.text,
        terms: r.terms,
      })),
    ];
  }
}

/** The text an item is searched by. A PDF's words live on its pages, so only its topics are kept here. */
function itemText(i: Item): (string | undefined)[] {
  const topics = (i.topics ?? []).join(", ");
  return i.type === "pdf" ? [topics] : [i.body, i.content, i.title, topics];
}

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


