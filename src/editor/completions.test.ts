import { test } from "node:test";
import assert from "node:assert/strict";
import { titleOptions } from "./completions";

test("each title is offered once; shared titles say so", () => {
  const opts = titleOptions(["Plan", "Inbox", "inbox", "C# notes"]);
  assert.deepEqual(
    opts.map((o) => [o.label, o.detail]),
    [
      ["Plan", undefined],
      ["Inbox", "2 items share this title"],
      ["C# notes", undefined],
    ],
  );
});

test("with ids, items that share a title each get their own choice", () => {
  const opts = titleOptions([
    { title: "Inbox", id: "n1", detail: "Note · May" },
    { title: "Inbox", id: "n2", detail: "Note · June" },
  ]);
  assert.deepEqual(
    opts.map((o) => o.detail),
    ["Note · May", "Note · June"],
  );
});
