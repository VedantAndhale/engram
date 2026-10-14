export interface ImportHighlight {
  quote: string;
  note?: string;
  location?: string;
}

export interface ImportBook {
  source: "kindle" | "readwise";
  /** key is the stable identity of the book: `${title}|${author ?? ""}` lowercased and whitespace-collapsed. */
  key: string;
  title: string;
  author?: string;
  highlights: ImportHighlight[];
  notes: string[];
}

export interface ParseResult {
  books: ImportBook[];
  warnings: string[];
}

// One rule for both parsers, so the same book from either source gets the same key.
export function bookKey(title: string, author?: string): string {
  const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
  return `${collapse(title)}|${collapse(author ?? "")}`.toLowerCase();
}