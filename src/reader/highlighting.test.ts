import { test } from "node:test";
import assert from "node:assert/strict";
import type { Annotation, Item } from "../model";
import { itemToMarkdown, joinPageParts } from "../notes/export";
import { bestOccurrence, joinBlocks, snapToWords } from "./anchor";
import { splitQuote, squash, squashContext } from "./quoteRects";
import { hasColumns, inColumns } from "./reflow";

const words = (text: string, start: number, end: number) => {
  const [s, e] = snapToWords(text, start, end);
  return text.slice(s, e);
};

test("a selection that cuts through words takes the whole words", () => {
  const text = "This recipe assumes you're very ambitious and needs to have the time.";
  // The drag that was stored as "ecipe assumes … needs to have t".
  const s = text.indexOf("ecipe");
  const e = text.indexOf("he time");
  assert.equal(words(text, s, e), "recipe assumes you're very ambitious and needs to have the");
});

test("a selection on word boundaries, or on spaces, is left as it is", () => {
  const text = "one two three";
  assert.equal(words(text, 4, 7), "two");
  assert.equal(words(text, 3, 8), " two ");
  assert.equal(words(text, 0, text.length), text);
});

test("apostrophes and accents stay inside a word; punctuation ends one", () => {
  assert.equal(words("we don't know", 5, 7), "don't");
  assert.equal(words("a café here", 3, 4), "café");
  assert.equal(words("(word), next", 2, 3), "word");
  assert.equal(words("end. Next", 1, 2), "end");
});

test("paragraphs in a quote are kept apart, words within one run on", () => {
  const p1 = {};
  const p2 = {};
  assert.equal(
    joinBlocks([
      { text: "end of the first", block: p1 },
      { text: " paragraph.", block: p1 },
      { text: "Start of the second", block: p2 },
    ]),
    "end of the first paragraph.\nStart of the second",
  );
  // Inline pieces of one paragraph (emphasis, links) join with no added space.
  assert.equal(joinBlocks([{ text: "un", block: p1 }, { text: "usual", block: p1 }]), "unusual");
  assert.equal(joinBlocks([{ text: "  a \n b  ", block: p1 }, { text: "   ", block: p2 }]), "a\nb");
});

test("context picks between repeats of a quote", () => {
  const text = "the cat sat. later the cat ran. then the cat slept.";
  const at = (prefix: string, suffix: string) => bestOccurrence(text, "the cat", { prefix, suffix });
  assert.equal(at("", ""), text.indexOf("the cat"));
  assert.equal(at("later ", " ran"), text.indexOf("the cat ran"));
  assert.equal(at("", " slept"), text.indexOf("the cat slept"));
  assert.equal(bestOccurrence(text, "the cat", {}, "last"), text.lastIndexOf("the cat"));
  assert.equal(bestOccurrence(text, "the dog"), -1);
  // A bonus counts with the context: here it outweighs none.
  const second = text.indexOf("the cat ran");
  assert.equal(bestOccurrence(text, "the cat", {}, "first", (i) => (i === second ? 8 : 0)), second);
});

test("context is compared squashed, as page text is", () => {
  const page = squash("Results. The model-based approach works. Later, the model based approach fails.").text;
  const wanted = squash("the model based approach").text;
  const hit = bestOccurrence(page, wanted, squashContext({ prefix: "Later,", suffix: "fails." }));
  assert.equal(hit, page.lastIndexOf(wanted));
});

test("a quote over a page break splits into each page's own words", () => {
  const quote = "the end of one page and the start of the next";
  const cut = squash("the end of one page").text.length;
  assert.deepEqual(splitQuote(quote, cut), ["the end of one page", "and the start of the next"]);
});

/** A page of runs: each line split into pieces at the given x ranges. */
const page = (rows: number, pieces: [number, number][], chars = 30) =>
  Array.from({ length: rows }, () => pieces.map(([x, end]) => ({ str: "x".repeat(chars), x, end }))).flat();

