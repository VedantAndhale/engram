import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeTitle, linksIn, linkText, parseTarget, retarget, unescapeTitle, WIKI_LINK, wikiLink } from "./links";

/** The title a written link leads to, read the way the app reads it. */
const target = (markdown: string) => {
  const m = [...markdown.matchAll(WIKI_LINK)];
  assert.equal(m.length, 1, `one link in ${markdown}`);
  return parseTarget(m[0][1]);
};

test("a plain title is written as it is", () => {
  assert.equal(wikiLink("Thinking, Fast and Slow"), "[[Thinking, Fast and Slow]]");
  assert.equal(wikiLink("Notes", "3f2a9c"), "[[Notes#^3f2a9c]]");
});

test("titles with | # [ ] still lead to themselves", () => {
  for (const title of ["C# notes", "A | B", "[Draft] plan", "Array[0]", "a#b|c[d]e", "100% sure", "50%23 off", "%5B literal"]) {
    const link = wikiLink(title);
    assert.deepEqual(target(link), { title }, link);
    assert.deepEqual(linksIn(`see ${link} here`), [title]);
    assert.equal(unescapeTitle(escapeTitle(title)), title);
  }
});

test("an escaped link shows the title as it reads", () => {
  assert.equal(linkText("C# notes"), "C%23 notes|C# notes");
  assert.equal(linkText("[Draft] plan"), "%5BDraft%5D plan|(Draft) plan");
  const m = [...wikiLink("A | B").matchAll(WIKI_LINK)][0];
  assert.equal(m[2], "A | B");
});

test("a highlight ref survives escaping", () => {
  const link = wikiLink("C# notes", "abc123");
  assert.deepEqual(target(link), { title: "C# notes", ref: "abc123" });
});

test("renaming to a title with # keeps links working", () => {
  const body = "See [[Old]], [[old#^abc123]] and [[Old|this one]]. Not [[Other]].";
  const out = retarget(body, "Old", "C# notes");
  assert.deepEqual(linksIn(out), ["C# notes", "C# notes", "C# notes", "Other"]);
  assert.match(out, /\[\[C%23 notes#\^abc123\|C# notes\]\]/);
  assert.match(out, /\[\[C%23 notes\|this one\]\]/);
});
