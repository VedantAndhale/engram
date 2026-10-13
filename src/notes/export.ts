import type { Annotation, Item } from "../model";
import { formatTime } from "../video/youtube";

/** The host a link points at, without "www.": where a saved page came from when nothing better is known. */
function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Where a quote or note came from, on one line: "Author, Title, Site, p. 12". */
export function attribution(item: Item, a?: Annotation): string {
  const title = item.type === "quote" ? undefined : item.title;
  const page = a && a.page > 0 ? `p. ${a.page}` : undefined;
  return [item.author, title, item.siteName ?? item.source ?? hostOf(item.sourceUrl), page].filter(Boolean).join(", ");
}

/** A quote as a Markdown blockquote with its attribution, ready to paste into a note. */
export function citation(item: Item, a?: Annotation): string {
  const quote = (a?.quote ?? item.content ?? item.title).trim();
  const lines = quote.split("\n").map((line) => `> ${line}`);
  const link = item.sourceUrl && item.type !== "pdf" ? `\n>\n> ${item.sourceUrl}` : "";
  return `${lines.join("\n")}\n>\n> — ${attribution(item, a)}${link}`;
}

/** A whole item as Markdown: its title, where it came from, your words, and every highlight with its note. */
export function itemToMarkdown(item: Item, annotations: Annotation[] = []): string {
  const out: string[] = [`# ${item.title}`, ""];
  const meta = [item.author, item.siteName, item.published?.slice(0, 10), item.sourceUrl].filter(Boolean);
  if (meta.length) out.push(meta.join(" · "), "");
  if (item.body?.trim()) out.push(item.body.trim(), "");
  const marks = joinPageParts(annotations.filter((a) => a.kind === "highlight" && !a.deleted && a.quote)).sort((x, y) => x.page - y.page || x.createdAt - y.createdAt);
  if (marks.length) {
    out.push("## Highlights", "");
    for (const a of marks) {
      out.push(citation(item, a), "");
      if (a.note?.trim()) out.push(`Note: ${a.note.trim()}`, "");
    }
  }
  // A video's notes, each at its moment in the video, in order.
  const moments = annotations.filter((a) => a.kind === "moment" && !a.deleted && a.note?.trim()).sort((x, y) => (x.at ?? 0) - (y.at ?? 0) || x.createdAt - y.createdAt);
  if (moments.length) {
    out.push("## Notes", "");
    for (const a of moments) out.push(`- ${momentLink(item, a.at ?? 0)} ${a.note!.trim().replace(/\s*\n\s*/g, " ")}`);
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** A moment as its time, linked to that point of the video when the video has a link. */
function momentLink(item: Item, at: number): string {
  const time = formatTime(at);
  if (!item.sourceUrl) return `**${time}**`;
  try {
    const url = new URL(item.sourceUrl);
    url.searchParams.set("t", `${Math.max(0, Math.floor(at))}s`);
    return `[${time}](${url.href})`;
  } catch {
    return `**${time}**`;
  }
}

/** How close together the parts of one highlight are saved, one per page it runs over. */
const PARTS_WITHIN_MS = 2_000;

/**
 * Highlights as the reader made them: a highlight that runs over a page break is saved as one part
 * per page, and here the parts are one again. A part follows on when it is on the next page of the
 * same document, in the same colour, and was saved straight after. Older copies of such a highlight
 * each hold the whole quote; they are kept once. The first part's id and page stand for the whole.
 */
export function joinPageParts(marks: Annotation[]): Annotation[] {
  const out: Annotation[] = [];
  /** By document: the joined highlight so far, and its latest part. */
  const open = new Map<string, { whole: Annotation; part: Annotation }>();
  for (const a of [...marks].sort((x, y) => x.createdAt - y.createdAt)) {
    const o = open.get(a.doc);
    const follows =
      o && a.page > 0 && a.page === o.part.page + 1 && a.color === o.part.color && a.createdAt - o.part.createdAt <= PARTS_WITHIN_MS && !(o.whole.note?.trim() && a.note?.trim());
    if (o && follows) {
      const quote = a.quote?.trim() ?? "";
      const sofar = o.whole.quote?.trim() ?? "";
      if (quote && !sofar.endsWith(quote)) o.whole.quote = `${sofar} ${quote}`.trim();
      o.whole.note ||= a.note;
      o.part = a;
      continue;
    }
    const whole = { ...a };
    out.push(whole);
    open.set(a.doc, { whole, part: a });
  }
  return out;
}

/** A file name for an item's Markdown: its title with characters Windows and macOS reject removed. */
export function markdownFilename(title: string): string {
  return `${title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "item"}.md`;
}

/** Save text as a Markdown file in the browser. */
export function downloadMarkdown(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
