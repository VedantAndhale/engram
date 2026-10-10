/*
 * Plain-text helpers for [[wiki links]] and dates, shared by the editor and the rest of the app.
 * Kept free of CodeMirror so importing them doesn't pull the editor into the main bundle.
 */

/** [[Title]] or [[Title|shown text]]. */
export const WIKI_LINK = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;

/** Today as YYYY-MM-DD, in local time. */
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A link's target: a title, optionally followed by "#^ref" naming one highlight in it.
 * [[Title#^3f2a9c]] links to that highlight; ![[Title#^3f2a9c]] on its own line shows it.
 */
export function parseTarget(target: string): { title: string; ref?: string } {
  const i = target.indexOf("#");
  if (i < 0) return { title: target.trim() };
  const ref = target.slice(i + 1).replace(/^\^/, "").trim();
  return { title: target.slice(0, i).trim(), ref: ref || undefined };
}

/** The short name a highlight goes by in links: the first six characters of its id. */
export const highlightRef = (id: string) => id.replace(/-/g, "").slice(0, 6);

/** A line that is only an embed: ![[Title]] or ![[Title#^ref]]. */
export const EMBED_LINE = /^\s*!\[\[([^[\]\n|]+)(?:\|[^[\]\n]*)?\]\]\s*$/;

/** Titles linked from some Markdown. */
export function linksIn(text: string | undefined): string[] {
  return text ? [...text.matchAll(WIKI_LINK)].map((m) => parseTarget(m[1]).title) : [];
}

/** Point every [[link]] to `from` at `to` instead, keeping any #^ref and |shown text. */
export function retarget(text: string, from: string, to: string): string {
  return text.replace(WIKI_LINK, (whole, target: string, shown?: string) => {
    const { title } = parseTarget(target);
    if (!sameTitle(title, from)) return whole;
    const hash = target.indexOf("#");
    const rest = hash < 0 ? "" : target.slice(hash).trim();
    return `[[${to}${rest}${shown ? `|${shown}` : ""}]]`;
  });
}

/** What an embed shows: one highlight, or the start of a whole item. */
export interface EmbedData {
  title: string;
  quote?: string;
  note?: string;
  page?: number;
  /** For a whole item: the start of your words, or its first highlight. */
  excerpt?: string;
  /** The link names a highlight that no longer exists. */
  missing?: boolean;
}

/** A highlight offered after "[[Title#". */
export interface HighlightChoice {
  ref: string;
  quote: string;
  page?: number;
}
