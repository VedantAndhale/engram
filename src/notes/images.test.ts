import { test } from "node:test";
import assert from "node:assert/strict";
import { piecesOf, withoutPictures } from "./images";

const pic = "![shot](data:image/jpeg;base64,QUJD+/==)";

test("a note with no picture is one piece of text", () => {
  assert.deepEqual(piecesOf("just words"), [{ text: "just words" }]);
  assert.deepEqual(piecesOf(""), []);
});

test("text and pictures come out in order", () => {
  assert.deepEqual(piecesOf(`before ${pic} after`), [
    { text: "before " },
    { alt: "shot", src: "data:image/jpeg;base64,QUJD+/==" },
    { text: " after" },
  ]);
  assert.deepEqual(piecesOf(`${pic}${pic}`), [
    { alt: "shot", src: "data:image/jpeg;base64,QUJD+/==" },
    { alt: "shot", src: "data:image/jpeg;base64,QUJD+/==" },
  ]);
});

test("a picture that is not embedded data stays as the text it is", () => {
  assert.deepEqual(piecesOf("see ![x](https://example.com/a.png)"), [{ text: "see ![x](https://example.com/a.png)" }]);
});

test("search and previews see a word for each picture, not its data", () => {
  assert.equal(withoutPictures(`a ${pic} b`), "a [picture] b");
  assert.equal(withoutPictures("no picture"), "no picture");
});
