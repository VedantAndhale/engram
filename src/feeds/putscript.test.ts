import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubError } from "../sync/github";
import { APP_SLUG, type Installation } from "../sync/install";
import { putFeedScript, RepoNotReachableError, type ScriptGh } from "./putscript";

const mine: Installation = { id: 11, app_slug: APP_SLUG, repository_selection: "selected" };

// A stand-in for the GitHub client. `puts` lists what each PUT to the contents API answers, in order.
function fakeGh(opts: { installs: Installation[]; puts: (Error | "ok")[]; existing?: { sha: string } | null }) {
  const calls: string[] = [];
  const gh: ScriptGh = {
    getFile: async () => opts.existing ?? null,
    putFile: async (path, _text, sha) => {
      calls.push(`putFile ${path} sha=${sha ?? "none"}`);
      const next = opts.puts.shift();
      if (next instanceof Error) throw next;
      return "new-sha";
    },
    getRepo: async () => ({ id: 99 }),
    json: async <T>() => ({ installations: opts.installs }) as unknown as T,
    request: async (path: string, o?: { method?: string }) => {
      calls.push(`${o?.method ?? "GET"} ${path}`);
      return { status: 204 } as Response;
    },
  };
  return { gh, calls };
}

const notFound = () => new GitHubError(404, "Not Found");

test("writes the script straight away when the repo is reachable", async () => {
  const { gh, calls } = fakeGh({ installs: [mine], puts: ["ok"], existing: { sha: "old" } });
  await putFeedScript(gh, "feeds/action/fetch-feeds.mjs", "text");
  assert.deepEqual(calls, ["putFile feeds/action/fetch-feeds.mjs sha=old"]);
});

test("on a 404 it adds the repo to the App install, then writes again", async () => {
  const { gh, calls } = fakeGh({ installs: [mine], puts: [notFound(), "ok"] });
  await putFeedScript(gh, "feeds/action/fetch-feeds.mjs", "text");
  assert.deepEqual(calls, [
    "putFile feeds/action/fetch-feeds.mjs sha=none",
    "PUT /user/installations/11/repositories/99",
    "putFile feeds/action/fetch-feeds.mjs sha=none",
  ]);
});

test("on a 404 with no App install it says where to install the App", async () => {
  const { gh } = fakeGh({ installs: [], puts: [notFound()] });
  await assert.rejects(putFeedScript(gh, "p", "t"), RepoNotReachableError);
});

test("other errors pass straight through", async () => {
  const { gh, calls } = fakeGh({ installs: [mine], puts: [new GitHubError(409, "conflict")] });
  await assert.rejects(putFeedScript(gh, "p", "t"), /conflict/);
  assert.deepEqual(calls, ["putFile p sha=none"]);
});
