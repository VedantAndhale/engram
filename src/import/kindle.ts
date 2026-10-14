import { bookKey } from "./types";
import type { ImportBook, ImportHighlight, ParseResult } from "./types";

const MAX_WARNINGS = 50;
const TITLE_LINE = /^(.*)\s\(([^()]*)\)\s*$/;
const LOCATION = /location\s+([0-9]+(?:-[0-9]+)?)/i;

interface Clip {
  text: string;
  location?: string;
  start?: number;
  end?: number;
  order: number;
}

interface Group {
  key: string;
  title: string;
  author?: string;
  highlights: Clip[];
  notes: Clip[];
}

// Titles can hold parentheses, so only the LAST group at the end is the author.
function splitTitle(line: string): { title: string; author?: string } {
  const m = TITLE_LINE.exec(line);
  if (!m) return { title: line };
  const title = (m[1] ?? "").trim();
  const author = (m[2] ?? "").trim();
  if (!title) return { title: line };
  return author ? { title, author } : { title };
}

function parseLocation(meta: string): Pick<Clip, "location" | "start" | "end"> {
  const m = LOCATION.exec(meta);
  if (!m || !m[1]) return {};
  const [a, b] = m[1].split("-").map(Number);
  return { location: m[1], start: a, end: b ?? a };
}

// Kindle writes a new clip every time a highlight is extended, and one per edit of a note.
function finish(g: Group): ImportBook {
  const seen = new Set<string>();
  const unique: Clip[] = [];
  for (const c of g.highlights) {
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    unique.push(c);
  }
  // Texts are distinct now, so "contained in another" means strictly shorter: keep the longer.
  const kept = unique.filter((c) => !unique.some((o) => o !== c && o.text.includes(c.text)));
  // Clips without a location go last, in file order, so the sort stays consistent.
  kept.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.order - b.order);

  const highlights: ImportHighlight[] = kept.map((c) => ({
    quote: c.text,
    ...(c.location ? { location: c.location } : {}),
  }));

  const notes: string[] = [];
  const doneNotes = new Set<string>();
  for (const n of g.notes) {
    if (doneNotes.has(n.text)) continue;
    doneNotes.add(n.text);
    const at = n.start;
    const i =
      at === undefined
        ? -1
        : kept.findIndex((h) => h.start !== undefined && h.end !== undefined && h.start <= at && at <= h.end);
    const target = i >= 0 ? highlights[i] : undefined;
    if (target) target.note = target.note ? `${target.note}\n\n${n.text}` : n.text;
    else notes.push(n.text);
  }

  return {
    source: "kindle",
    key: g.key,
    title: g.title,
    ...(g.author ? { author: g.author } : {}),
    highlights,
    notes,
  };
}

export function parseKindle(text: string): ParseResult {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const groups = new Map<string, Group>();
  const warnings: string[] = [];
  let entryNo = 0;
  let order = 0;

  for (const raw of src.split(/^=+\s*$/m)) {
    const entry = raw.trim();
    if (!entry) continue;
    entryNo++;

    const lines = entry.split("\n");
    const meta = (lines[1] ?? "").trim();
    const kind = /^- your (highlight|note|bookmark)/i.exec(meta)?.[1]?.toLowerCase();
    if (!kind) {
      // Other languages use other labels; say so rather than silently losing clips.
      if (meta.startsWith("- ") && warnings.length < MAX_WARNINGS) {
        warnings.push(`Skipped a clip in an unsupported language at entry ${entryNo}`);
      }
      continue;
    }
    if (kind === "bookmark") continue;

    const rest = lines.slice(2);
    const blank = rest.findIndex((l) => l.trim() === "");
    const body = blank < 0 ? "" : rest.slice(blank + 1).join("\n").trim();
    if (!body) continue;

    const { title, author } = splitTitle((lines[0] ?? "").trim());
    const key = bookKey(title, author);
    let group = groups.get(key);
    if (!group) {
      group = { key, title, ...(author ? { author } : {}), highlights: [], notes: [] };
      groups.set(key, group);
    }
    const clip: Clip = { text: body, ...parseLocation(meta), order: order++ };
    (kind === "note" ? group.notes : group.highlights).push(clip);
  }

  // A Map keeps insertion order, which is the order books were first seen.
  return { books: [...groups.values()].map(finish), warnings };
}