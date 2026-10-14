import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryKey, main } from "./action/fetch-feeds.mjs";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const HOUR = 3_600_000;

const FEED_A = { id: "aaaaaaaa", url: "https://a.example/feed.xml", title: "Feed A", addedAt: 1 };
const FEED_B = { id: "bbbbbbbb", url: "https://b.example/feed.xml", title: "Feed B", addedAt: 2 };

type Item = { guid: string; title: string; link: string; description: string };

function post(prefix: string, n: number): Item {
  return {
    guid: `${prefix}-${n}`,
    title: `Post ${prefix} ${n}`,
    link: `https://${prefix}.example/posts/${n}`,
    description: `Summary ${prefix} ${n}`,
  };
}

function rss(title: string, items: Item[]): string {
  const body = items
    .map(
      (i) => `<item>
<title>${i.title}</title>
<link>${i.link}</link>
<guid>${i.guid}</guid>
<description>${i.description}</description>
<pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate>
</item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${title}</title>
<link>https://example.com/</link>
${body}
</channel></rss>`;
}

type Call = { url: string; headers: Headers };
type Handler = (call: Call) => Response;

// Serves the body, or a 304 when the request carries the matching validator.
function serving(body: string, validators: { etag?: string; lastModified?: string }): Handler {
  return ({ headers }) => {
    if (validators.etag && headers.get("if-none-match") === validators.etag) {
      return new Response(null, { status: 304 });
    }
    const out: Record<string, string> = { "content-type": "application/rss+xml; charset=utf-8" };
    if (validators.etag) out.etag = validators.etag;
    if (validators.lastModified) out["last-modified"] = validators.lastModified;
    return new Response(body, { status: 200, headers: out });
  };
}

function fakeFetch(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = { url, headers: new Headers(init?.headers) };
    calls.push(call);
    const handler = handlers[url];
    if (!handler) return new Response("not found", { status: 404 });
    return handler(call);
  };
  return { impl, calls };
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "engram-feeds-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFeeds(root: string, feeds: object[]): Promise<void> {
  await writeFile(join(root, "feeds.json"), JSON.stringify({ version: 1, feeds }), "utf8");
}

async function listInbox(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, "inbox"))).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function fileName(feedId: string, guid: string): string {
  return `feed-${entryKey(feedId, guid)}.md`;
}

async function runMain(root: string, impl: Parameters<typeof main>[0]) {
  // Replaced below; see runMainWith.
  return { impl, root };
}
void runMain;

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function runMainWith(root: string, impl: FetchImpl, now = NOW) {
  const logs: string[] = [];
  const result = await main({
    root,
    fetchImpl: impl,
    now: () => now,
    log: (...args: unknown[]) => {
      logs.push(args.join(" "));
    },
  });
  return { result, logs };
}

const ITEMS_A = [post("a", 1), post("a", 2), post("a", 3)];
const ITEMS_B = [post("b", 1), post("b", 2), post("b", 3)];
const LAST_MODIFIED = "Tue, 06 Oct 2026 10:00:00 GMT";

function twoFeedHandlers(): Record<string, Handler> {
  return {
    [FEED_A.url]: serving(rss("Feed A", ITEMS_A), { etag: '"v1"', lastModified: LAST_MODIFIED }),
    [FEED_B.url]: serving(rss("Feed B", ITEMS_B), { etag: '"v2"', lastModified: LAST_MODIFIED }),
  };
}

test("main writes the new entries as inbox files and records state.json", async () => {
  await withRoot(async (root) => {
    await writeFeeds(root, [FEED_A, FEED_B]);
    const { impl, calls } = fakeFetch(twoFeedHandlers());
    const { result, logs } = await runMainWith(root, impl);

    assert.deepEqual(result, { written: 6, errors: 0 });
    assert.deepEqual(
      await listInbox(root),
      [
        ...ITEMS_A.map((i) => fileName(FEED_A.id, i.guid)),
        ...ITEMS_B.map((i) => fileName(FEED_B.id, i.guid)),
      ].sort(),
    );

    const text = await readFile(join(root, "inbox", fileName(FEED_A.id, "a-1")), "utf8");
    assert.ok(text.includes('agent: "feeds"'));
    assert.ok(text.includes('why: "From Feed A"'));
    assert.ok(text.includes('title: "Post a 1"'));
    assert.ok(text.includes('source_url: "https://a.example/posts/1"'));
    assert.match(text, /\n\nSummary a 1\n?$/);

    const stateText = await readFile(join(root, "feeds", "state.json"), "utf8");
    assert.ok(stateText.endsWith("\n"));
    const state = JSON.parse(stateText);
    assert.equal(state.version, 1);
    assert.deepEqual(Object.keys(state), [...Object.keys(state)].sort());
    const a = state.feeds[FEED_A.id];
    assert.deepEqual(Object.keys(a), [...Object.keys(a)].sort());
    assert.equal(a.url, FEED_A.url);
    assert.equal(a.etag, '"v1"');
    assert.equal(a.lastModified, LAST_MODIFIED);
    assert.deepEqual(
      [...a.seen].sort(),
      ITEMS_A.map((i) => entryKey(FEED_A.id, i.guid)).sort(),
    );
    assert.equal(state.feeds[FEED_B.id].etag, '"v2"');

    // A first fetch is unconditional and identifies itself.
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.headers.get("user-agent"), "Engram-feeds/1.0 (+https://engram.vedant.me)");
      assert.equal(call.headers.get("if-none-match"), null);
      assert.equal(call.headers.get("if-modified-since"), null);
    }
    assert.ok(logs.includes("engram-feeds: 2 feeds, 6 new, 0 not modified, 0 errors"));
  });
});

