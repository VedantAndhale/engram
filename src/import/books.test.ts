import { test } from "node:test";
import assert from "node:assert/strict";
import { importRef } from "./ref";
import type { ImportBook } from "./types";

// Only the fields importRef reads; the rest is filler.
const make = (source: string, key: string): ImportBook =>
  ({ source, key, title: "Walden", author: "", notes: [], highlights: [] }) as unknown as ImportBook;

test("importRef starts with the source name", async () => {
  assert.ok((await importRef(make("kindle", "walden|thoreau"))).startsWith("kindle:"));
  assert.ok((await importRef(make("readwise", "walden|thoreau"))).startsWith("readwise:"));
});

test("importRef is stable for the same book", async () => {
  assert.equal(await importRef(make("kindle", "walden|thoreau")), await importRef(make("kindle", "walden|thoreau")));
});

test("importRef differs for different books", async () => {
  assert.notEqual(await importRef(make("kindle", "walden|thoreau")), await importRef(make("kindle", "emile|rousseau")));
});