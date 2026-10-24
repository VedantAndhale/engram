// Browser-safe helpers for feeds.json. No Node APIs here because the app runs this in the page.
// The Action's own validator (fetch-feeds.mjs) applies the same URL and id rules, so both sides agree.

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

// Each run fetches every feed. The Action's time budget is sized for this many, so raise both together.
export const MAX_FEEDS = 500;

const TITLE_CAP = 120;
// The ids the Action runs. Engram's own ids are 8 hex characters, but a hand-written id such as "blog1" works too.
const FEED_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

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

export function cleanTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const t = value.replace(/\s+/g, " ").trim().slice(0, TITLE_CAP);
  return t || fallback;
}

// 8 hex chars from the browser's random source. Retry on the (very unlikely) clash.
export function newId(taken: Set<string>): string {
  for (;;) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (!taken.has(id)) return id;
  }
}

// A missing, hand-edited or damaged file should never break the app, so bad
// input gives an empty list and bad entries are skipped one by one. This is for
// showing the list. It is never used to write the file back: see planFollow.
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
    const id = typeof r.id === "string" && FEED_ID.test(r.id) ? r.id : null;
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

/**
 * Why the file cannot be written to, or null when it can. An empty file is fine: it is a new list. A file that is
 * not valid JSON, has no feeds list, or has more than MAX_FEEDS entries is refused, so writing never throws
 * away what the reader put there.
 */
export function checkFeedsText(text: string | null): string | null {
  if (!text || !text.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return "feeds.json on GitHub is not valid JSON, so nothing was changed. Fix that file on GitHub first.";
  }
  const list = json && typeof json === "object" ? (json as { feeds?: unknown }).feeds : undefined;
  if (!Array.isArray(list)) return "feeds.json on GitHub has no feeds list, so nothing was changed. Fix that file on GitHub first.";
  if (list.length > MAX_FEEDS) return `feeds.json on GitHub has more than ${MAX_FEEDS} feeds, so nothing was changed. Remove some on GitHub first.`;
  return null;
}

/**
 * The feed addresses already in the file, normalised, so a feed found on a site can be checked against them. Reads
 * every entry with a usable address, including ones parseFeedsJson would hide, because those are still followed.
 */
export function followedUrls(text: string | null): Set<string> {
  const followed = new Set<string>();
  if (!text || !text.trim()) return followed;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return followed;
  }
  const list = json && typeof json === "object" ? (json as { feeds?: unknown }).feeds : undefined;
  if (!Array.isArray(list)) return followed;
  for (const entry of list) {
    const url = (entry as { url?: unknown } | null)?.url;
    const normal = typeof url === "string" ? normalizeFeedUrl(url) : null;
    if (normal) followed.add(normal);
  }
  return followed;
}

export type FollowPlan =
  | { ok: false; error: string }
  | { ok: true; changed: boolean; text: string; added: number; done: string[]; refused: number; reason?: string };

/**
 * Follows `urls` in the feeds file as it is on GitHub. Entries already there are written back exactly as they were,
 * including any this app would not show. `done` lists the addresses now followed (added, or already followed).
 * `refused` counts the rest, and `reason` says why the first of them was refused.
 */
export function planFollow(text: string | null, urls: string[]): FollowPlan {
  const problem = checkFeedsText(text);
  if (problem) return { ok: false, error: problem };
  const json: Record<string, unknown> = text && text.trim() ? (JSON.parse(text) as Record<string, unknown>) : { version: 1, feeds: [] };
  const feeds: unknown[] = Array.isArray(json.feeds) ? [...json.feeds] : [];
  const known = new Set<string>();
  const ids = new Set<string>();
  for (const raw of feeds) {
    const r = raw as { url?: unknown; id?: unknown } | null;
    if (typeof r?.url === "string") {
      const n = normalizeFeedUrl(r.url);
      if (n) known.add(n);
    }
    if (typeof r?.id === "string") ids.add(r.id);
  }

  const done: string[] = [];
  let added = 0;
  let refused = 0;
  let reason: string | undefined;
  for (const url of urls) {
    const normal = normalizeFeedUrl(url);
    if (!normal) {
      refused++;
      reason ??= "Enter a full feed address that starts with http:// or https://.";
      continue;
    }
    if (known.has(normal)) {
      done.push(url);
      continue;
    }
    if (feeds.length >= MAX_FEEDS) {
      refused++;
      reason ??= `You can follow up to ${MAX_FEEDS} feeds.`;
      continue;
    }
    const id = newId(ids);
    ids.add(id);
    feeds.push({ id, url: normal, title: cleanTitle(undefined, new URL(normal).hostname), addedAt: Date.now() });
    known.add(normal);
    done.push(url);
    added++;
  }
  if (!added) return { ok: true, changed: false, text: text ?? "", added, done, refused, reason };
  return {
    ok: true,
    changed: true,
    text: JSON.stringify({ ...json, version: json.version ?? 1, feeds }, null, 2) + "\n",
    added,
    done,
    refused,
    reason,
  };
}
