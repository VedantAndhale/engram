import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub, GitHubError } from "./github";

// A failed request whose answer has no JSON message, as GitHub's gateway sends. Over HTTP/2 there is no status
// text either, so the message must still say what happened.
const repo = { id: 1, owner: "reader-user", repo: "engram-library", branch: "main" };

async function errorFromRaw(status: number, text: string): Promise<GitHubError> {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(text, { status, headers: { "content-type": "text/html" } });
  try {
    await new GitHub("token", repo).getTree("abc123");
  } catch (e) {
    return e as GitHubError;
  } finally {
    globalThis.fetch = real;
  }
  throw new Error("the request did not fail");
}

test("a gateway error with no body names its status", async () => {
  const e = await errorFromRaw(502, "<html>Bad gateway</html>");
  assert.equal(e.status, 502);
  assert.equal(e.message, "GitHub answered 502");
});

test("an empty error body still names its status", async () => {
  const e = await errorFromRaw(500, "");
  assert.equal(e.message, "GitHub answered 500");
});
