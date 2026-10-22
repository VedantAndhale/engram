import { test } from "node:test";
import assert from "node:assert/strict";
import { plainAnswer } from "./format";

test("plainAnswer removes emphasis, code and heading marks", () => {
  assert.equal(plainAnswer("## Title\n\n**Bold** and *italic* and `code`"), "Title\n\nBold and italic and code");
});

test("plainAnswer turns bullets into dots and keeps numbers", () => {
  assert.equal(plainAnswer("- one\n- two\n\n1. first\n2. second"), "• one\n• two\n\n1. first\n2. second");
});

test("plainAnswer keeps the words of a link and drops its address", () => {
  assert.equal(plainAnswer("See [the source](https://example.com)."), "See the source.");
});
