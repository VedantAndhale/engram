import { test } from "node:test";
import assert from "node:assert/strict";
import { entryKey, planRun } from "./action/fetch-feeds.mjs";
import type {
  FeedConfig,
  FeedEntry,
  FeedState,
  FeedsState,
  FetchResult,
} from "./action/fetch-feeds.mjs";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const HOUR = 3_600_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// Fetch result builders. This is the only place that knows how a fetch outcome is shaped.
// Adapt these four if the module's FetchResult differs.
function okResult(entries: FeedEntry[], title = "Feed"): FetchResult {
  return { kind: "ok", title, entries, etag: null, lastModified: null };
}
function notModified(): FetchResult {
  return { kind: "notModified" };
}
function failed(message: string): FetchResult {
  return { kind: "error", message };
}
function run(
  feeds: FeedConfig[],
  state: FeedsState,
  fetched: Record<string, FetchResult>,
  now = NOW,
) {
  return planRun({ feeds, state, fetched, now });
}

function emptyState(): FeedsState {
  return { version: 1, updatedAt: iso(0), feeds: {} };
}

function feed(n: number): FeedConfig {
  return {
    id: n.toString(16).padStart(8, "0"),
    url: `https://feeds.example/${n}.xml`,
    title: `Feed ${n}`,
    addedAt: 1,
  };
}

// Feeds list newest first, so index 0 is the newest entry.
function entry(prefix: string, i: number): FeedEntry {
  return {
    guid: `${prefix}-${i}`,
    title: `Post ${prefix} ${i}`,
    link: `https://example.com/${prefix}/${i}`,
    summary: "",
    published: null,
  };
}
function entries(prefix: string, count: number): FeedEntry[] {
  return Array.from({ length: count }, (_, i) => entry(prefix, i));
}
function keysOf(feedId: string, list: FeedEntry[]): string[] {
  return list.map((e) => entryKey(feedId, e.guid));
}
function pathOf(feedId: string, e: FeedEntry): string {
  return `inbox/feed-${entryKey(feedId, e.guid)}.md`;
}

function feedState(f: FeedConfig, seen: string[], over: Partial<FeedState> = {}): FeedState {
  return {
    url: f.url,
    title: f.title,
    etag: null,
    lastModified: null,
    retryAfter: null,
    lastError: null,
    seen,
    ...over,
  };
}

function stateOf(state: FeedsState, id: string): FeedState {
  const found = state.feeds[id];
  assert.ok(found, `no state recorded for ${id}`);
  return found;
}

function sorted(list: string[]): string[] {
  return [...list].sort();
}

// Sorted keys everywhere, so two states compare the way their serialised bytes would.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

test("first run writes the first 5 entries and marks every entry seen", () => {
  const f = feed(1);
  const list = entries("a", 8);
  const plan = run([f], emptyState(), { [f.id]: okResult(list) });
  // Feeds list newest first, so the first 5 in document order are the new ones.
  assert.deepEqual(
    sorted(plan.writes.map((w) => w.path)),
    sorted(list.slice(0, 5).map((e) => pathOf(f.id, e))),
  );
  for (const write of plan.writes) {
    assert.match(write.path, /^inbox\/feed-[0-9a-f]{16}\.md$/);
    assert.match(write.text, /^---\nengram: "inbox@1"\n/);
  }
  // The other three are marked seen too, so they never show up later.
  assert.deepEqual(sorted(stateOf(plan.state, f.id).seen), sorted(keysOf(f.id, list)));
  assert.equal(plan.state.version, 1);
  assert.equal(plan.state.updatedAt, iso(NOW));
  assert.deepEqual(plan.errors, []);
});

test("a second run with the same input writes nothing and returns identical state", () => {
  const f = feed(1);
  const fetched = { [f.id]: okResult(entries("a", 8)) };
  const first = run([f], emptyState(), fetched, NOW);
  const second = run([f], first.state, fetched, NOW + 6 * HOUR);
  assert.equal(second.writes.length, 0);
  // updatedAt only moves when something else changed.
  assert.equal(stableStringify(second.state), stableStringify(first.state));
});

