/*
 * Turning a model answer into plain text for Copy. The dialog shows the answer as formatted text,
 * so what a reader copies should read as plain words too, not as raw Markdown marks.
 */

/**
 * The one line that stands for an answer in a closed note: its first sentence, without Markdown marks or
 * citations, cut at a word if it runs long. Empty for an empty answer.
 */
export function firstSentence(md: string, max = 150): string {
  // The first paragraph, and in a list only its first item: the sentence must not run on into the next one.
  const plain = (plainAnswer(md).split(/\n\s*\n/)[0] ?? "")
    .split(/\n(?=•|\d+\. )/)[0]
    .replace(/\[(?:Pages?|¶)\s?[\d][\d ,]*\]/g, "")
    .replace(/^•\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(plain)?.[1] ?? plain;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6))}…`;
}

/** The answer with its Markdown marks removed: emphasis, code, headings, list markers and link addresses. */
export function plainAnswer(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](address) keeps the text
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "") // heading marks
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ") // bullets
    .replace(/^[ \t]*(\d+)[.)][ \t]+/gm, "$1. ") // numbered items keep their numbers
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/(\*|_)(.+?)\1/g, "$2") // italics
    .replace(/`([^`]+)`/g, "$1") // code
    .replace(/~~(.+?)~~/g, "$1") // strikethrough
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
