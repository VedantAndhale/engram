import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accessTtlMs,
  clientFor,
  OAUTH_TOKEN_TTL_MS,
  refreshable,
  REFRESH_TTL_MS,
  signInMode,
} from "../../mcp/oauth-config";

const APP = {
  GITHUB_APP_CLIENT_ID: "app-id",
  GITHUB_APP_CLIENT_SECRET: "app-secret",
};
const OAUTH = {
  GITHUB_CLIENT_ID: "oauth-id",
  GITHUB_CLIENT_SECRET: "oauth-secret",
};
const DAY = 24 * 60 * 60 * 1000;

test("signInMode is oauth without the SIGNIN_APP flag", () => {
  assert.equal(signInMode({ ...OAUTH }), "oauth");
  assert.equal(signInMode({ ...OAUTH, ...APP }), "oauth");
  assert.equal(signInMode({ ...APP, SIGNIN_APP: "0" }), "oauth");
});

test("signInMode is oauth when only one App value exists", () => {
  assert.equal(
    signInMode({ SIGNIN_APP: "1", GITHUB_APP_CLIENT_ID: "app-id" }),
    "oauth",
  );
  assert.equal(
    signInMode({ SIGNIN_APP: "1", GITHUB_APP_CLIENT_SECRET: "app-secret" }),
    "oauth",
  );
  assert.equal(
    signInMode({ SIGNIN_APP: "1", GITHUB_APP_CLIENT_ID: "", GITHUB_APP_CLIENT_SECRET: "x" }),
    "oauth",
  );
});

test("signInMode is app with the flag and both App values", () => {
  assert.equal(signInMode({ SIGNIN_APP: "1", ...APP }), "app");
  assert.equal(signInMode({ SIGNIN_APP: "1", ...APP, ...OAUTH }), "app");
});

test("clientFor returns the App pair in app mode", () => {
  assert.deepEqual(clientFor({ ...APP, ...OAUTH }, "app"), {
    id: "app-id",
    secret: "app-secret",
  });
});

test("clientFor returns the OAuth pair in oauth mode", () => {
  assert.deepEqual(clientFor({ ...APP, ...OAUTH }, "oauth"), {
    id: "oauth-id",
    secret: "oauth-secret",
  });
});

test("clientFor returns null when a value is missing", () => {
  assert.equal(clientFor({}, "oauth"), null);
  assert.equal(clientFor({ GITHUB_CLIENT_ID: "oauth-id" }, "oauth"), null);
  assert.equal(clientFor({ GITHUB_CLIENT_SECRET: "oauth-secret" }, "oauth"), null);
  assert.equal(clientFor({ GITHUB_APP_CLIENT_ID: "app-id" }, "app"), null);
  assert.equal(clientFor({ ...OAUTH }, "app"), null);
});

test("accessTtlMs uses expires_in in app mode", () => {
  assert.equal(accessTtlMs("app", 28800), 28_800_000);
});

test("accessTtlMs falls back to 30 days when app mode has no usable expires_in", () => {
  assert.equal(accessTtlMs("app"), 30 * DAY);
  assert.equal(accessTtlMs("app", 0), 30 * DAY);
  assert.equal(accessTtlMs("app", -5), 30 * DAY);
  assert.equal(accessTtlMs("app", Number.NaN), 30 * DAY);
});

test("accessTtlMs is 30 days in oauth mode", () => {
  assert.equal(accessTtlMs("oauth"), 30 * DAY);
  assert.equal(accessTtlMs("oauth", 28800), 30 * DAY);
  assert.equal(OAUTH_TOKEN_TTL_MS, 30 * DAY);
});

test("refresh tokens are kept for 180 days", () => {
  assert.equal(REFRESH_TTL_MS, 180 * DAY);
});

test("refreshable is true only in app mode", () => {
  assert.equal(refreshable("app"), true);
  assert.equal(refreshable("oauth"), false);
});