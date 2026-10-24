import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_FEEDS } from "./config";

// The Action keeps its own copy of the cap, because it runs on its own in the user's repo. The two must agree,
// or the app would allow feeds the Action ignores.
test("the Action and the app use the same feed limit", () => {
  const source = readFileSync(new URL("./action/fetch-feeds.mjs", import.meta.url), "utf8");
  const found = /^const MAX_FEEDS = (\d+);/m.exec(source);
  assert.ok(found, "fetch-feeds.mjs has no MAX_FEEDS line");
  assert.equal(Number(found[1]), MAX_FEEDS);
});
