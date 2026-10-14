import { parseCsv } from "./csv";

export type Format = "kindle" | "readwise" | "unknown";

// Only the first 4 KB is read: both formats announce themselves at the top.
const SNIFF_BYTES = 4096;

export function detectFormat(text: string): Format {
  const head = text.slice(0, SNIFF_BYTES).replace(/^\uFEFF/, "");
  if (/^=+\s*$/m.test(head) && /Your (Highlight|Note)/i.test(head)) return "kindle";

  const first = (parseCsv(head).rows[0] ?? []).map((c) => c.trim().toLowerCase());
  if (first.includes("highlight") && first.includes("book title")) return "readwise";
  return "unknown";
}