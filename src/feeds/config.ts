// Browser-safe helpers for feeds.json. No Node APIs here because the app runs this in the page.
// The Action's own validator (fetch-feeds.mjs) applies the same rules, so both sides agree.

export type FeedConfig = {
  id: string;
  url: string;
  title: string;
  addedAt: number;
};

export type FeedsFile = {
  version: 1;
  feeds: FeedConfig[];
};

// One run fetches every feed, so the list stays small to fit the Action's time limit.
export const MAX_FEEDS = 50;

const TITLE_CAP = 120;
const HEX8 = /^[0-9a-f]{8}$/;

// Lowercases scheme and host (the URL parser does this), drops the #hash, and
// refuses anything that is not http(s). Returns null for a bad address.
export function normalizeFeedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  return u.toString();
}

function cleanTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const t = value.replace(/\s+/g, " ").trim().slice(0, TITLE_CAP);
  return t || fallback;
}

// 8 hex chars from the browser's random source. Retry on the (very unlikely) clash.
function newId(taken: Set<string>): string {
  for (;;) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (!taken.has(id)) return id;
  }
}

// A missing, hand-edited or damaged file should never break the app, so bad
// input gives an empty list and bad entries are skipped one by one.
export function parseFeedsJson(text: string | null): FeedsFile {
  const empty: FeedsFile = { version: 1, feeds: [] };
  if (!text) return empty;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!json || typeof json !== "object") return empty;
  const list = (json as { feeds?: unknown }).feeds;
  if (!Array.isArray(list)) return empty;

  const feeds: FeedConfig[] = [];
  const urls = new Set<string>();
  const ids = new Set<string>();
  for (const raw of list) {
    if (feeds.length >= MAX_FEEDS) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const url = typeof r.url === "string" ? normalizeFeedUrl(r.url) : null;
    if (!url || urls.has(url)) continue;
    const id = typeof r.id === "string" && HEX8.test(r.id) ? r.id : null;
    if (!id || ids.has(id)) continue;
    urls.add(url);
    ids.add(id);
    feeds.push({
      id,
      url,
      title: cleanTitle(r.title, new URL(url).hostname),
      addedAt: typeof r.addedAt === "number" && Number.isFinite(r.addedAt) ? r.addedAt : 0,
    });
  }
  return { version: 1, feeds };
}

// Stable, readable output so the file diffs cleanly in the user's repo.
export function feedsToJson(f: FeedsFile): string {
  return JSON.stringify(f, null, 2) + "\n";
}

// Returns a new file object, or an error message the UI can show as is.
export function addFeed(
  f: FeedsFile,
  url: string,
  title?: string,
): FeedsFile | { error: string } {
  const normal = normalizeFeedUrl(url);
  if (!normal) {
    return { error: "Enter a full feed address that starts with http:// or https://." };
  }
  if (f.feeds.some((x) => normalizeFeedUrl(x.url) === normal)) {
    return { error: "You already follow this feed." };
  }
  if (f.feeds.length >= MAX_FEEDS) {
    return { error: `You can follow up to ${MAX_FEEDS} feeds.` };
  }
  const feed: FeedConfig = {
    id: newId(new Set(f.feeds.map((x) => x.id))),
    url: normal,
    title: cleanTitle(title, new URL(normal).hostname),
    addedAt: Date.now(),
  };
  return { version: 1, feeds: [...f.feeds, feed] };
}

export function removeFeed(f: FeedsFile, id: string): FeedsFile {
  return { version: 1, feeds: f.feeds.filter((x) => x.id !== id) };
}