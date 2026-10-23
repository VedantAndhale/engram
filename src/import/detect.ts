import { parseCsv } from "./csv";

export type Format = "kindle" | "readwise" | "links" | "unknown";

// Only the first 4 KB is read: both formats announce themselves at the top.
const SNIFF_BYTES = 4096;

export function detectFormat(text: string): Format {
  const head = text.slice(0, SNIFF_BYTES).replace(/^\uFEFF/, "");
  if (/^=+\s*$/m.test(head) && /Your (Highlight|Note)/i.test(head)) return "kindle";

  const first = (parseCsv(head).rows[0] ?? []).map((c) => c.trim().toLowerCase());
  if (first.includes("highlight") && first.includes("book title")) return "readwise";
  // A highlights file without Book Title is not a list of links either: the Readwise reader says what is missing.
  if (first.includes("highlight")) return "readwise";
  // Any other CSV with a link or url column is a list of links.
  if (first.includes("link") || first.includes("url")) return "links";
  return "unknown";
}