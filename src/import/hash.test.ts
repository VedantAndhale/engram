import { test } from "node:test";
import assert from "node:assert/strict";
import { refId } from "./hash";

test("refId is stable, differs per input, and is 24 hex chars", async () => {
  const a = await refId("kindle|dune|frank herbert");
  assert.equal(a, await refId("kindle|dune|frank herbert"));
  assert.notEqual(a, await refId("kindle|dune|frank herbert "));
  assert.match(a, /^[0-9a-f]{24}$/);
  // The SHA-256 of "abc" is a published value, so this pins the algorithm itself.
  assert.equal(await refId("abc"), "ba7816bf8f01cfea414140de");
});