test("a second run that gets 304 writes nothing", async () => {
  await withRoot(async (root) => {
    await writeFeeds(root, [FEED_A, FEED_B]);
    await runMainWith(root, fakeFetch(twoFeedHandlers()).impl, NOW);
    const stateBefore = await readFile(join(root, "feeds", "state.json"), "utf8");
    const inboxBefore = await listInbox(root);

    const { impl, calls } = fakeFetch(twoFeedHandlers());
    const { result, logs } = await runMainWith(root, impl, NOW + 6 * HOUR);

    assert.deepEqual(result, { written: 0, errors: 0 });
    assert.equal(await readFile(join(root, "feeds", "state.json"), "utf8"), stateBefore);
    assert.deepEqual(await listInbox(root), inboxBefore);
    assert.ok(logs.includes("engram-feeds: 2 feeds, 0 new, 2 not modified, 0 errors"));

    // The stored validators were sent back, because the feed URL did not change.
    const byUrl = new Map(calls.map((c) => [c.url, c.headers]));
    assert.equal(byUrl.get(FEED_A.url)?.get("if-none-match"), '"v1"');
    assert.equal(byUrl.get(FEED_B.url)?.get("if-none-match"), '"v2"');
    assert.equal(byUrl.get(FEED_A.url)?.get("if-modified-since"), LAST_MODIFIED);
  });
});

test("a feed over 2 MB is reported as too large while other feeds are still written", async () => {
  await withRoot(async (root) => {
    await writeFeeds(root, [FEED_A, FEED_B]);
    const flags = { cancelled: false };
    const chunk = new Uint8Array(64 * 1024).fill(97);
    // 4 MB in 64 KB chunks, so the reader must stop it early.
    const oversized: Handler = () => {
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 64) {
            controller.close();
            return;
          }
          sent += 1;
          controller.enqueue(new Uint8Array(chunk));
        },
        cancel() {
          flags.cancelled = true;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      });
    };
    const { impl } = fakeFetch({
      [FEED_A.url]: oversized,
      [FEED_B.url]: serving(rss("Feed B", ITEMS_B), {}),
    });
    const { result, logs } = await runMainWith(root, impl);

    assert.deepEqual(result, { written: 3, errors: 1 });
    assert.equal(flags.cancelled, true);
    assert.deepEqual(
      await listInbox(root),
      ITEMS_B.map((i) => fileName(FEED_B.id, i.guid)).sort(),
    );
    assert.ok(logs.some((line) => line.includes("too large")));
    assert.ok(logs.includes("engram-feeds: 2 feeds, 3 new, 0 not modified, 1 errors"));

    const state = JSON.parse(await readFile(join(root, "feeds", "state.json"), "utf8"));
    assert.match(state.feeds[FEED_A.id].lastError.message, /too large/);
    assert.equal(state.feeds[FEED_B.id].seen.length, 3);
  });
});

test("a corrupt state file gives exit code 1 and writes nothing", async () => {
  await withRoot(async (root) => {
    await writeFeeds(root, [FEED_A]);
    await mkdir(join(root, "feeds"), { recursive: true });
    const corrupt = "{ this is not json";
    await writeFile(join(root, "feeds", "state.json"), corrupt, "utf8");
    const { impl } = fakeFetch({ [FEED_A.url]: serving(rss("Feed A", [post("a", 1)]), {}) });

    // Setting process.exitCode would fail this test file, so put it back afterwards.
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let threw = false;
    let exitCode: typeof process.exitCode = undefined;
    try {
      try {
        await runMainWith(root, impl);
      } catch {
        threw = true;
      }
      exitCode = process.exitCode;
    } finally {
      process.exitCode = priorExitCode;
    }

    assert.ok(threw || Number(exitCode) === 1, "expected exit code 1");
    assert.equal(await readFile(join(root, "feeds", "state.json"), "utf8"), corrupt);
    assert.deepEqual(await listInbox(root), []);
  });
});