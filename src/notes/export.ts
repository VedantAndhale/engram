import type { Annotation, Item } from "../model";

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
  const marks = annotations
    .filter((a) => a.kind === "highlight" && !a.deleted && a.quote)
    .sort((x, y) => x.page - y.page || x.createdAt - y.createdAt);
  if (marks.length) {
    out.push("## Highlights", "");
    for (const a of marks) {
      out.push(citation(item, a), "");
      if (a.note?.trim()) out.push(`Note: ${a.note.trim()}`, "");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
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
