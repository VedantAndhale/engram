import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_SLUG, grantFolderRepo, pickInstallation, reachRepo, type Installation } from "./install";

const mine: Installation = { id: 11, app_slug: APP_SLUG, repository_selection: "selected" };
const other: Installation = { id: 22, app_slug: "some-other-app", repository_selection: "all" };

test("pickInstallation finds the Engram Reader install among others", () => {
  assert.equal(pickInstallation([other, mine]), mine);
});

test("pickInstallation returns null when Engram Reader isn't installed", () => {
  assert.equal(pickInstallation([other]), null);
  assert.equal(pickInstallation([]), null);
});

// A stand-in for the GitHub client: one list of installs, one answer for the PUT.
function fakeGh(installations: Installation[], put: number | Error) {
  const calls: string[] = [];
  return {
    calls,
    json: async <T>() => ({ installations }) as unknown as T,
    request: async (path: string, opts?: { method?: string }) => {
      calls.push(`${opts?.method ?? "GET"} ${path}`);
      if (put instanceof Error) throw put;
      return { status: put } as Response;
    },
  };
}

test("reachRepo adds the repo to the install", async () => {
  const gh = fakeGh([other, mine], 204);
  assert.equal(await reachRepo(gh, 99), "added");
  assert.deepEqual(gh.calls, ["PUT /user/installations/11/repositories/99"]);
});

test("reachRepo treats 304 as already added", async () => {
  assert.equal(await reachRepo(fakeGh([mine], 304), 99), "added");
});

test("reachRepo says not-installed and makes no PUT when there is no install", async () => {
  const gh = fakeGh([other], 204);
  assert.equal(await reachRepo(gh, 99), "not-installed");
  assert.deepEqual(gh.calls, []);
});

test("reachRepo returns failed for refusals and thrown errors", async () => {
  assert.equal(await reachRepo(fakeGh([mine], 403), 99), "failed");
  assert.equal(await reachRepo(fakeGh([mine], 404), 99), "failed");
  assert.equal(await reachRepo(fakeGh([mine], 422), 99), "failed");
  assert.equal(await reachRepo(fakeGh([mine], new Error("offline")), 99), "failed");
});

// grantFolderRepo calls GitHub through fetch. Each request is recorded as "METHOD /path".
async function withFetch(answer: (method: string, path: string) => Response, run: () => Promise<void>): Promise<string[]> {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname;
    calls.push(`${method} ${path}`);
    return answer(method, path);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = (status: number) => new Response(null, { status });
const folderRepo = { owner: "vedant", repo: "folder-x", branch: "main" };

test("grantFolderRepo uses the saved repo id, so no lookup is made", async () => {
  let outcome: unknown;
  const calls = await withFetch(
    (_method, path) => (path === "/user/installations" ? json({ installations: [mine] }) : empty(204)),
    async () => {
      outcome = await grantFolderRepo("token", { ...folderRepo, id: 99 });
    },
  );
  assert.deepEqual(outcome, { result: "added", status: 204 });
  assert.deepEqual(calls, ["GET /user/installations", "PUT /user/installations/11/repositories/99"]);
});

test("grantFolderRepo looks the id up for an older folder without one", async () => {
  let outcome: unknown;
  const calls = await withFetch(
    (_method, path) => {
      if (path === "/repos/vedant/folder-x") return json({ id: 99 });
      if (path === "/user/installations") return json({ installations: [mine] });
      return empty(204);
    },
    async () => {
      outcome = await grantFolderRepo("token", folderRepo);
    },
  );
  assert.deepEqual(outcome, { result: "added", status: 204 });
  assert.deepEqual(calls, [
    "GET /user/installations",
    "GET /repos/vedant/folder-x",
    "GET /user/installations",
    "PUT /user/installations/11/repositories/99",
  ]);
});

test("grantFolderRepo reports a 404 from the lookup instead of throwing", async () => {
  let outcome: unknown;
  const calls = await withFetch(
    (_method, path) => (path === "/user/installations" ? json({ installations: [mine] }) : json({ message: "Not Found" }, 404)),
    async () => {
      outcome = await grantFolderRepo("token", folderRepo);
    },
  );
  assert.deepEqual(outcome, { result: "failed", status: 404, message: "Not Found" });
  assert.deepEqual(calls, ["GET /user/installations", "GET /repos/vedant/folder-x"]);
});

test("grantFolderRepo says not-installed, without a lookup, when the App isn't on the account", async () => {
  let outcome: unknown;
  const calls = await withFetch(
    () => json({ installations: [other] }),
    async () => {
      outcome = await grantFolderRepo("token", folderRepo);
    },
  );
  assert.deepEqual(outcome, { result: "not-installed" });
  assert.deepEqual(calls, ["GET /user/installations"]);
});