test("a 304 leaves the feed's state unchanged", () => {
  const f = feed(1);
  const first = run([f], emptyState(), { [f.id]: okResult(entries("a", 3)) });
  const withEtag = structuredClone(first.state);
  stateOf(withEtag, f.id).etag = '"abc"';
  const plan = run([f], withEtag, { [f.id]: notModified() }, NOW + HOUR);
  assert.equal(plan.writes.length, 0);
  assert.deepEqual(plan.errors, []);
  assert.equal(stableStringify(plan.state), stableStringify(withEtag));
});

test("a run writes at most 30 entries, round-robin across feeds, and leftovers come next run", () => {
  const feeds = Array.from({ length: 10 }, (_, i) => feed(i + 1));
  // Each feed lists 8 unseen entries, then one already-seen entry.
  // The seen one stops reset detection from treating the feed as new.
  const newEntry = (f: FeedConfig, i: number) => entry(`f${f.id}`, i);
  const listFor = (f: FeedConfig): FeedEntry[] => [
    ...entries(`f${f.id}`, 8),
    entry(`old${f.id}`, 0),
  ];
  const pathsFor = (from: number, to: number): string[] =>
    feeds.flatMap((f) => listFor(f).slice(from, to).map((e) => pathOf(f.id, e)));

  const stateFeeds: Record<string, FeedState> = {};
  const fetched: Record<string, FetchResult> = {};
  for (const f of feeds) {
    stateFeeds[f.id] = feedState(f, [entryKey(f.id, `old${f.id}-0`)]);
    fetched[f.id] = okResult(listFor(f));
  }
  const start: FeedsState = { version: 1, updatedAt: iso(0), feeds: stateFeeds };

  const first = run(feeds, start, fetched, NOW);
  assert.equal(first.writes.length, 30);
  // The first ten writes are each feed's newest entry, in feeds.json order.
  assert.deepEqual(
    first.writes.slice(0, 10).map((w) => w.path),
    feeds.map((f) => pathOf(f.id, newEntry(f, 0))),
  );
  assert.deepEqual(sorted(first.writes.map((w) => w.path)), sorted(pathsFor(0, 3)));
  // Leftovers stay unseen.
  const firstFeed = feeds[0];
  assert.ok(firstFeed);
  assert.ok(!stateOf(first.state, firstFeed.id).seen.includes(entryKey(firstFeed.id, newEntry(firstFeed, 3).guid)));

  const second = run(feeds, first.state, fetched, NOW + 6 * HOUR);
  assert.equal(second.writes.length, 30);
  assert.deepEqual(sorted(second.writes.map((w) => w.path)), sorted(pathsFor(3, 6)));

  const third = run(feeds, second.state, fetched, NOW + 12 * HOUR);
  assert.equal(third.writes.length, 20);
  assert.deepEqual(sorted(third.writes.map((w) => w.path)), sorted(pathsFor(6, 8)));

  const fourth = run(feeds, third.state, fetched, NOW + 18 * HOUR);
  assert.equal(fourth.writes.length, 0);
});

test("the ledger is capped at 1000 keys and keeps the newest", () => {
  const f = feed(1);
  const old = entries("old", 1000);
  const oldKeys = keysOf(f.id, old);
  const state: FeedsState = {
    version: 1,
    updatedAt: iso(0),
    feeds: { [f.id]: feedState(f, oldKeys) },
  };
  // old-0 is already seen, so the three new entries are the only writes.
  const list = [...entries("new", 3), entry("old", 0)];
  const plan = run([f], state, { [f.id]: okResult(list) });
  assert.equal(plan.writes.length, 3);
  const seen = stateOf(plan.state, f.id).seen;
  assert.equal(seen.length, 1000);
  // New keys go to the front.
  assert.deepEqual(sorted(seen.slice(0, 3)), sorted(keysOf(f.id, entries("new", 3))));
  // The three oldest keys fall off the end.
  for (const dropped of oldKeys.slice(997)) {
    assert.ok(!seen.includes(dropped));
  }
  assert.ok(seen.includes(oldKeys[996] ?? ""));
});

