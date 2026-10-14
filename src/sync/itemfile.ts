import { ITEM_TYPES, LOCATIONS, type Annotation, type Item, type ItemType, type Location } from "../model.js";
import { highlightRef } from "../notes/links.js";
import { pdfPath } from "./paths.js";

/*
 * One item as one Markdown file, readable by people and agents without the app:
 *
 *   ---
 *   engram: "item@1"
 *   id: "…"
 *   type: "pdf"
 *   title: "Deep Work"
 *   …
 *   ---
 *
 *   Your own words about it (the body).
 *
 *   <!-- engram:content … -->
 *   ## Saved from the source
 *   The text saved from the page, if any.
 *
 *   <!-- engram:highlights … -->
 *   ## Highlights
 *   > The quoted text
 *
 *   ^a1b2c3   (the block id Obsidian links to)
 *   …
 *   <!-- engram:annotation {"id":…} -->
 *
 * Front matter values are written as JSON, which is also valid YAML. Each annotation's full
 * record sits in a comment after its readable form. Reading back, the body, the saved text and
 * each highlight's note come from the visible Markdown, so edits made by hand (Obsidian, GitHub)
 * round-trip; everything else comes from the front matter and the comments.
 *
 * Text Engram writes (body, saved text, notes) never contains its own markers: "<!-- engram"
 * followed by ":" or a backslash gets a backslash added, and reading takes it off again. Markers
 * also only count on a line of their own, so saved web text can't end the article early or
 * forge a highlight.
 */

const FORMAT = "item@1";
const MARKER = "<!-- engram:highlights (managed by Engram: write your notes above this line) -->";
const CONTENT_MARKER = "<!-- engram:content (saved from the source; replaced when you save the page again) -->";
const CONTENT_HEADING = "## Saved from the source";

const iso = (ts: number) => new Date(ts).toISOString();

/** JSON that can sit inside an HTML comment: "--" never appears, so "-->" can't either. */
// One line per annotation, and "--" would end the comment early: both are escaped. The two Unicode line
// separators end a line for the parser too, so they are escaped (written as code points, not characters).
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
const BACKSLASH = String.fromCharCode(92);
/** Writes the two Unicode line separators as escapes, so a value stays on one line for the parser. */
const escapeSeparators = (json: string) => json.split(LINE_SEP).join(BACKSLASH + "u2028").split(PARA_SEP).join(BACKSLASH + "u2029");
const commentJson = (value: unknown) =>
  JSON.stringify(value).replace(/--/g, "-\\u002d").split(LINE_SEP).join("\\u2028").split(PARA_SEP).join("\\u2029");

/** Keeps "<!-- engram:" out of free text, reversibly (see the note at the top). */
const escapeMarkers = (text: string) => text.replace(/<!-- engram(?=[:\\])/g, "<!-- engram\\");
const unescapeMarkers = (text: string) => text.replace(/<!-- engram\\(?=[:\\])/g, "<!-- engram");

/** A marker comment on a line of its own: "content", "highlights" or "annotation". */
const markerLine = (name: string, flags = "") => new RegExp(`(?:^|\\n)<!-- engram:${name}\\b([^\\n]*?)-->[ \\t]*(?=\\r?\\n|$)`, flags);

/** Where the first marker line of a kind starts (after the newline before it) and ends, or null. */
function findMarker(text: string, name: string): { start: number; end: number } | null {
  const m = markerLine(name).exec(text);
  if (!m) return null;
  return { start: m.index + (m[0].startsWith("\n") ? 1 : 0), end: m.index + m[0].length };
}

/** Hand-edited files may use Windows line endings; the app's text uses "\n". */
const lf = (text: string) => text.replace(/\r\n/g, "\n");

/** Per-field edit stamps as readable times. */
function editedAt(edited: Record<string, number> | undefined): Record<string, string> | undefined {
  const keys = Object.keys(edited ?? {}).sort();
  if (!keys.length) return undefined;
  return Object.fromEntries(keys.map((k) => [k, iso(edited![k])]));
}

