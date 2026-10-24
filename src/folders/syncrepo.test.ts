import { test } from "node:test";
import assert from "node:assert/strict";
import type { RepoRef } from "../model";
import { syncRepo } from "./pick";

const mine: RepoRef = { id: 1, owner: "VedantAndhale", repo: "engram-my-library", branch: "main" };

test("a folder syncs to a repository its own account owns", () => {
  assert.equal(syncRepo(mine, "VedantAndhale"), mine);
});

test("a repository owned by another account is kept but not used", () => {
  assert.equal(syncRepo(mine, "SyntaxIntel"), undefined);
});

test("with no account signed in, no repository is used", () => {
  assert.equal(syncRepo(mine, undefined), undefined);
  assert.equal(syncRepo(undefined, "VedantAndhale"), undefined);
});

test("account names compare without regard to case", () => {
  assert.equal(syncRepo(mine, "vedantandhale"), mine);
});
