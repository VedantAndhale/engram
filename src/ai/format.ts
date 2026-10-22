/*
 * Turning a model answer into plain text for Copy. The dialog shows the answer as formatted text,
 * so what a reader copies should read as plain words too, not as raw Markdown marks.
 */

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
