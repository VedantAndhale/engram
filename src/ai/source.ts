/*
 * The text the AI features read for an item. A PDF's text is stored page by page on this device
 * (see indexDocument in store/actions.ts); everything else is the text saved with the item.
 */
import type { PageTextRow } from "../db/db";
import type { Item } from "../model";
import { plainAnswer } from "./format";

/** The saved text of an item that is not a PDF: what was saved from the source, else your words, else its description. */
export function savedText(item: Item): string {
  return item.content?.trim() || item.body?.trim() || item.description?.trim() || "";
}

/**
 * The sentence a selection sits in, found in the item's text with its Markdown marks removed.
 * Empty when the selection cannot be found there, for example in a PDF or after an edit.
 */
export function sentenceAround(body: string, selection: string): string {
  const flat = plainAnswer(body).replace(/\s+/g, " ");
  const sel = selection.replace(/\s+/g, " ").trim();
  if (!sel || !flat) return "";
  const at = flat.indexOf(sel);
  if (at < 0) return "";
  const before = flat.slice(0, at);
  // The sentence starts after the last ". ", "? " or "! ", or at the top of the text when there is none.
  const starts = [". ", "? ", "! "].map((mark) => {
    const i = before.lastIndexOf(mark);
    return i < 0 ? 0 : i + 2;
  });
  const start = Math.max(...starts);
  const after = flat.slice(at + sel.length);
  const endMatch = /[.!?](\s|$)/.exec(after);
  const end = endMatch ? at + sel.length + endMatch.index + 1 : flat.length;
  return flat.slice(start, end).trim().slice(0, 400);
}

/**
 * One block per page with text, marked with its page number so an answer can point at its page.
 * Blank pages are skipped. Pages come out in order whatever order the rows arrived in.
 */
export function pageBlocks(rows: PageTextRow[]): string {
  return [...rows]
    .sort((a, b) => a.page - b.page)
    .filter((r) => r.text.trim())
    .map((r) => `[Page ${r.page}]\n${r.text.trim()}`)
    .join("\n\n");
}
