import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub, GitHubError } from "./github";

const repo = { id: 1, owner: "reader-user", repo: "engram-library", branch: "main" };

type Call = { method: string; url: string; body: unknown };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Answers the calls commitFiles makes and records each one. `refStatus` is the answer to the ref update.
function fakeGit(refStatus: number, calls: Call[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET" && url.endsWith("/git/commits/base1")) return json({ sha: "base1", tree: { sha: "tree0" } });
    if (method === "POST" && url.endsWith("/git/trees")) return json({ sha: "tree1" });
    if (method === "POST" && url.endsWith("/git/commits")) return json({ sha: "commit1" });
    if (method === "PATCH" && url.endsWith("/git/refs/heads/main")) {
      return refStatus === 200 ? json({ ref: "refs/heads/main" }) : json({ message: "Update is not a fast forward" }, refStatus);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
}

async function withFakeGit<T>(refStatus: number, calls: Call[], run: (gh: GitHub) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = fakeGit(refStatus, calls) as typeof fetch;
  try {
    return await run(new GitHub("token", repo));
  } finally {
    globalThis.fetch = real;
  }
}

test("commitFiles sends one tree with inline text and null deletes, then returns the new commit", async () => {
  const calls: Call[] = [];
  const sha = await withFakeGit(200, calls, (gh) =>
    gh.commitFiles(
      [
        { path: "items/2026/10/a.md", text: "# A" },
        { path: "inbox/gone.md", text: null },
      ],
      "Sync 2 changes",
      "base1",
    ),
  );
  assert.equal(sha, "commit1");
  const tree = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"));
  assert.deepEqual(tree?.body, {
    base_tree: "tree0",
    tree: [
      { path: "items/2026/10/a.md", mode: "100644", type: "blob", content: "# A" },
      { path: "inbox/gone.md", mode: "100644", type: "blob", sha: null },
    ],
  });
  const commit = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"));
  assert.deepEqual(commit?.body, { message: "Sync 2 changes", tree: "tree1", parents: ["base1"] });
  const ref = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(ref?.body, { sha: "commit1", force: false });
});

test("commitFiles returns null when the branch moved on, so nothing is overwritten", async () => {
  const calls: Call[] = [];
  const sha = await withFakeGit(422, calls, (gh) => gh.commitFiles([{ path: "a.md", text: "x" }], "Sync 1 change", "base1"));
  assert.equal(sha, null);
});

test("commitFiles passes other failures on to the caller", async () => {
  const calls: Call[] = [];
  await assert.rejects(
    withFakeGit(500, calls, (gh) => gh.commitFiles([{ path: "a.md", text: "x" }], "Sync 1 change", "base1")),
    (e: unknown) => e instanceof GitHubError && e.status === 500,
  );
});
