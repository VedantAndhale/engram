// Adds and removes feeds in feeds.json as it is on GitHub. Every entry that is not being changed is kept exactly,
// including any this app would not show, so a hand edit is never lost. Pure, so the tests can run it in Node.
import { MAX_FEEDS, checkFeedsText, cleanTitle, newId, normalizeFeedUrl } from "./config";

export type RawPlan = { ok: true; changed: boolean; text: string } | { ok: false; error: string };

/** The file as an object, and its feeds list as it is written, entry by entry. */
function readRaw(text: string | null): { json: Record<string, unknown>; feeds: unknown[] } {
  const json: Record<string, unknown> = text && text.trim() ? (JSON.parse(text) as Record<string, unknown>) : { version: 1 };
  return { json, feeds: Array.isArray(json.feeds) ? [...json.feeds] : [] };
}

const serialize = (json: Record<string, unknown>, feeds: unknown[]) =>
  JSON.stringify({ ...json, version: json.version ?? 1, feeds }, null, 2) + "\n";

const urlOf = (entry: unknown) => {
  const url = (entry as { url?: unknown } | null)?.url;
  return typeof url === "string" ? normalizeFeedUrl(url) : null;
};
const idOf = (entry: unknown) => {
  const id = (entry as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
};

/** Adds one feed to the file, keeping every entry already there. */
export function planAddFeed(text: string | null, url: string, title?: string): RawPlan {
  const problem = checkFeedsText(text);
  if (problem) return { ok: false, error: problem };
  const normal = normalizeFeedUrl(url);
  if (!normal) return { ok: false, error: "Enter a full feed address that starts with http:// or https://." };
  const { json, feeds } = readRaw(text);
  if (feeds.some((entry) => urlOf(entry) === normal)) return { ok: false, error: "You already follow this feed." };
  if (feeds.length >= MAX_FEEDS) return { ok: false, error: `You can follow up to ${MAX_FEEDS} feeds.` };
  const taken = new Set(feeds.map(idOf).filter((id): id is string => !!id));
  feeds.push({ id: newId(taken), url: normal, title: cleanTitle(title, new URL(normal).hostname), addedAt: Date.now() });
  return { ok: true, changed: true, text: serialize(json, feeds) };
}

/** Removes one feed by its id, keeping every other entry. Nothing changes when the id is not in the file. */
export function planRemoveFeed(text: string | null, id: string): RawPlan {
  const problem = checkFeedsText(text);
  if (problem) return { ok: false, error: problem };
  const { json, feeds } = readRaw(text);
  const kept = feeds.filter((entry) => idOf(entry) !== id);
  if (kept.length === feeds.length) return { ok: true, changed: false, text: text ?? "" };
  return { ok: true, changed: true, text: serialize(json, kept) };
}
