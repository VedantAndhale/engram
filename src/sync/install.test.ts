import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_SLUG, pickInstallation, reachRepo, type Installation } from "./install";

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