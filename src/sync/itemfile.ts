import { ITEM_TYPES, type Annotation, type Item, type ItemType } from "../model";
import { pdfPath } from "./paths";

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
 *   …
 *   <!-- engram:annotation {"id":…} -->
 *
 * Front matter values are written as JSON, which is also valid YAML. Each annotation's full
 * record sits in a comment after its readable form; only the comment is read back, so the
 * readable part can never drift from the data.
 */

const FORMAT = "item@1";
const MARKER = "<!-- engram:highlights (managed by Engram: write your notes above this line) -->";
const CONTENT_MARKER = "<!-- engram:content (saved from the source; replaced when you save the page again) -->";
const CONTENT_HEADING = "## Saved from the source";

const iso = (ts: number) => new Date(ts).toISOString();

/** JSON that can sit inside an HTML comment: "--" never appears, so "-->" can't either. */
const commentJson = (value: unknown) => JSON.stringify(value).replace(/--/g, "-\\u002d");

/** Stable output, so identical content always produces the identical git blob. */
export function serializeItem(item: Item, annotations: Annotation[]): string {
  const fm: [string, unknown][] = [
    ["engram", FORMAT],
    ["id", item.id],
    ["type", item.type],
    ["title", item.title],
    ["source_url", item.sourceUrl],
    ["captured_at", iso(item.addedAt)],
    ["added_by", item.addedBy],
    ["topics", item.topics?.length ? item.topics : undefined],
    ["attachments", item.type === "pdf" ? [pdfPath(item.id)] : undefined],
    ["file_name", item.fileName],
    ["size", item.size],
    ["pages", item.pages],
    ["updated_at", iso(item.updatedAt)],
    ["deleted", item.deleted || undefined],
  ];
  let out = "---\n";
  for (const [k, v] of fm) if (v !== undefined) out += `${k}: ${JSON.stringify(v)}\n`;
  out += "---\n";

  const body = item.body?.trim();
  if (body) out += `\n${body}\n`;

  const content = item.content?.trim();
  if (content) out += `\n${CONTENT_MARKER}\n\n${CONTENT_HEADING}\n\n${content}\n`;

  const sorted = [...annotations].sort(
    (a, b) => a.page - b.page || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  if (sorted.length) {
    out += `\n${MARKER}\n\n## Highlights\n`;
    for (const a of sorted) {
      out += "\n";
      if (!a.deleted && a.kind === "highlight" && a.quote?.trim()) {
        out += a.quote.trim().split(/\r?\n/).map((l) => `> ${l}`).join("\n") + "\n";
        if (a.page > 0) out += `\n— page ${a.page}\n`;
        if (a.note?.trim()) out += `\n${a.note.trim()}\n`;
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
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    try {
      fm[kv[1]] = JSON.parse(kv[2]);
    } catch {
      fm[kv[1]] = kv[2].trim(); // plain YAML scalar typed by hand
    }
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

  const rest = text.slice(m[0].length);
  const cut = rest.indexOf("<!-- engram:highlights");
  const notes = cut < 0 ? rest : rest.slice(0, cut);
  const at = notes.indexOf("<!-- engram:content");
  const body = (at < 0 ? notes : notes.slice(0, at)).trim();
  let content = at < 0 ? "" : notes.slice(notes.indexOf("-->", at) + 3).trim();
  if (content.startsWith(CONTENT_HEADING)) content = content.slice(CONTENT_HEADING.length).trim();

  // Build in the same key order as the app does, so equal items compare equal.
  const item: Item = { id, type, title: str("title") ?? "Untitled", addedAt, updatedAt, path };
  if (str("source_url")) item.sourceUrl = str("source_url");
  if (body) item.body = body;
  if (content) item.content = content;
  if (topics.length) item.topics = topics;
  if (str("file_name")) item.fileName = str("file_name");
  if (num("size") !== undefined) item.size = num("size");
  if (num("pages") !== undefined) item.pages = num("pages");
  if (str("added_by")) item.addedBy = str("added_by");
  if (fm.deleted === true) item.deleted = true;

  const annotations: Annotation[] = [];
  if (cut >= 0) {
    for (const a of rest.slice(cut).matchAll(/<!-- engram:annotation (.*?) -->/g)) {
      try {
        const parsed = JSON.parse(a[1]) as Annotation;
        if (typeof parsed.id === "string" && typeof parsed.updatedAt === "number") annotations.push({ ...parsed, doc: id });
      } catch {
        // A damaged line loses only that annotation; the next push from a device that has it restores it.
      }
    }
  }
  return { item, annotations };
}
