import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKindle } from "./kindle";

const SEP = "==========";
const ADDED = "Added on Monday, 1 January 2024 10:00:00 AM";

function clip(title: string, meta: string, body: string): string {
  return `${title}\n${meta}\n\n${body}\n${SEP}\n`;
}

const BOOK_A = "Thinking (Fast and Slow) (Daniel Kahneman)";
const BOOK_B = "Atomic Habits (James Clear)";

// Real files start with a BOM and use CRLF, so the fixture does too.
const fixture = ("\uFEFF" + [
  clip(BOOK_A, `- Your Highlight on page 5 | location 100-101 | ${ADDED}`, "System 1 operates automatically"),
  clip(BOOK_A, `- Your Highlight on page 5 | location 100-103 | ${ADDED}`, "System 1 operates automatically and quickly"),
  clip(BOOK_A, `- Your Bookmark on page 12 | location 200 | ${ADDED}`, ""),
  clip(BOOK_A, `- Your Highlight on page 20 | location 300-302 | ${ADDED}`, "Losses loom larger than gains"),
  clip(BOOK_A, `- Your Highlight on page 20 | location 300-302 | ${ADDED}`, "Losses loom larger than gains"),
  clip(BOOK_A, `- Your Note on page 20 | location 301 | ${ADDED}`, "check this against prospect theory"),
  clip(BOOK_A, `- Your Note on page 90 | location 999 | ${ADDED}`, "orphan thought"),
  clip(BOOK_B, `- Your Highlight on page 9 | location 50 | ${ADDED}`, "Habits are the compound interest of self-improvement"),
  clip(BOOK_B, `- Your Highlight on page 2 | location 10-11 | ${ADDED}`, "You do not rise to the level of your goals"),
  clip("Livre (Auteur)", "- Votre surlignement | emplacement 100-101", "Texte"),
].join("")).replace(/\n/g, "\r\n");

test("parses two books with dedupe, extended clips, notes, bookmarks and sorting", () => {
  const { books, warnings } = parseKindle(fixture);
  assert.equal(books.length, 2);
  assert.deepEqual(books[0], {
    source: "kindle",
    key: "thinking (fast and slow)|daniel kahneman",
    title: "Thinking (Fast and Slow)",
    author: "Daniel Kahneman",
    highlights: [
      { quote: "System 1 operates automatically and quickly", location: "100-103" },
      { quote: "Losses loom larger than gains", location: "300-302", note: "check this against prospect theory" },
    ],
    notes: ["orphan thought"],
  });
  // Sorted by location, not by the order Kindle wrote them.
  assert.deepEqual(
    books[1]?.highlights.map((h) => h.location),
    ["10-11", "50"],
  );
  assert.equal(books[1]?.author, "James Clear");
  assert.deepEqual(warnings, ["Skipped a clip in an unsupported language at entry 10"]);
});

test("a title with no trailing author group keeps the whole line", () => {
  const { books } = parseKindle(clip("Untitled Notes", "- Your Highlight at location 5 | " + ADDED, "Hello"));
  assert.equal(books[0]?.title, "Untitled Notes");
  assert.equal(books[0]?.author, undefined);
  assert.equal(books[0]?.key, "untitled notes|");
});