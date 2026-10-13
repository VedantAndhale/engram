import { test } from "node:test";
import assert from "node:assert/strict";
import { capText, CUT_NOTE, pageCharset, pdfUrl, shrinks, toMarkdown, withBreaks } from "./extract";

/*
 * Node has no DOM, so the Markdown walker is given a few stand-in nodes: just what it reads (tag names,
 * children, text). Links and images need a real document, so they are left to the browser.
 */

class FakeNode {
  childNodes: FakeNode[] = [];
  constructor(readonly nodeType: number) {}
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
}
class FakeText extends FakeNode {
  constructor(readonly data: string) {
    super(3);
  }
  override get textContent() {
    return this.data;
  }
}
class FakeElement extends FakeNode {
  constructor(readonly tagName: string, kids: (FakeNode | string)[]) {
    super(1);
    this.childNodes = kids.map((k) => (typeof k === "string" ? new FakeText(k) : k));
  }
  get children() {
    return this.childNodes.filter((c) => c instanceof FakeElement);
  }
  getAttribute() {
    return null;
  }
}
Object.assign(globalThis, { Node: { TEXT_NODE: 3 }, Element: FakeElement });

const h = (tag: string, ...kids: (FakeNode | string)[]) => new FakeElement(tag.toUpperCase(), kids);
const md = (root: FakeElement) => toMarkdown(root as unknown as Element);
const br = () => h("br");

test("paragraphs inside an inline wrapper stay apart (paulgraham.com)", () => {
  const page = h("div", h("span", "July 2023", h("p", "If you collected lists."), h("p", "Second ", h("b", "point"), ".")));
  assert.equal(md(page), "July 2023\n\nIf you collected lists.\n\nSecond **point**.");
});

test("a wrapper nested deeper still keeps its paragraphs", () => {
  const page = h("div", h("font", h("span", h("p", "One."), h("p", "Two."))));
  assert.equal(md(page), "One.\n\nTwo.");
});

test("one <br> is a line break, two are a paragraph break", () => {
  assert.equal(md(h("div", h("p", "Roses are red", br(), "violets are blue"))), "Roses are red\\\nviolets are blue");
  assert.equal(md(h("div", "First paragraph.", br(), br(), "Second paragraph.")), "First paragraph.\n\nSecond paragraph.");
  assert.equal(md(h("div", h("p", "a ", br(), " ", br(), br(), " b"))), "a\n\nb");
});

test("a <br> at the start or end of a paragraph leaves nothing behind", () => {
  assert.equal(md(h("div", h("p", br(), "words", br()))), "words");
});

test("a <br> in a heading is a space", () => {
  assert.equal(md(h("div", h("h2", "Part", br(), "one"))), "## Part one");
});

test("a line after a break that looks like a list stays text", () => {
  assert.equal(withBreaks("intro\uE000- not a list\uE0001. nor this"), "intro\\\n\\- not a list\\\n1\\. nor this");
});

test("the break marker in page text is dropped, not turned into a break", () => {
  assert.equal(md(h("div", h("p", "odd\uE000text"))), "oddtext");
});

test("a long text is cut at a paragraph break and marked as cut", () => {
  const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}`;
  assert.equal(capText(text, 200, true), text);
  assert.equal(capText(text, 100, true), `${"a".repeat(60)}\n\n*${CUT_NOTE}*`);
  assert.equal(capText(text, 100, false), `${"a".repeat(60)}\n\n[${CUT_NOTE}]`);
  // No paragraph break late enough: cut at the cap.
  assert.equal(capText("x".repeat(50), 20, true), `${"x".repeat(20)}\n\n*${CUT_NOTE}*`);
});

test("a much shorter copy of a page doesn't replace the saved one", () => {
  const full = "word ".repeat(1000);
  assert.equal(shrinks("Subscribe to keep reading.", full), true);
  assert.equal(shrinks(`**${"word ".repeat(900)}**`, full), false);
  assert.equal(shrinks("anything", undefined), false);
  assert.equal(shrinks("anything", ""), false);
});

test("PDF links are recognised, arXiv pages included", () => {
  assert.equal(pdfUrl("https://example.com/papers/a.PDF"), "https://example.com/papers/a.PDF");
  assert.equal(pdfUrl("https://arxiv.org/abs/1706.03762"), "https://arxiv.org/pdf/1706.03762");
  assert.equal(pdfUrl("https://arxiv.org/abs/1706.03762v7"), "https://arxiv.org/pdf/1706.03762v7");
  assert.equal(pdfUrl("https://arxiv.org/pdf/1706.03762.pdf"), "https://arxiv.org/pdf/1706.03762");
  assert.equal(pdfUrl("https://export.arxiv.org/abs/hep-th/9901001"), "https://arxiv.org/pdf/hep-th/9901001");
  assert.equal(pdfUrl("https://arxiv.org/list/cs.AI/recent"), null);
  assert.equal(pdfUrl("https://example.com/post"), null);
  assert.equal(pdfUrl("ftp://example.com/a.pdf"), null);
  assert.equal(pdfUrl("not a link"), null);
});

test("a page's charset comes from the header, else its own meta tag", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  assert.equal(pageCharset("text/html; charset=ISO-8859-1", bytes('<meta charset="utf-8">')), "iso-8859-1");
  assert.equal(pageCharset("text/html", bytes('<html><head><meta charset="windows-1251">')), "windows-1251");
  assert.equal(pageCharset(null, bytes('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">')), "shift_jis");
  assert.equal(pageCharset("text/html", bytes("<meta charset=utf-16>")), "utf-8");
  assert.equal(pageCharset("text/html", bytes("<p>no tag</p>")), "utf-8");
});
