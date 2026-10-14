import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { entryKey, inboxFileText } from "./action/fetch-feeds.mjs";
import type { FeedEntry } from "./action/fetch-feeds.mjs";
import { parseInbox } from "../sync/inboxfile";

const CREATED = "2026-10-14T12:00:00.000Z";
const FEED = { id: "0a1b2c3d", title: "Example Blog" };

function makeEntry(over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    guid: "post-1",
    title: "Hello world",
    link: "https://example.com/posts/1",
    summary: "A short summary.",
    published: null,
    ...over,
  };
}

// The one place that knows how parseInbox reports a parsed file. Adapt here if its shape differs.
function parse(text: string): Record<string, unknown> {
  const parsed = parseInbox(text) as unknown as Record<string, unknown> | null;
  assert.ok(parsed, "parseInbox rejected the file");
  return parsed;
}

// Accepts camelCase or snake_case field names so the test survives either choice.
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj) return obj[key];
  }
  return undefined;
}

test("writes the exact inbox layout with fields in order", () => {
  const text = inboxFileText(makeEntry(), FEED, CREATED);
  const expected = [
    "---",
    'engram: "inbox@1"',
    'kind: "save"',
    'agent: "feeds"',
    `created_at: "${CREATED}"`,
    'why: "From Example Blog"',
    'title: "Hello world"',
    'source_url: "https://example.com/posts/1"',
    "---",
    "",
    "A short summary.",
  ].join("\n");
  assert.equal(text.trimEnd(), expected);
  // A feed entry never carries a content marker.
  assert.ok(!/<!--\s*engram:/.test(text));
});

test("the output is accepted by parseInbox", () => {
  const text = inboxFileText(makeEntry(), FEED, CREATED);
  const parsed = parse(text);
  assert.equal(pick(parsed, "title"), "Hello world");
  assert.equal(pick(parsed, "sourceUrl", "source_url", "url"), "https://example.com/posts/1");
  assert.equal(pick(parsed, "why"), "From Example Blog");
});

test("quotes and newlines in the title survive the round trip", () => {
  const title = 'She said "hi"\nthen left';
  const text = inboxFileText(makeEntry({ title }), FEED, CREATED);
  // The title stays on one front matter line, JSON-escaped.
  assert.ok(text.includes('title: "She said \\"hi\\"\\nthen left"'));
  const parsed = parse(text);
  assert.equal(pick(parsed, "title"), title);
});

test("writes no body when the summary is empty", () => {
  const text = inboxFileText(makeEntry({ summary: "" }), FEED, CREATED);
  assert.ok(text.trimEnd().endsWith("\n---"));
  parse(text);
});

test("omits the why line when the feed title is empty", () => {
  const text = inboxFileText(makeEntry(), { id: FEED.id, title: "" }, CREATED);
  assert.ok(!/^why:/m.test(text));
  parse(text);
});

test('removes "<!-- engram:" from the summary, even when nested', () => {
  const summaries = [
    'Before <!-- engram: kind="save" --> after',
    "x <!-- <!-- engram:engram: y",
  ];
  for (const summary of summaries) {
    const text = inboxFileText(makeEntry({ summary }), FEED, CREATED);
    assert.ok(!text.includes("<!-- engram:"), `marker left in: ${summary}`);
    parse(text);
  }
  const first = inboxFileText(makeEntry({ summary: summaries[0] }), FEED, CREATED);
  assert.ok(first.includes("Before"));
  assert.ok(first.includes("after"));
});

test("entry keys are 16 hex chars from sha1(feedId, newline, guid) and name the file", () => {
  const key = entryKey(FEED.id, "post-1");
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(key, createHash("sha1").update(`${FEED.id}\npost-1`).digest("hex").slice(0, 16));
  assert.match(`inbox/feed-${key}.md`, /^inbox\/feed-[0-9a-f]{16}\.md$/);
  // A different guid or a different feed gives a different file.
  assert.notEqual(entryKey(FEED.id, "post-2"), key);
  assert.notEqual(entryKey("ffffffff", "post-1"), key);
});