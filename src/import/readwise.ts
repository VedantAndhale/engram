import { parseCsv } from "./csv";
import { bookKey } from "./types";
import type { ImportBook, ImportHighlight, ParseResult } from "./types";

export function parseReadwiseCsv(text: string): ParseResult {
  const { rows, warnings } = parseCsv(text);
  // Match by name, not position: Readwise has reordered its columns before.
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const iQuote = header.indexOf("highlight");
  const iTitle = header.indexOf("book title");
  const iAuthor = header.indexOf("book author");
  const iNote = header.indexOf("note");
  const iLocation = header.indexOf("location");
  if (iQuote < 0 || iTitle < 0) throw new Error("This is not a Readwise highlights export.");

  const books = new Map<string, ImportBook>();
  for (const row of rows.slice(1)) {
    const cell = (i: number): string => (i < 0 ? "" : (row[i] ?? "").trim());
    const quote = cell(iQuote);
    if (!quote) continue;

    // A highlight with no title is still worth keeping, so it gets a shared bucket.
    const title = cell(iTitle) || "Untitled";
    const author = cell(iAuthor);
    const key = bookKey(title, author || undefined);
    let book = books.get(key);
    if (!book) {
      book = { source: "readwise", key, title, ...(author ? { author } : {}), highlights: [], notes: [] };
      books.set(key, book);
    }

    const note = cell(iNote);
    const location = cell(iLocation);
    const highlight: ImportHighlight = {
      quote,
      ...(note ? { note } : {}),
      ...(location ? { location } : {}),
    };
    book.highlights.push(highlight);
  }

  return { books: [...books.values()], warnings };
}