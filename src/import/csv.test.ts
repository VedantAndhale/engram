import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./csv";

test("handles quoted commas, escaped quotes, CRLF, newlines in quotes and a BOM", () => {
  const text = "\uFEFFa,b\r\n\"x, y\",\"say \"\"hi\"\"\"\r\n\"line1\nline2\",z\r\n";
  const { rows, warnings } = parseCsv(text);
  assert.deepEqual(rows, [
    ["a", "b"],
    ["x, y", "say \"hi\""],
    ["line1\nline2", "z"],
  ]);
  assert.deepEqual(warnings, []);
});

test("ignores a final empty line and works with plain LF", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n\n").rows, [["a", "b"], ["1", "2"]]);
});

test("a blank line in the middle of the file is not a row, so it is not reported as ragged", () => {
  const { rows, warnings } = parseCsv("a,b\n1,2\n\n3,4\n");
  assert.deepEqual(rows, [["a", "b"], ["1", "2"], ["3", "4"]]);
  assert.deepEqual(warnings, []);
});

test("keeps ragged rows, reports them, and caps warnings at 50", () => {
  const { rows, warnings } = parseCsv("a,b,c\n1,2\n1,2,3,4\n1,2,3\n");
  assert.equal(rows.length, 4);
  assert.deepEqual(warnings, ["Row 2 has 2 fields, expected 3", "Row 3 has 4 fields, expected 3"]);

  const many = parseCsv("a,b\n" + "x\n".repeat(60));
  assert.equal(many.rows.length, 61);
  assert.equal(many.warnings.length, 50);
});