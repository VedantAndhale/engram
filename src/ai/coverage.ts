/*
 * Telling the reader how much of an item an answer was based on. The app writes this line itself,
 * from the lengths it cut, so it is true whatever the model says. The model is also told the same
 * facts, so it can hedge, but the line under the answer does not depend on it.
 */
import type { CiteKind } from "../reader/paragraphs";
import type { Picked } from "./chunks";

export type Coverage =
  | { kind: "summary"; used: number; total: number }
  | { kind: "explain"; used: number; total: number }
  /** Two passages compared: each one's used and total characters. */
  | { kind: "compare"; first: { used: number; total: number }; second: { used: number; total: number } }
  | { kind: "ask"; picked: Picked; pages: number[]; cite?: CiteKind };

/** The PDF pages named by the [Page n] labels in the passages sent, in order, without repeats. */
export function pagesIn(passages: string[]): number[] {
  const pages = new Set<number>();
  for (const p of passages) for (const m of p.matchAll(/\[Page (\d+)\]/g)) pages.add(Number(m[1]));
  return [...pages].sort((a, b) => a - b);
}

const n = (x: number) => x.toLocaleString("en-GB");

/** Numbers as a short list: a run of three or more becomes a range, so 1, 2, 3, 4 reads as 1–4. */
export function numberList(ns: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < ns.length; ) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    parts.push(j - i >= 2 ? `${ns[i]}–${ns[j]}` : ns.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  return parts.join(", ");
}

/** The plain line shown under an answer, or null when the answer used the whole text. */
export function coverageLine(c: Coverage): string | null {
  if (c.kind === "summary" || c.kind === "explain") {
    if (c.used >= c.total) return null;
    return c.kind === "summary"
      ? `Covers the first ${n(c.used)} of ${n(c.total)} characters of this item. The rest was not used.`
      : `Only the first ${n(c.used)} of ${n(c.total)} characters of your selection were used.`;
  }
  if (c.kind === "compare") {
    const part = (p: { used: number; total: number }, which: string) => (p.used < p.total ? `${n(p.used)} of ${n(p.total)} characters of the ${which} passage` : null);
    const cut = [part(c.first, "first"), part(c.second, "second")].filter(Boolean);
    if (cut.length === 0) return null;
    return `Only ${cut.join(" and ")} were compared.`;
  }
  const { picked, pages, cite } = c;
  if (picked.sent === 0) return "No new passage of this item matched, so the passages earlier in this thread still stand.";
  if (picked.fallback) return "No passage matched your question, so these are the opening passages.";
  // Every passage was sent: nothing was left out, whatever the joined character count says.
  if (picked.sent >= picked.passages) return null;
  const where = pages.length ? ` (${cite === "para" ? "paragraphs" : "pages"} ${numberList(pages)})` : "";
  return `Based on ${picked.sent} of ${picked.passages} passages${where}, about ${n(picked.usedChars)} of ${n(picked.totalChars)} characters. The rest of this item was not used.`;
}

/** The paragraph numbers ([¶n]) in the passages sent, in order, without repeats. */
export function paragraphsIn(passages: string[]): number[] {
  const numbers = new Set<number>();
  for (const p of passages) for (const m of p.matchAll(/\[¶(\d+)\]/g)) numbers.add(Number(m[1]));
  return [...numbers].sort((a, b) => a - b);
}

/** The numbers an answer's citations can name: the PDF pages, or the article's paragraphs, in the passages. */
export function labelsIn(passages: string[], kind: CiteKind): number[] {
  return kind === "page" ? pagesIn(passages) : paragraphsIn(passages);
}