test("reset detection treats a feed whose ledger matches nothing as a first run", () => {
  const f = feed(1);
  // The ledger holds keys from an older guid scheme, and none of the 8 entries match.
  const state: FeedsState = {
    version: 1,
    updatedAt: iso(0),
    feeds: { [f.id]: feedState(f, [entryKey(f.id, "legacy-guid")]) },
  };
  const list = entries("a", 8);
  const plan = run([f], state, { [f.id]: okResult(list) });
  assert.equal(plan.writes.length, 5);
  const seen = stateOf(plan.state, f.id).seen;
  for (const key of keysOf(f.id, list)) {
    assert.ok(seen.includes(key));
  }

  // With one entry in the ledger it is not a reset, so all 8 new entries are written.
  const g = feed(2);
  const gState: FeedsState = {
    version: 1,
    updatedAt: iso(0),
    feeds: { [g.id]: feedState(g, [entryKey(g.id, "old-0")]) },
  };
  const gList = [...entries("n", 8), entry("old", 0)];
  const gPlan = run([g], gState, { [g.id]: okResult(gList) });
  assert.equal(gPlan.writes.length, 8);
});

test("state for a feed that was removed from feeds.json is dropped", () => {
  const kept = feed(1);
  const removed = feed(2);
  const list = entries("a", 2);
  const state: FeedsState = {
    version: 1,
    updatedAt: iso(0),
    feeds: {
      [kept.id]: feedState(kept, keysOf(kept.id, list)),
      [removed.id]: feedState(removed, keysOf(removed.id, list)),
    },
  };
  const plan = run([kept], state, { [kept.id]: okResult(list) });
  assert.deepEqual(Object.keys(plan.state.feeds), [kept.id]);
});

test("a failed fetch keeps the ledger and records lastError with a stable since", () => {
  const f = feed(1);
  const seen = keysOf(f.id, entries("a", 3));
  const state: FeedsState = {
    version: 1,
    updatedAt: iso(0),
    feeds: { [f.id]: feedState(f, seen) },
  };

  const first = run([f], state, { [f.id]: failed("HTTP 500") }, NOW);
  assert.equal(first.writes.length, 0);
  assert.deepEqual(stateOf(first.state, f.id).seen, seen);
  assert.deepEqual(stateOf(first.state, f.id).lastError, {
    message: "HTTP 500",
    since: iso(NOW),
  });
  const [err] = first.errors;
  assert.ok(err);
  assert.equal(err.feedId, f.id);
  assert.match(err.message, /HTTP 500/);

  // The same message later keeps the original since.
  const same = run([f], first.state, { [f.id]: failed("HTTP 500") }, NOW + HOUR);
  assert.deepEqual(stateOf(same.state, f.id).lastError, {
    message: "HTTP 500",
    since: iso(NOW),
  });
  assert.deepEqual(stateOf(same.state, f.id).seen, seen);

  // A different message starts a new since.
  const other = run([f], same.state, { [f.id]: failed("timeout") }, NOW + 2 * HOUR);
  assert.deepEqual(stateOf(other.state, f.id).lastError, {
    message: "timeout",
    since: iso(NOW + 2 * HOUR),
  });
});

test("a retryAfter in the future skips the feed without fetching it", () => {
  const f = feed(1);
  const seen = keysOf(f.id, entries("a", 2));
  const waiting = feedState(f, seen, { retryAfter: iso(NOW + HOUR), etag: '"x"' });
  const state: FeedsState = { version: 1, updatedAt: iso(0), feeds: { [f.id]: waiting } };
  // Nothing was fetched, so there is no result for this feed.
  const plan = run([f], state, {});
  assert.equal(plan.writes.length, 0);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(stateOf(plan.state, f.id), waiting);
  assert.equal(stableStringify(plan.state), stableStringify(state));
});

test("a retryAfter in the past no longer skips the feed", () => {
  const f = feed(1);
  const old = entry("old", 0);
  const waiting = feedState(f, [entryKey(f.id, old.guid)], { retryAfter: iso(NOW - HOUR) });
  const state: FeedsState = { version: 1, updatedAt: iso(0), feeds: { [f.id]: waiting } };
  const fresh = entry("fresh", 0);
  const plan = run([f], state, { [f.id]: okResult([fresh, old]) });
  assert.deepEqual(
    plan.writes.map((w) => w.path),
    [pathOf(f.id, fresh)],
  );
});