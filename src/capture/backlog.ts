/*
 * The background passes that fill in old items (pictures, video lengths) work through a backlog a few
 * items at a time. Each item is remembered when it was last tried, so a page that can't be read doesn't
 * hold up the rest: it waits for a week, and the ones tried longest ago go first.
 */

const WEEK = 7 * 24 * 3600 * 1000;

type Tried = Record<string, number>;

const read = (key: string): Tried => JSON.parse(localStorage.getItem(key) ?? "{}");

/** Up to `limit` of the ids not tried in the last week, the ones tried longest ago first. */
export function pickUntried(key: string, ids: string[], limit: number): string[] {
  const tried = read(key);
  const now = Date.now();
  return ids
    .filter((id) => !(tried[id] && now - tried[id] < WEEK))
    .sort((a, b) => (tried[a] ?? 0) - (tried[b] ?? 0))
    .slice(0, limit);
}

/** Note that an item was tried now, whether or not it worked. */
export function markTried(key: string, id: string): void {
  const tried = read(key);
  tried[id] = Date.now();
  localStorage.setItem(key, JSON.stringify(tried));
}