test("two columns with a gutter are found; one column is not", () => {
  // A two-column paper: left column 50..290, right column 310..550 on a 600-wide page.
  assert.equal(hasColumns(page(40, [[50, 290], [310, 550]]), 600), true);
  // A full-width title on top doesn't hide the gutter.
  assert.equal(hasColumns([{ str: "A Title Across The Whole Page", x: 100, end: 500 }, ...page(40, [[50, 290], [310, 550]])], 600), true);
  // One column, one run per line.
  assert.equal(hasColumns(page(40, [[50, 550]]), 600), false);
  // One column, a run per word: no line down the middle is clear of words on most lines.
  const wordy = Array.from({ length: 40 }, (_, row) =>
    Array.from({ length: 10 }, (_, w) => {
      const x = 50 + w * 50 + (row % 5) * 7;
      return { str: "word", x, end: x + 44 };
    }),
  ).flat();
  assert.equal(hasColumns(wordy, 600), false);
  // Too little text to tell.
  assert.equal(hasColumns(page(2, [[50, 290], [310, 550]]), 600), null);
});

test("a document is in columns when enough of its pages are", () => {
  assert.equal(inColumns([true, true, false, null]), true);
  assert.equal(inColumns([false, false, false, true]), false);
  assert.equal(inColumns([null, null]), false);
  assert.equal(inColumns([]), false);
});

const mark = (over: Partial<Annotation>): Annotation => ({ id: "x", doc: "d", kind: "highlight", page: 1, color: "#f7d154", createdAt: 1000, updatedAt: 1000, ...over });

test("a highlight saved as a part per page is listed once, with its words joined", () => {
  const joined = joinPageParts([
    mark({ id: "a", page: 3, quote: "the end of one page", createdAt: 1000 }),
    mark({ id: "b", page: 4, quote: "and the start of the next", createdAt: 1050 }),
    mark({ id: "c", page: 4, quote: "something else", createdAt: 90_000 }),
  ]);
  assert.equal(joined.length, 2);
  assert.equal(joined[0].id, "a");
  assert.equal(joined[0].page, 3);
  assert.equal(joined[0].quote, "the end of one page and the start of the next");
  assert.equal(joined[1].id, "c");
});

test("older copies of a highlight over a page break, each with the whole quote, are kept once", () => {
  const joined = joinPageParts([
    mark({ id: "a", page: 3, quote: "the whole passage", createdAt: 1000 }),
    mark({ id: "b", page: 4, quote: "the whole passage", createdAt: 1020 }),
  ]);
  assert.deepEqual(
    joined.map((a) => [a.id, a.quote]),
    [["a", "the whole passage"]],
  );
});

test("separate highlights are not joined: other colour, other document, not the next page, or later", () => {
  const base = mark({ id: "a", page: 3, quote: "one" });
  for (const other of [
    mark({ id: "b", page: 4, quote: "two", color: "#ff0000", createdAt: 1010 }),
    mark({ id: "b", page: 4, quote: "two", doc: "e", createdAt: 1010 }),
    mark({ id: "b", page: 5, quote: "two", createdAt: 1010 }),
    mark({ id: "b", page: 4, quote: "two", createdAt: 60_000 }),
  ]) {
    assert.equal(joinPageParts([base, other]).length, 2);
  }
});

test("an item's Markdown lists a video's timed notes, linked to their moments", () => {
  const video = { id: "v", type: "video", title: "A talk", sourceUrl: "https://www.youtube.com/watch?v=abc123" } as Item;
  const md = itemToMarkdown(video, [
    mark({ id: "m2", doc: "v", kind: "moment", page: 0, color: "", at: 3725, note: "the second point" }),
    mark({ id: "m1", doc: "v", kind: "moment", page: 0, color: "", at: 90, note: "the first point" }),
    mark({ id: "m3", doc: "v", kind: "moment", page: 0, color: "", at: 5, note: "gone", deleted: true }),
  ]);
  assert.match(md, /## Notes\n\n- \[1:30\]\(https:\/\/www\.youtube\.com\/watch\?v=abc123&t=90s\) the first point\n- \[1:02:05\]\([^)]*t=3725s\) the second point\n/);
  assert.doesNotMatch(md, /gone/);
});
