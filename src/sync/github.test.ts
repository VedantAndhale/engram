import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub, GitHubError } from "./github";

/*
 * The GitHub client, with fetch replaced by a canned response. Nothing here reaches GitHub.
 */

const repo = { id: 1, owner: "reader-user", repo: "engram-library", branch: "main" };

/** Runs `body` with every fetch answered by one response, then puts fetch back. */
async function withResponse(status: number, body: unknown, headers: Record<string, string>, run: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
}

/** The error a request throws, so the test can read its fields. */
async function errorFrom(status: number, body: unknown, headers: Record<string, string>): Promise<GitHubError> {
  let caught: unknown;
  await withResponse(status, body, headers, async () => {
    try {
      await new GitHub("token", repo).getTree("abc123");
    } catch (e) {
      caught = e;
    }
  });
  assert.ok(caught instanceof GitHubError, `expected a GitHubError, got ${String(caught)}`);
  return caught as GitHubError;
}

test("a tree GitHub cut short is refused, not taken as the whole folder", async () => {
  await withResponse(200, { tree: [{ path: "items/a.md", type: "blob", sha: "1" }], truncated: true }, {}, async () => {
    await assert.rejects(new GitHub("token", repo).getTree("abc123"), /too large .* Nothing has been deleted/);
  });
});

test("a complete tree lists its files and leaves out folders", async () => {
  const tree = [
    { path: "items", type: "tree", sha: "9" },
    { path: "items/a.md", type: "blob", sha: "1" },
    { path: "pdfs/b.pdf", type: "blob", sha: "2", size: 10 },
  ];
  await withResponse(200, { tree, truncated: false }, {}, async () => {
    const files = await new GitHub("token", repo).getTree("abc123");
    assert.deepEqual(files.map((f) => f.path), ["items/a.md", "pdfs/b.pdf"]);
  });
});

test("a 429 with no rate-limit headers waits at least a minute", async () => {
  const before = Date.now();
  const e = await errorFrom(429, { message: "Too many requests" }, {});
  assert.equal(e.status, 429);
  assert.equal(e.isRateLimit, true);
  assert.ok(e.retryAt! >= before + 60_000 - 50 && e.retryAt! <= Date.now() + 60_000 + 50);
});

test("a 403 with a secondary rate limit message and no headers is a rate limit", async () => {
  const before = Date.now();
  const e = await errorFrom(403, { message: "You have exceeded a secondary rate limit. Please wait a few minutes." }, {});
  assert.equal(e.isRateLimit, true);
  assert.ok(e.retryAt! >= before + 60_000 - 50);
});

test("a plain 403 with no headers is still an access problem", async () => {
  const e = await errorFrom(403, { message: "Resource not accessible by integration" }, {});
  assert.equal(e.status, 403);
  assert.equal(e.isRateLimit, false);
});

test("retry-after sets the wait", async () => {
  const before = Date.now();
  const e = await errorFrom(403, { message: "Forbidden" }, { "retry-after": "30" });
  assert.equal(e.isRateLimit, true);
  assert.ok(e.retryAt! >= before + 30_000 - 50 && e.retryAt! <= Date.now() + 30_000 + 50);
});

test("an exhausted primary limit waits until its reset time", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const e = await errorFrom(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
  assert.equal(e.isRateLimit, true);
  assert.equal(e.retryAt, reset * 1000);
});
