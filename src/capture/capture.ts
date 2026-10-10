import { folderCtx } from "../folders/registry";
import { cleanTopic } from "../habit/prefs";
import { HIGHLIGHT_COLORS, type Item, type ItemType } from "../model";
import { createItem, saveAnnotation, updateItem } from "../store/actions";

/*
 * Saving things that aren't PDFs: links, quotes, notes, and pages sent by the bookmarklet or the
 * share sheet. Text from a page is someone else's words: it is kept as plain text, capped, and
 * never put where the app or an agent would treat it as instructions.
 */

const MAX_CONTENT = 100_000;
const MAX_QUOTE = 20_000;
const MAX_TITLE = 300;

/** Kind of thing the quick-add box holds. */
export type CaptureKind = "link" | "quote" | "note";

/** A whole http(s) URL and nothing else, or null. */
export function asUrl(text: string): string | null {
  const t = text.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return null;
  try {
    return new URL(t).href;
  } catch {
    return null;
  }
}

/** The first http(s) URL in some text (share sheets often put the link inside the text). */
export function findUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"]+/i.exec(text);
  return m ? asUrl(m[0].replace(/[).,;!?]+$/, "")) : null;
}

/** Drop tracking parameters and the fragment, so the same page saved twice is one item. */
export function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_|igshid$|ref_src$|si$)/i.test(k)) u.searchParams.delete(k);
    }
    return u.href;
  } catch {
    return url;
  }
}

/** Only http(s) links are ever rendered as links, so a saved "javascript:" URL can't run. */
export function safeHref(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

export function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/** Guess an item's type from its address. */
export function typeForUrl(url: string, contentLength = 0): ItemType {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "bookmark";
  }
  const host = u.hostname.replace(/^(www|mobile|m)\./, "");
  const path = u.pathname;
  if ((host === "x.com" || host === "twitter.com") && /\/status\/\d+/.test(path)) return "tweet";
  if (host === "youtube.com" || host === "youtu.be" || host === "vimeo.com" || host === "tiktok.com") return "video";
  if (/\.pdf$/i.test(path)) return "bookmark";
  if (
    host === "reddit.com" ||
    host === "threads.net" ||
    host === "bsky.app" ||
    host === "news.ycombinator.com" ||
    (host === "linkedin.com" && /^\/(posts|feed)\//.test(path))
  )
    return "post";
  return contentLength > 1500 ? "article" : "bookmark";
}

/** A readable fallback title for a bare link: "example.com/some/page". */
export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, "");
    return (u.hostname.replace(/^www\./, "") + path).slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}

/** First line of some text, as a title. */
export function titleFromText(text: string): string {
  const line = text.trim().split(/\r?\n/)[0].replace(/^#+\s*/, "").trim();
  return line.length > 80 ? `${line.slice(0, 78).trimEnd()}…` : line || "Untitled";
}

/** Plain text from a page: tidy whitespace, cap the size, and defuse anything that looks like file markup. */
function cleanText(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const t = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/<!--/g, "&lt;!--")
    .trim()
    .slice(0, max);
  return t || undefined;
}

const cleanTopics = (topics: string[]) => [...new Set(topics.map(cleanTopic).filter(Boolean))];

const highlightColor = () => localStorage.getItem("reader.hl") ?? HIGHLIGHT_COLORS[0].value;

async function addQuote(folder: string, doc: string, quote: string) {
  await saveAnnotation(folder, { doc, kind: "highlight", page: 0, quote, color: highlightColor() });
}

export interface PageCapture {
  url: string;
  title?: string;
  /** Readable text of the page, from the bookmarklet. */
  text?: string;
  /** What the reader had selected on the page: kept as a highlight. */
  selection?: string;
  type?: ItemType;
  /** Your own words, from the save box. */
  words?: string;
  topics?: string[];
}

export interface SaveResult {
  item: Item;
  /** True when the link was already saved and this filled it in. */
  existed: boolean;
}

/**
 * Save a link or a page. A link already in the folder is filled in instead of saved twice:
 * its text is replaced with the newer copy, a new selection is added as a highlight, and your
 * words are added below the ones already there.
 */
export async function saveLink(folder: string, c: PageCapture): Promise<SaveResult> {
  const { db } = folderCtx(folder);
  const url = cleanUrl(c.url);
  const content = cleanText(c.text, MAX_CONTENT);
  const selection = cleanText(c.selection, MAX_QUOTE);
  const words = c.words?.trim();
  const topics = cleanTopics(c.topics ?? []);
  const title = (cleanText(c.title, MAX_TITLE)?.replace(/\n/g, " ") ?? "") || titleFromUrl(url);

  const existing = await db.items.filter((i) => i.sourceUrl === url && !i.deleted).first();
  if (existing) {
    const patch: Partial<Item> = {};
    if (content && content !== existing.content) patch.content = content;
    if (words) patch.body = existing.body?.trim() ? `${existing.body.trim()}\n\n${words}` : words;
    const merged = cleanTopics([...(existing.topics ?? []), ...topics]);
    if (merged.length !== (existing.topics?.length ?? 0)) patch.topics = merged;
    if (existing.title === titleFromUrl(url) && title !== existing.title) patch.title = title;
    if (c.type && c.type !== existing.type) patch.type = c.type;
    if (Object.keys(patch).length) await updateItem(folder, existing.id, patch, 500);
    if (selection) {
      const quotes = await db.annotations.where("doc").equals(existing.id).toArray();
      if (!quotes.some((a) => !a.deleted && a.quote?.trim() === selection)) await addQuote(folder, existing.id, selection);
    }
    return { item: (await db.items.get(existing.id))!, existed: true };
  }

  const item = await createItem(folder, {
    type: c.type ?? typeForUrl(url, content?.length ?? 0),
    title,
    sourceUrl: url,
    body: words || undefined,
    content,
    topics: topics.length ? topics : undefined,
  });
  if (selection) await addQuote(folder, item.id, selection);
  return { item, existed: false };
}

/** Someone else's words worth keeping. The quote is a highlight, so it comes back in review. */
export async function saveQuote(folder: string, q: { quote: string; source?: string; words?: string; topics?: string[] }): Promise<Item> {
  const quote = cleanText(q.quote, MAX_QUOTE) ?? "";
  const topics = cleanTopics(q.topics ?? []);
  const source = q.source ? asUrl(q.source) : null;
  const item = await createItem(folder, {
    type: "quote",
    title: titleFromText(quote),
    sourceUrl: source ? cleanUrl(source) : undefined,
    body: q.words?.trim() || undefined,
    topics: topics.length ? topics : undefined,
  });
  await addQuote(folder, item.id, quote);
  return item;
}

/** Your own note. The whole text is the body. */
export async function saveNote(folder: string, n: { text: string; topics?: string[] }): Promise<Item> {
  const topics = cleanTopics(n.topics ?? []);
  return createItem(folder, {
    type: "note",
    title: titleFromText(n.text),
    body: n.text.trim(),
    topics: topics.length ? topics : undefined,
  });
}

/** Where an item opens: PDFs in the reader, everything else on its own page. */
export function itemHref(folder: string, item: Pick<Item, "id" | "type">, page?: number): string {
  if (item.type === "pdf") return `#/f/${folder}/doc/${item.id}${page ? `?page=${page}` : ""}`;
  return `#/f/${folder}/item/${item.id}`;
}

export const TYPE_LABELS: Record<ItemType, string> = {
  pdf: "PDF",
  article: "Article",
  post: "Post",
  tweet: "Tweet",
  thread: "Thread",
  bookmark: "Link",
  video: "Video",
  note: "Note",
  quote: "Quote",
};
