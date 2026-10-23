import { folderCtx } from "../folders/registry";
import { cleanTopic } from "../habit/prefs";
import { HIGHLIGHT_COLORS, type Item, type ItemType } from "../model";
import { addPdf, createItem, saveAnnotation, updateItem } from "../store/actions";
import { capText, extractArticle, isoDate, metaText, pdfUrl, shrinks } from "./extract";
import { cleanUrl, typeForUrl } from "./url";
import { externalUrl } from "../lib/util";

export { cleanUrl, typeForUrl };

/*
 * Saving things that aren't PDFs: links, quotes, notes, and pages sent by the bookmarklet or the
 * share sheet. Text from a page is someone else's words: it is kept as Markdown or plain text
 * (never HTML), capped, and never put where the app or an agent would treat it as instructions.
 */

// About a full book. A longer page is kept up to here and marked as cut (see capText).
const MAX_CONTENT = 1_000_000;
const MAX_PDF = 200 * 1024 * 1024;
const MAX_QUOTE = 20_000;
export const MAX_TITLE = 300;

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

/** Only http(s) links are ever rendered as links, so a saved "javascript:" URL can't run. */
export const safeHref = externalUrl;

export function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/** Types whose pages are worth reading in Engram; videos and tweets keep their own sites. */
export const READABLE: ItemType[] = ["article", "bookmark", "post", "thread"];

/** Whether a link's page is fetched in the background after saving (see fetchpage.ts). */
export const fetchedLater = (url: string) => READABLE.includes(typeForUrl(url, 0)) && !isPdfFile(url);

/** A link to a PDF file itself (not an arXiv paper's page): it is downloaded as a PDF or kept as a link, never read as a page. */
export const isPdfFile = (url: string) => !!pdfUrl(url) && !/arxiv\.org\/abs\//i.test(url);

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
export function cleanText(text: string | undefined, max: number): string | undefined {
  return cleanPlain(text)?.slice(0, max).trim() || undefined;
}

/** A page's whole plain text, as cleanText, with a long one cut and marked as cut. */
const plainContent = (text: string | undefined) => {
  const t = cleanPlain(text);
  return t && capText(t, MAX_CONTENT, false);
};

function cleanPlain(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/<!--/g, "&lt;!--")
    .trim();
  return t || undefined;
}

/** An article as Markdown: like cleanText, but indentation (lists, code) is kept. */
export function cleanMarkdown(text: string | undefined, max = MAX_CONTENT): string | undefined {
  if (!text) return undefined;
  const t = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/<!--/g, "\\<!--")
    .trim();
  return t ? capText(t, max, true) : undefined;
}

export const cleanTopics = (topics: string[]) => [...new Set(topics.map(cleanTopic).filter(Boolean))];

const highlightColor = () => localStorage.getItem("reader.hl") ?? HIGHLIGHT_COLORS[0].value;

async function addQuote(folder: string, doc: string, quote: string) {
  await saveAnnotation(folder, { doc, kind: "highlight", page: 0, quote, color: highlightColor() });
}

