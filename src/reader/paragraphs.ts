import { GFM, parser } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";

/*
 * The paragraphs of a saved article: the one rule the article view and the model's citations share.
 * They are the top-level blocks of the article's Markdown, in reading order, numbered from 1; a
 * plain-text save is one paragraph per line. So [¶7] in an answer is the seventh block on the page,
 * and the article view puts data-para="7" on that block.
 */

const md = parser.configure(GFM);

/** Marks and parts of a block that are not drawn as blocks of their own. */
export const MARKS = new Set([
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "URL",
  "LinkTitle",
  "LinkLabel",
  "CodeInfo",
  "StrikethroughMark",
  "TableDelimiter",
  "TaskMarker",
  "HTMLTag",
  "Comment",
  "ProcessingInstruction",
]);

/** Blocks the article view draws as nothing: raw HTML, comments, and link definitions. */
const SKIPPED = new Set(["HTMLBlock", "CommentBlock", "LinkReference", "ProcessingInstructionBlock"]);

/** What a citation names in an answer: a PDF's page ([Page 3]), or an article's paragraph ([¶3]). */
export type CiteKind = "page" | "para";

export interface Paragraph {
  /** The number in reading order, from 1. */
  n: number;
  /** The paragraph's Markdown source, or its plain text for a plain-text save. */
  text: string;
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

/** The top-level blocks the article view draws, in reading order. Numbering counts exactly these. */
export function topBlocks(top: SyntaxNode): SyntaxNode[] {
  return children(top).filter((c) => !MARKS.has(c.name) && !SKIPPED.has(c.name));
}

/** The paragraphs of an article, numbered from 1 in reading order. */
export function paragraphsOf(text: string, markdown: boolean): Paragraph[] {
  if (!markdown) {
    return text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((t, i) => ({ n: i + 1, text: t }));
  }
  return topBlocks(md.parse(text).topNode).map((c, i) => ({ n: i + 1, text: text.slice(c.from, c.to).trim() }));
}
