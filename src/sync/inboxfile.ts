/*
 * inbox/<date>-<slug>-<rand>.md: something an agent sent, waiting for you. Agents never write
 * to your items; they write here, and you accept or dismiss each one in the app. The file says
 * which agent sent it, when and why:
 *
 *   ---
 *   engram: "inbox@1"
 *   kind: "save"            (or "note": lines to add to an item you have)
 *   agent: "Claude"
 *   created_at: "…"
 *   why: "…"
 *   title / source_url      (save)
 *   target / target_title   (note)
 *   ---
 *
 *   The agent's note.
 *
 *   <!-- engram:content … -->
 *   Text saved from the source (save only), someone else's words.
 *
 * Imports carry ".js" so the MCP server (plain Node ESM) can load this file as is.
 */

export const INBOX_FORMAT = "inbox@1";
const CONTENT_MARKER = "<!-- engram:content (saved from the source by an agent) -->";

export interface InboxEntry {
  kind: "save" | "note";
  agent: string;
  createdAt: number;
  why?: string;
  /** save: what to make. */
  title?: string;
  sourceUrl?: string;
  content?: string;
  /** note: which item the lines go into. */
  target?: string;
  targetTitle?: string;
  /** The agent's own words: the note, or what it says about the saved thing. */
  text?: string;
}

/** Where a new entry goes; the random tail keeps two agents saving at once apart. */
export function inboxPath(entry: Pick<InboxEntry, "createdAt" | "title" | "targetTitle" | "kind">, rand: string): string {
  const slug = (entry.title ?? entry.targetTitle ?? entry.kind)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return `inbox/${new Date(entry.createdAt).toISOString().slice(0, 10)}-${slug || "item"}-${rand}.md`;
}

export function serializeInbox(e: InboxEntry): string {
  const fm: [string, unknown][] = [
    ["engram", INBOX_FORMAT],
    ["kind", e.kind],
    ["agent", e.agent],
    ["created_at", new Date(e.createdAt).toISOString()],
    ["why", e.why],
    ["title", e.title],
    ["source_url", e.sourceUrl],
    ["target", e.target],
    ["target_title", e.targetTitle],
  ];
  let out = "---\n";
  for (const [k, v] of fm) if (v !== undefined && v !== "") out += `${k}: ${JSON.stringify(v)}\n`;
  out += "---\n";
  if (e.text?.trim()) out += `\n${e.text.trim()}\n`;
  if (e.content?.trim()) out += `\n${CONTENT_MARKER}\n\n${e.content.trim()}\n`;
  return out;
}

export function parseInbox(text: string): InboxEntry | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    try {
      fm[kv[1]] = JSON.parse(kv[2]);
    } catch {
      fm[kv[1]] = kv[2].trim();
    }
  }
  const str = (k: string) => (typeof fm[k] === "string" && fm[k] ? (fm[k] as string) : undefined);
  if (fm.engram !== INBOX_FORMAT || (fm.kind !== "save" && fm.kind !== "note")) return null;
  const createdAt = Date.parse(str("created_at") ?? "");
  const rest = text.slice(m[0].length);
  const at = rest.indexOf("<!-- engram:content");
  const words = (at < 0 ? rest : rest.slice(0, at)).trim();
  const content = at < 0 ? "" : rest.slice(rest.indexOf("-->", at) + 3).trim();
  const e: InboxEntry = { kind: fm.kind, agent: str("agent") ?? "An agent", createdAt: Number.isNaN(createdAt) ? 0 : createdAt };
  if (str("why")) e.why = str("why");
  if (str("title")) e.title = str("title");
  if (str("source_url")) e.sourceUrl = str("source_url");
  if (str("target")) e.target = str("target");
  if (str("target_title")) e.targetTitle = str("target_title");
  if (words) e.text = words;
  if (content) e.content = content;
  return e;
}
