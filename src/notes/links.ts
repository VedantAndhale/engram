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

/** Titles linked from some Markdown. */
export function linksIn(text: string | undefined): string[] {
  return text ? [...text.matchAll(WIKI_LINK)].map((m) => m[1].trim()) : [];
}

/** Point every [[link]] to `from` at `to` instead, keeping any |shown text. */
export function retarget(text: string, from: string, to: string): string {
  return text.replace(WIKI_LINK, (whole, title: string, shown?: string) =>
    sameTitle(title, from) ? `[[${to}${shown ? `|${shown}` : ""}]]` : whole,
  );
}
