import { test } from "node:test";
import assert from "node:assert/strict";
import { type Route, isAppPath, legacyHashPath, parseRoute, routeHref } from "./route";

const FOLDER = "f1-abc";
const DOC = "a".repeat(64);

// One of each screen, so the round trip covers them all.
const ROUTES: Route[] = [
  { name: "today" },
  { name: "library" },
  { name: "library", folder: FOLDER },
  { name: "item", folder: FOLDER, item: "item-1" },
  { name: "reader", folder: FOLDER, doc: DOC },
  { name: "reader", folder: FOLDER, doc: DOC, page: 4, find: "nine words", panel: "notes" },
  { name: "graph", folder: FOLDER },
  { name: "save" },
  { name: "search", q: "rust & go" },
  { name: "search" },
  { name: "highlights" },
  { name: "setup" },
  { name: "welcome" },
];

/** Drops undefined fields, so a route with none set equals one that lacks them. */
const plain = (r: unknown) => JSON.parse(JSON.stringify(r));

/** The path and query a route's address carries, split the way the browser splits them. */
const split = (href: string) => {
  const q = href.indexOf("?");
  return q < 0 ? { path: href, search: "" } : { path: href.slice(0, q), search: href.slice(q) };
};

test("every screen's address parses back to the same screen", () => {
  for (const route of ROUTES) {
    const { path, search } = split(routeHref(route));
    assert.deepEqual(plain(parseRoute(path, search)), plain(route), routeHref(route));
  }
});

test("the base is put in front of the address, and parsing ignores it", () => {
  assert.equal(routeHref({ name: "today" }, "/repo"), "/repo/today");
  assert.equal(routeHref({ name: "item", folder: FOLDER, item: "i" }, ""), `/f/${FOLDER}/item/i`);
});

test("a folder's library is its own address, and the bare library is the library", () => {
  assert.equal(routeHref({ name: "library", folder: FOLDER }), `/f/${FOLDER}`);
  assert.equal(routeHref({ name: "library" }), "/library");
});

test("an unknown path shows today", () => {
  assert.deepEqual(parseRoute("/"), { name: "today" });
  assert.deepEqual(parseRoute("/nope"), { name: "today" });
  assert.deepEqual(parseRoute("/f/bad id/item/x"), { name: "today" });
});

test("a page number in a PDF's address is read back as a number", () => {
  assert.deepEqual(plain(parseRoute(`/f/${FOLDER}/doc/${DOC}`, "?page=7")), { name: "reader", folder: FOLDER, doc: DOC, page: 7 });
});

test("a legacy hash address names the path it stood for", () => {
  assert.equal(legacyHashPath("#/today"), "/today");
  assert.equal(legacyHashPath("#/save?url=https%3A%2F%2Fexample.com"), "/save?url=https%3A%2F%2Fexample.com");
  assert.equal(legacyHashPath("#/f/abc/item/def"), "/f/abc/item/def");
});

test("a hash that is not a legacy address is left alone", () => {
  assert.equal(legacyHashPath(""), null);
  assert.equal(legacyHashPath("#how"), null);
  // The sign-in return carries its own marker, which must not be read as a screen.
  assert.equal(legacyHashPath("#engram-auth&token=x"), null);
});

test("only the app's own screens are followed inside the app", () => {
  assert.equal(isAppPath("/today"), true);
  assert.equal(isAppPath("/save"), true);
  assert.equal(isAppPath(`/f/${FOLDER}/item/i`), true);
  assert.equal(isAppPath(`/f/${FOLDER}/doc/${DOC}`), true);
  assert.equal(isAppPath("/api/mcp"), false);
  assert.equal(isAppPath("/pdfjs/build/pdf.worker.mjs"), false);
  assert.equal(isAppPath("/"), false);
  assert.equal(isAppPath("/todayish"), false);
});
