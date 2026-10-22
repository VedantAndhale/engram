import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerBody, ArticleBody } from "./markdown";

const answer = (text: string) => renderToStaticMarkup(createElement(AnswerBody, { text }));
const article = (text: string) => renderToStaticMarkup(createElement(ArticleBody, { text, markdown: true }));

test("an answer draws bullets and bold", () => {
  const html = answer("- **Rhine** rises in the Alps\n- It flows north");
  assert.match(html, /^<ul><li><p><strong>Rhine<\/strong> rises in the Alps<\/p><\/li><li><p>It flows north<\/p><\/li><\/ul>$/);
});

test("an answer never draws an image or an outside link", () => {
  const html = answer("See ![chart](https://evil.example/x.png) and [this](https://evil.example/page) or https://evil.example/raw");
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /chart/);
  assert.match(html, /this/);
});

test("an article still keeps its outside links", () => {
  const html = article("[this](https://example.com/page)");
  assert.match(html, /<a href="https:\/\/example\.com\/page"/);
});

test("an answer draws headings small, under the dialog title", () => {
  assert.match(answer("# Big\n\ntext"), /<h3>Big<\/h3>/);
  assert.match(answer("#### Deep\n\ntext"), /<h4>Deep<\/h4>/);
});

test("an unfinished marker shows as text while the answer streams", () => {
  const html = answer("The Rhine **rises");
  assert.match(html, /\*\*rises/);
});

test("raw HTML in an answer is dropped, not drawn", () => {
  const html = answer("Hello <script>alert(1)</script> there");
  assert.doesNotMatch(html, /<script/);
});

test("a page citation becomes a button only for a page that was sent", () => {
  const cite = { kind: "page" as const, numbers: new Set([3, 4]), onOpen: () => undefined };
  const html = renderToStaticMarkup(createElement(AnswerBody, { text: "The toll is set [Page 3]. Ships pass [Page 9].", cite }));
  assert.match(html, /<button type="button" class="cite">Page 3<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*>Page 9</);
  assert.match(html, /<span>Page 9<\/span>/);
});

test("a list of page labels gives one citation for each page", () => {
  const cite = { kind: "page" as const, numbers: new Set([3, 4]), onOpen: () => undefined };
  const html = renderToStaticMarkup(createElement(AnswerBody, { text: "Both agree [Pages 3, 4].", cite }));
  assert.match(html, /class="cite">Page 3</);
  assert.match(html, /class="cite">Page 4</);
});

test("without a PDF, page labels stay as plain text", () => {
  assert.match(answer("See [Page 3] of the book."), /\[Page 3\] of the book/);
});

test("a paragraph citation becomes a button only when that paragraph was sent, for an article", () => {
  const cite = { kind: "para" as const, numbers: new Set([3, 4]), onOpen: () => undefined };
  const html = renderToStaticMarkup(createElement(AnswerBody, { text: "The dam is in [¶3]. The fish ladder is in [¶9].", cite }));
  assert.match(html, /<button type="button" class="cite">¶3<\/button>/);
  assert.match(html, /<span>¶9<\/span>/);
});

test("a list of paragraph citations gives one link each", () => {
  const cite = { kind: "para" as const, numbers: new Set([3, 4]), onOpen: () => undefined };
  const html = renderToStaticMarkup(createElement(AnswerBody, { text: "Both agree [¶3, 4].", cite }));
  assert.match(html, /class="cite">¶3</);
  assert.match(html, /class="cite">¶4</);
});

test("a paragraph label in a PDF's answer stays plain text, and a page label in an article's stays plain", () => {
  const pdf = { kind: "page" as const, numbers: new Set([3]), onOpen: () => undefined };
  assert.doesNotMatch(renderToStaticMarkup(createElement(AnswerBody, { text: "See [¶3].", cite: pdf })), /class="cite"/);
  const para = { kind: "para" as const, numbers: new Set([3]), onOpen: () => undefined };
  assert.doesNotMatch(renderToStaticMarkup(createElement(AnswerBody, { text: "See [Page 3].", cite: para })), /class="cite"/);
});
