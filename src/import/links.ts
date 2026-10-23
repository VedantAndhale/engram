import { parseCsv } from "./csv";

/** One link from a CSV: where it goes, and what the file says about it. */
export interface LinkRow {
  url: string;
  title: string;
  author?: string;
  publication?: string;
  description?: string;
  topics: string[];
}

export interface LinkParse {
  links: LinkRow[];
  /** Rows left out, and why. */
  warnings: string[];
}

/** A web address a reader can open: http or https, with a host. */
export function isWebAddress(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/** The first column with one of these names, or -1. Matched by name, so the order of columns does not matter. */
const column = (header: string[], ...names: string[]): number => {
  for (const name of names) {
    const i = header.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
};

/**
 * The links in a CSV with a `link` and/or `url` column. Each row takes the first of those columns that holds a
 * web address. The other columns are read when they are there: title, author, publication (or site),
 * description, and topics (separated by semicolons). A row with no web address is left out and reported, and so
 * is a row with more cells than the header, since a stray comma has moved its columns along. The rest are kept
 * in the order of the file.
 */
export function parseLinks(text: string): LinkParse {
  const { rows, warnings } = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const linkColumns = ["link", "url"].map((name) => header.indexOf(name)).filter((i) => i >= 0);
  if (linkColumns.length === 0) throw new Error("This CSV has no link or url column.");
  const iTitle = column(header, "title");
  const iAuthor = column(header, "author");
  const iPublication = column(header, "publication", "site");
  const iDescription = column(header, "description");
  const iTopics = column(header, "topics");

  const links: LinkRow[] = [];
  rows.slice(1).forEach((row, r) => {
    const line = r + 2;
    const cell = (i: number): string => (i < 0 ? "" : (row[i] ?? "").trim());
    // Cells past the header are fine when they are empty (a trailing comma). Text there means the columns moved.
    if (row.slice(header.length).some((c) => c.trim())) {
      warnings.push(`Row ${line} has more fields than the header, so it was left out.`);
      return;
    }
    const url = linkColumns.map(cell).find(isWebAddress);
    if (!url) {
      if (linkColumns.some((i) => cell(i)) || cell(iTitle)) warnings.push(`Row ${line} has no web address, so it was left out.`);
      return;
    }
    links.push({
      url,
      title: cell(iTitle),
      author: cell(iAuthor) || undefined,
      publication: cell(iPublication) || undefined,
      description: cell(iDescription) || undefined,
      topics: cell(iTopics)
        .split(";")
        .map((t) => t.trim())
        .filter(Boolean),
    });
  });
  return { links, warnings };
}
