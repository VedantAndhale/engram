import { test } from "node:test";
import assert from "node:assert/strict";
import { firstSentence, plainAnswer } from "./format";

test("firstSentence is the first sentence without marks or citations", () => {
  assert.equal(firstSentence("**The Nile** runs north [¶2]. It ends at the sea."), "The Nile runs north.");
  assert.equal(firstSentence("- First point [Page 3]\n- Second"), "First point");
});

test("firstSentence keeps an answer with no full stop whole, and cuts a long one at a word", () => {
  assert.equal(firstSentence("It flows north"), "It flows north");
  const cut = firstSentence(`${"word ".repeat(60)}end.`, 40);
  assert.ok(cut.endsWith("…") && cut.length <= 41);
  assert.equal(firstSentence(""), "");
});

test("plainAnswer removes emphasis, code and heading marks", () => {
  assert.equal(plainAnswer("## Title\n\n**Bold** and *italic* and `code`"), "Title\n\nBold and italic and code");
});

test("plainAnswer turns bullets into dots and keeps numbers", () => {
  assert.equal(plainAnswer("- one\n- two\n\n1. first\n2. second"), "• one\n• two\n\n1. first\n2. second");
});

test("plainAnswer keeps the words of a link and drops its address", () => {
  assert.equal(plainAnswer("See [the source](https://example.com)."), "See the source.");
});
