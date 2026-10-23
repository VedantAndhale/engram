// A save link only pre-fills the save box. Nothing in this file writes anything,
// so a page that links to Engram cannot save on the reader's behalf.

export interface SaveLink {
  url?: string;
  text?: string;
  title?: string;
}

const MAX_URL = 2_000;
const MAX_TEXT = 4_000;
const MAX_TITLE = 300;

// Trim, then cut to the limit. Trimming again after the cut keeps this
// idempotent, which the build-then-parse round trip relies on.
function clean(value: string | null | undefined, max: number): string | undefined {
  if (!value) return undefined;
  let out = value.trim();
  if (out.length > max) {
    out = out.slice(0, max);
    // Never leave half an emoji at the cut.
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    out = out.trimEnd();
  }
  return out || undefined;
}

// Only web addresses get through: a javascript: or data: link has no place in
// a box the reader may click through from.
function cleanUrl(value: string | null | undefined): string | undefined {
  const raw = value?.trim();
  // A cut address would point somewhere else, so a long one is dropped, not shortened.
  if (!raw || raw.length > MAX_URL) return undefined;
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

// Leaves out empty fields (no undefined keys) and needs a url or text to count.
function pack(url?: string, text?: string, title?: string): SaveLink | null {
  if (!url && !text) return null;
  const link: SaveLink = {};
  if (url) link.url = url;
  if (text) link.text = text;
  if (title) link.title = title;
  return link;
}

// search is location.search on the save screen, e.g. "?url=...&text=...&title=...".
export function parseSaveLink(search: string): SaveLink | null {
  // URLSearchParams decodes both + and %xx, and never throws on bad escapes.
  const params = new URLSearchParams(search);
  return pack(
    cleanUrl(params.get("url")),
    clean(params.get("text"), MAX_TEXT),
    clean(params.get("title"), MAX_TITLE),
  );
}

// base is the app's address with no trailing slash, e.g. "https://engram.example".
export function buildSaveLink(base: string, link: SaveLink): string {
  const params = new URLSearchParams();
  const url = cleanUrl(link.url);
  const title = clean(link.title, MAX_TITLE);
  const text = clean(link.text, MAX_TEXT);
  // Fixed order so the same link always produces the same address.
  if (url) params.set("url", url);
  if (title) params.set("title", title);
  if (text) params.set("text", text);
  // Tolerate a stray trailing slash on the base so we never emit "//save".
  return `${base.replace(/\/+$/, "")}/save?${params.toString()}`;
}