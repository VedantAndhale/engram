import { test } from "node:test";
import assert from "node:assert/strict";
import type { Folder } from "../model";
import { LIBRARY_NAME, pickLibrary } from "./pick";

const folder = (id: string, name: string, createdAt: number): Folder => ({ id, name, createdAt, updatedAt: createdAt });
const essays = folder("e", "essays", 1);
const library = folder("l", LIBRARY_NAME, 2);
const pdfs = folder("p", "Technical Pdfs", 3);

test("the folder chosen by id wins", () => {
  assert.equal(pickLibrary([essays, library, pdfs], "p")?.id, "p");
});

test("without a choice, the folder named My library", () => {
  assert.equal(pickLibrary([essays, library, pdfs])?.id, "l");
});

test("a renamed library is still found by its id", () => {
  const renamed = folder("l", "Reading", 2);
  assert.equal(pickLibrary([essays, renamed, pdfs], "l")?.id, "l");
});

test("with no choice and no My library, the oldest folder takes it", () => {
  assert.equal(pickLibrary([pdfs, essays])?.id, "e");
});

test("a chosen folder that is hidden does not stop the fallback", () => {
  assert.equal(pickLibrary([essays, pdfs], "l")?.id, "e");
});

test("no folders, no library", () => {
  assert.equal(pickLibrary([]), undefined);
});
