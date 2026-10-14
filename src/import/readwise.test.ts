import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReadwiseCsv } from "./readwise";

test("maps columns by name, groups by book, skips empty highlights, carries warnings", () => {
  const csv = [
    "Book Author,HIGHLIGHT,Note,book title,Location,Color",
    "Cal Newport,\"Focus is a skill, not a gift\",my note,Deep Work,12,yellow",
    "Cal Newport,,ignored,Deep Work,13,yellow",
    "Cal Newport,Quality = time x intensity,,Deep Work,40,blue",
    "Anon,Something else,,Other Book,,yellow",
    "Anon",
  ].join("\n");
  const { books, warnings } = parseReadwiseCsv(csv);
  assert.equal(books.length, 2);
  assert.deepEqual(books[0], {
    source: "readwise",
    key: "deep work|cal newport",
    title: "Deep Work",
    author: "Cal Newport",
    highlights: [
      { quote: "Focus is a skill, not a gift", note: "my note", location: "12" },
      { quote: "Quality = time x intensity", location: "40" },
    ],
    notes: [],
  });
  assert.deepEqual(books[1]?.highlights, [{ quote: "Something else" }]);
  assert.deepEqual(warnings, ["Row 6 has 1 fields, expected 6"]);
});

test("throws a clear error when the header is not a Readwise export", () => {
  assert.throws(() => parseReadwiseCsv("Title,Text\nA,B\n"), /not a Readwise highlights export/);
  assert.throws(() => parseReadwiseCsv("Highlight,Note\nA,B\n"), /not a Readwise highlights export/);
});