export interface PageCapture {
  url: string;
  title?: string;
  /** Readable text of the page, from older bookmarklets. */
  text?: string;
  /** The whole page, from the bookmarklet: the article is picked out of it and kept as Markdown. */
  html?: string;
  /** What the reader had selected on the page: kept as a highlight. */
  selection?: string;
  /** The page's own details, from its meta tags (the bookmarklet) or none. */
  author?: string;
  siteName?: string;
  description?: string;
  published?: string;
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

/** What a page says about itself. */
export type PageDetails = Pick<Item, "author" | "siteName" | "description" | "published">;

/** The details an item doesn't have yet. A value the reader or an earlier save set is never replaced. */
export function missingDetails(item: Partial<PageDetails>, found: Partial<PageDetails>): Partial<PageDetails> {
  const out: Partial<PageDetails> = {};
  if (found.author && !item.author) out.author = found.author;
  if (found.siteName && !item.siteName) out.siteName = found.siteName;
  if (found.description && !item.description) out.description = found.description;
  if (found.published && !item.published) out.published = found.published;
  return out;
}

/**
 * Save a link or a page. A link already in the folder is filled in instead of saved twice:
 * its text is replaced with the newer copy, a new selection is added as a highlight, and your
 * words are added below the ones already there.
 */
export async function saveLink(folder: string, c: PageCapture): Promise<SaveResult> {
  const { db } = folderCtx(folder);
  const url = cleanUrl(c.url);
  const article = c.html ? await extractArticle(c.html, c.url).catch(() => null) : null;
  const markdown = cleanMarkdown(article?.markdown);
  const content = markdown ?? plainContent(c.text);
  const contentFormat = markdown ? ("markdown" as const) : undefined;
  const selection = cleanText(c.selection, MAX_QUOTE);
  const words = c.words?.trim();
  const topics = cleanTopics(c.topics ?? []);
  const title = (cleanText(c.title || article?.title, MAX_TITLE)?.replace(/\n/g, " ") ?? "") || titleFromUrl(url);
  // The meta tags the bookmarklet read come first; Readability's guesses fill what they leave out.
  const details: PageDetails = {
    author: metaText(c.author) ?? article?.author,
    siteName: metaText(c.siteName) ?? article?.siteName,
    description: metaText(c.description) ?? article?.description,
    published: isoDate(c.published) ?? article?.published,
  };

  // A quote can carry the page's address as its source. It is a quote, not the page, so it never matches.
  const existing = await db.items.filter((i) => i.sourceUrl === url && i.type !== "quote" && !i.deleted).first();
  if (existing) {
    const patch: Partial<Item> = yours(existing, words, topics);
    // A saved PDF keeps its file; only your words and topics are added to it.
    const page = existing.type !== "pdf";
    // Formatted text is never replaced by plain text from an older bookmarklet, nor a fuller copy by a much
    // shorter one (the page now behind a login or paywall).
    if (page && content && content !== existing.content && !shrinks(content, existing.content)) {
      if (contentFormat || existing.contentFormat !== "markdown") Object.assign(patch, { content, contentFormat });
    }
    if (existing.title === titleFromUrl(url) && title !== existing.title) patch.title = title;
    if (page && c.type && c.type !== existing.type) patch.type = c.type;
    Object.assign(patch, missingDetails(existing, details));
    if (Object.keys(patch).length) await updateItem(folder, existing.id, patch, 500);
    if (page && selection) {
      const quotes = await db.annotations.where("doc").equals(existing.id).toArray();
      if (!quotes.some((a) => !a.deleted && a.quote?.trim() === selection)) await addQuote(folder, existing.id, selection);
    }
    if (!contentFormat) fillLater(folder, existing.id);
    titleLater(folder, existing.id);
    return { item: (await db.items.get(existing.id))!, existed: true };
  }

  // A link to a PDF brings the PDF itself into the library, when its site lets Engram download it. An arXiv
  // page saved with the bookmarklet already brought its article, so it is kept as that.
  const pdf = !contentFormat || isPdfFile(url) ? pdfUrl(url) : null;
  const pdfId = pdf ? await downloadPdf(folder, pdf) : null;
  if (pdfId) return { item: await keepPdf(folder, pdfId, url, words, topics), existed: false };
  const pdfFile = isPdfFile(url);

  const item = await createItem(folder, {
    type: c.type ?? typeForUrl(url, content?.length ?? 0),
    title,
    sourceUrl: url,
    ...details,
    // Said on the card, so a PDF link that couldn't be downloaded isn't left looking like it will fill in.
    description: details.description ?? (pdfFile ? PDF_LINK_NOTE : undefined),
    body: words || undefined,
    content,
    contentFormat,
    topics: topics.length ? topics : undefined,
  });
  if (selection) await addQuote(folder, item.id, selection);
  if (!contentFormat && !pdfFile) fillLater(folder, item.id);
  titleLater(folder, item.id);
  return { item, existed: false };
}

/** Your words and topics added to an item's own. */
function yours(item: Item, words: string | undefined, topics: string[]): Partial<Item> {
  const patch: Partial<Item> = {};
  if (words) patch.body = item.body?.trim() ? `${item.body.trim()}\n\n${words}` : words;
  const merged = cleanTopics([...(item.topics ?? []), ...topics]);
  if (merged.length !== (item.topics?.length ?? 0)) patch.topics = merged;
  return patch;
}

export const PDF_LINK_NOTE = "A link to a PDF. Its site doesn't let Engram download it: save the file, then use Add PDF to read and highlight it here.";

/**
 * Download a PDF into the folder; its id, or null. Most sites don't let another site's page read their files,
 * so this often fails (arXiv allows it), and the link is kept instead.
 */
async function downloadPdf(folder: string, url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok || Number(res.headers.get("content-length")) > MAX_PDF) return null;
    const blob = await res.blob();
    const head = new TextDecoder().decode(await blob.slice(0, 5).arrayBuffer());
    if (blob.size > MAX_PDF || head !== "%PDF-") return null;
    const last = decodeURIComponent(new URL(res.url || url).pathname.split("/").pop() ?? "") || "document";
    const name = /\.pdf$/i.test(last) ? last : `${last}.pdf`;
    return await addPdf(folder, new File([blob], name, { type: "application/pdf" }));
  } catch {
    return null;
  }
}

/** A downloaded PDF keeps the link it came from, and your words and topics. */
async function keepPdf(folder: string, id: string, url: string, words: string | undefined, topics: string[]): Promise<Item> {
  const { db } = folderCtx(folder);
  const item = (await db.items.get(id))!;
  const patch = yours(item, words, topics);
  if (!item.sourceUrl) patch.sourceUrl = url;
  if (Object.keys(patch).length) await updateItem(folder, id, patch, 500);
  return (await db.items.get(id))!;
}

/** Fetch the article in the background when the save didn't bring it (see fetchpage.ts). */
const fillLater = (folder: string, id: string) => void import("./fetchpage").then((m) => m.fillFromWeb(folder, id));

/** Look up a YouTube video's real title in the background, when it has only a stand-in (see video/title.ts). */
const titleLater = (folder: string, id: string) => void import("../video/title").then((m) => m.fillVideoTitle(folder, id));

/** Someone else's words worth keeping. The quote is a highlight, so it comes back in review. */
export async function saveQuote(folder: string, q: { quote: string; source?: string; words?: string; topics?: string[] }): Promise<Item> {
  const quote = cleanText(q.quote, MAX_QUOTE) ?? "";
  const topics = cleanTopics(q.topics ?? []);
  // Where the quote is from: a web address is kept as a link, anything else as the reader's words.
  const link = asUrl(q.source ?? "");
  const item = await createItem(folder, {
    type: "quote",
    title: titleFromText(quote),
    sourceUrl: link ? cleanUrl(link) : undefined,
    source: link ? undefined : metaText(q.source)?.slice(0, MAX_TITLE),
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
  playlist: "Playlist",
  book: "Book",
};
