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

/*
 * A title can hold characters a link can't: [ and ] end it, | starts the shown text and # starts a
 * highlight ref. In a link those are written %5B %5D %7C %23 (and a % that would read as one of
 * them as %25), and the link shows the title as it is. "C# notes" links as [[C%23 notes|C# notes]].
 */
const ESCAPES: Record<string, string> = { "[": "%5B", "]": "%5D", "|": "%7C", "#": "%23" };
const UNESCAPES: Record<string, string> = { "5B": "[", "5D": "]", "7C": "|", "23": "#", "25": "%" };

/** A title as it is written inside [[ ]]. */
export function escapeTitle(title: string): string {
  return title
    .replace(/\s*\n\s*/g, " ")
    .replace(/%(?=5B|5D|7C|23|25)/gi, "%25")
    .replace(/[[\]|#]/g, (c) => ESCAPES[c]);
}

/** A title read back from inside [[ ]]. */
export function unescapeTitle(text: string): string {
  return text.replace(/%(5B|5D|7C|23|25)/gi, (_m, hex: string) => UNESCAPES[hex.toUpperCase()]);
}

/** What goes between [[ and ]] to link to `title`: the title, escaped, and shown as it reads when escaping changed it. */
export function linkText(title: string, ref?: string): string {
  const clean = title.trim().replace(/\s*\n\s*/g, " ");
  const target = escapeTitle(clean);
  const hash = ref ? `#^${ref}` : "";
  if (target === clean) return `${target}${hash}`;
  // The shown text can't hold [ or ]; those read as round brackets.
  return `${target}${hash}|${clean.replace(/\[/g, "(").replace(/\]/g, ")")}`;
}

/** A whole [[link]] to `title`. */
export const wikiLink = (title: string, ref?: string) => `[[${linkText(title, ref)}]]`;

/**
 * A link's target: a title, optionally followed by "#^ref" naming one highlight in it.
 * [[Title#^3f2a9c]] links to that highlight; ![[Title#^3f2a9c]] on its own line shows it.
 */
export function parseTarget(target: string): { title: string; ref?: string } {
  const i = target.indexOf("#");
  if (i < 0) return { title: unescapeTitle(target.trim()) };
  const ref = target.slice(i + 1).replace(/^\^/, "").trim();
  return { title: unescapeTitle(target.slice(0, i).trim()), ref: ref || undefined };
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
    const { title, ref } = parseTarget(target);
    if (!sameTitle(title, from)) return whole;
    if (shown) {
      const hash = target.indexOf("#");
      const rest = hash < 0 ? "" : target.slice(hash).trim();
      return `[[${escapeTitle(to.trim())}${rest}|${shown}]]`;
    }
    return wikiLink(to, ref);
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
