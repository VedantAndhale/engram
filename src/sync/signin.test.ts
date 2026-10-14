import { test } from "node:test";
import assert from "node:assert/strict";
import { signInFromParams } from "./signin";

test("token, refresh and expires give an expiry time from now", () => {
  const p = new URLSearchParams({ token: "ghu_abc", refresh: "sealed-refresh", expires: "28800" });
  assert.deepEqual(signInFromParams(p, 1_000), { token: "ghu_abc", refresh: "sealed-refresh", expiresAt: 1_000 + 28_800 * 1000 });
});

test("an OAuth sign-in with only a token has no refresh or expiry", () => {
  assert.deepEqual(signInFromParams(new URLSearchParams({ token: "gho_abc" }), 1_000), { token: "gho_abc" });
});

test("an error and no token gives that error", () => {
  assert.deepEqual(signInFromParams(new URLSearchParams({ error: "Access denied." })), { error: "Access denied." });
});

test("no token and no error gives the generic failure", () => {
  assert.deepEqual(signInFromParams(new URLSearchParams()), { error: "GitHub sign-in failed." });
});

test("a non-numeric expires gives no expiry", () => {
  const r = signInFromParams(new URLSearchParams({ token: "ghu_abc", refresh: "r", expires: "soon" }), 1_000);
  assert.deepEqual(r, { token: "ghu_abc", refresh: "r" });
});

test("a zero or negative expires gives no expiry", () => {
  assert.deepEqual(signInFromParams(new URLSearchParams({ token: "ghu_abc", expires: "0" })), { token: "ghu_abc" });
  assert.deepEqual(signInFromParams(new URLSearchParams({ token: "ghu_abc", expires: "-5" })), { token: "ghu_abc" });
});