/** A YAML value typed by hand: a JSON value, a flow list like [a, b], or a plain scalar. */
function yamlValue(raw: string): unknown {
  const v = raw.trim();
  try {
    return JSON.parse(v);
  } catch {
    if (v.startsWith("[") && v.endsWith("]")) {
      return v
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    }
    return unquote(v);
  }
}

const unquote = (s: string) => (s.length >= 2 && (s[0] === "'" || s[0] === '"') && s.at(-1) === s[0] ? s.slice(1, -1) : s);

/**
 * The note typed under a highlight in the visible Markdown: the text after its "^ref" line (and
 * its page line). Null when the highlight's visible block isn't there, so the comment's note stands.
 */
function visibleNote(segment: string, a: Annotation): string | null {
  const lines = lf(segment).split("\n");
  const at = lines.findIndex((l) => l.trim() === `^${highlightRef(a.id)}`);
  if (at < 0) return null;
  let rest = lines.slice(at + 1);
  const first = rest.findIndex((l) => l.trim() !== "");
  if (a.page > 0 && first >= 0 && rest[first].trim() === `— page ${a.page}`) rest = rest.slice(first + 1);
  return unescapeMarkers(rest.join("\n").trim());
}

/** Stable output, so identical content always produces the identical git blob. */
export function serializeItem(item: Item, annotations: Annotation[]): string {
  const fm: [string, unknown][] = [
    ["engram", FORMAT],
    ["id", item.id],
    ["type", item.type],
    ["title", item.title],
    // Obsidian finds files by name; the alias lets [[Title]] reach "title-1a2b3c4d.md".
    ["aliases", [item.title]],
    ["source_url", item.sourceUrl],
    ["author", item.author || undefined],
    ["site_name", item.siteName || undefined],
    ["description", item.description || undefined],
    ["published", item.published || undefined],
    ["source", item.source || undefined],
    ["content_format", item.content ? item.contentFormat : undefined],
    ["captured_at", iso(item.addedAt)],
    ["added_by", item.addedBy],
    ["topics", item.topics?.length ? item.topics : undefined],
    ["attachments", item.type === "pdf" && !item.purged ? [pdfPath(item.id)] : undefined],
    ["file_name", item.fileName],
    ["size", item.size],
    ["pages", item.pages],
    ["updated_at", iso(item.updatedAt)],
    ["location", item.location],
    ["read_at", item.readAt ? iso(item.readAt) : undefined],
    ["favorite", item.favorite || undefined],
    ["deleted", item.deleted || undefined],
    ["purged", item.purged || undefined],
    ["edited_at", editedAt(item.edited)],
  ];
  let out = "---\n";
  for (const [k, v] of fm) if (v !== undefined) out += `${k}: ${escapeSeparators(JSON.stringify(v))}\n`;
  out += "---\n";

  const body = item.body?.trim();
  if (body) out += `\n${escapeMarkers(body)}\n`;

  const content = item.content?.trim();
  if (content) out += `\n${CONTENT_MARKER}\n\n${CONTENT_HEADING}\n\n${escapeMarkers(content)}\n`;

  const sorted = [...annotations].sort(
    (a, b) => a.page - b.page || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  if (sorted.length) {
    out += `\n${MARKER}\n\n## Highlights\n`;
    for (const a of sorted) {
      out += "\n";
      if (!a.deleted && a.kind === "highlight" && a.quote?.trim()) {
        out += a.quote.trim().split(/\r?\n/).map((l) => `> ${l}`).join("\n") + "\n";
        // Obsidian's block id for a quote: on its own line, so [[Title#^ref]] and embeds work there too.
        out += `\n^${highlightRef(a.id)}\n`;
        if (a.page > 0) out += `\n— page ${a.page}\n`;
        if (a.note?.trim()) out += `\n${escapeMarkers(a.note.trim())}\n`;
        out += "\n";
      }
      out += `<!-- engram:annotation ${commentJson(a)} -->\n`;
    }
  }
  return out;
}

/** Read an item file. Lenient about hand edits; returns null if it isn't an Engram item. */
export function parseItem(text: string, path: string): { item: Item; annotations: Annotation[] } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const fm: Record<string, unknown> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_]+):\s*([\s\S]*)$/.exec(lines[i]);
    if (!kv) continue;
    if (kv[2].trim() === "") {
      // A YAML block list, as Obsidian writes when you edit a list property:  topics:\n  - sleep
      const list: unknown[] = [];
      while (i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1])) list.push(yamlValue(lines[++i].replace(/^\s*-\s/, "")));
      fm[kv[1]] = list.length ? list : "";
    } else fm[kv[1]] = yamlValue(kv[2]);
  }
  const str = (k: string) => (typeof fm[k] === "string" && fm[k] ? (fm[k] as string) : undefined);
  const num = (k: string) => (typeof fm[k] === "number" ? (fm[k] as number) : undefined);
  const time = (k: string) => {
    const t = Date.parse(str(k) ?? "");
    return Number.isNaN(t) ? undefined : t;
  };

  const id = str("id");
  const addedAt = time("captured_at");
  const updatedAt = time("updated_at");
  if (!id || addedAt === undefined || updatedAt === undefined) return null;
  const type = ITEM_TYPES.includes(fm.type as ItemType) ? (fm.type as ItemType) : "note";
  const topics = Array.isArray(fm.topics) ? fm.topics.filter((t): t is string => typeof t === "string") : [];

  const rest = lf(text.slice(m[0].length));
  const cut = findMarker(rest, "highlights")?.start ?? -1;
  const notes = cut < 0 ? rest : rest.slice(0, cut);
  const at = findMarker(notes, "content");
  const body = unescapeMarkers((at ? notes.slice(0, at.start) : notes).trim());
  let content = at ? notes.slice(at.end).trim() : "";
  if (content.startsWith(CONTENT_HEADING)) content = content.slice(CONTENT_HEADING.length).trim();
  content = unescapeMarkers(content);
  const edited: Record<string, number> = {};
  if (fm.edited_at && typeof fm.edited_at === "object" && !Array.isArray(fm.edited_at)) {
    for (const [k, v] of Object.entries(fm.edited_at)) {
      const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
      if (!Number.isNaN(t)) edited[k] = t;
    }
  }

  // Build in the same key order as the app does, so equal items compare equal.
  const item: Item = { id, type, title: str("title") ?? "Untitled", addedAt, updatedAt, path };
  if (str("source_url")) item.sourceUrl = str("source_url");
  if (str("author")) item.author = str("author");
  if (str("site_name")) item.siteName = str("site_name");
  if (str("description")) item.description = str("description");
  if (str("published")) item.published = str("published");
  if (str("source")) item.source = str("source");
  if (body) item.body = body;
  if (content) item.content = content;
  if (content && fm.content_format === "markdown") item.contentFormat = "markdown";
  if (topics.length) item.topics = topics;
  if (str("file_name")) item.fileName = str("file_name");
  if (num("size") !== undefined) item.size = num("size");
  if (num("pages") !== undefined) item.pages = num("pages");
  if (str("added_by")) item.addedBy = str("added_by");
  if (LOCATIONS.includes(fm.location as Location)) item.location = fm.location as Location;
  if (time("read_at") !== undefined) item.readAt = time("read_at");
  if (fm.favorite === true) item.favorite = true;
  if (fm.deleted === true) item.deleted = true;
  if (fm.purged === true) item.purged = true;
  if (Object.keys(edited).length) item.edited = edited;

  const annotations: Annotation[] = [];
  if (cut >= 0) {
    const highlights = rest.slice(cut);
    let from = 0;
    for (const a of highlights.matchAll(markerLine("annotation", "g"))) {
      // The visible part of this annotation sits between the previous comment and this one.
      const segment = highlights.slice(from, a.index);
      from = a.index + a[0].length;
      try {
        const parsed = JSON.parse(a[1].trim()) as Annotation;
        if (typeof parsed.id !== "string" || typeof parsed.updatedAt !== "number") continue;
        const ann: Annotation = { ...parsed, doc: id };
        const note = !ann.deleted && ann.kind === "highlight" ? visibleNote(segment, ann) : null;
        if (note !== null && note !== (ann.note?.trim() ?? "")) {
          if (note) ann.note = note;
          else delete ann.note;
        }
        annotations.push(ann);
      } catch {
        // A damaged line loses only that annotation; the next push from a device that has it restores it.
      }
    }
  }
  return { item, annotations };
}
