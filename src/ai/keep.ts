/*
 * Keeping what the model said. A kept answer is written into the item's own words as plain Markdown, so it
 * syncs with the item and still reads without Engram. It is set apart as a quote and signed by the model,
 * so it is never mistaken for something you wrote. Nothing is kept unless the reader asks.
 */
import type { Note, NoteAction } from "./notes";
import type { Turn } from "./thread";

const LABEL: Record<NoteAction, string> = {
  ask: "Question",
  summary: "Summary",
  explain: "Explain",
  define: "Define",
  simplify: "Simplify",
  counterpoint: "Counterpoint",
};

/** Each line as a Markdown quote; a blank line keeps the quote going. */
const quoted = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

/**
 * The Markdown for `turns` of a note: what it was about, then each question and answer. `model` signs each
 * answer. A note about a selection starts with the selected words and their paragraph.
 */
export function keptBlock(note: Pick<Note, "action" | "anchor" | "question">, turns: Turn[], model: string, title: string): string {
  const whole = !note.anchor.quote;
  const parts: string[] = [`**${LABEL[note.action]}** on “${title}”${whole ? "" : `, ¶${note.anchor.para}`}`];
  if (note.anchor.quote) parts.push(quoted(`“${note.anchor.quote.replace(/\s+/g, " ").trim()}”`));
  turns.forEach((turn, i) => {
    // The first turn of a question note is the question itself; a follow-up is always one.
    const asks = note.action === "ask" || i > 0 || turn.question.startsWith("Q:");
    if (asks && turn.question.trim()) parts.push(`**${turn.question.split("\n\nAbout this passage:")[0].trim()}**`);
    parts.push(`${quoted(turn.answer)}\n>\n> *${model}, on this device${turn.stopped ? ", stopped early" : ""}*`);
  });
  return parts.join("\n\n");
}

/** `block` after what is already there, with a blank line between. */
export function appendKept(body: string, block: string): string {
  const base = body.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}
