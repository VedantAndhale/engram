import { test } from "node:test";
import assert from "node:assert/strict";
import { installStatus, installedVersion } from "./installstatus";

test("installedVersion reads the marker on the first line", () => {
  assert.equal(installedVersion("# engram-feeds v1\nname: Engram feeds\n"), 1);
  assert.equal(installedVersion("// engram-feeds v12\nexport {};\n"), 12);
  assert.equal(installedVersion("# engram-feeds v3"), 3);
});

test("installedVersion copes with Windows line endings", () => {
  assert.equal(installedVersion("// engram-feeds v2\r\nexport {};\r\n"), 2);
});

test("installedVersion ignores the marker anywhere but the first line", () => {
  assert.equal(installedVersion("name: Engram feeds\n# engram-feeds v1\n"), null);
  assert.equal(installedVersion("\n# engram-feeds v1\n"), null);
});

test("installedVersion gives null when there is no marker", () => {
  assert.equal(installedVersion(null), null);
  assert.equal(installedVersion(""), null);
  assert.equal(installedVersion("# something else v1"), null);
  assert.equal(installedVersion("# engram-feeds vX"), null);
});

test("installStatus is missing when no file is there", () => {
  assert.equal(installStatus([], 1), "missing");
  assert.equal(
    installStatus(
      [
        { path: "a", version: null },
        { path: "b", version: null },
      ],
      1,
    ),
    "missing",
  );
});

test("installStatus is partial when only some files are there", () => {
  assert.equal(
    installStatus(
      [
        { path: "a", version: 1 },
        { path: "b", version: null },
      ],
      1,
    ),
    "partial",
  );
  // A missing file wins over an old one: the user needs the full install either way.
  assert.equal(
    installStatus(
      [
        { path: "a", version: 1 },
        { path: "b", version: null },
      ],
      2,
    ),
    "partial",
  );
});

test("installStatus is outdated when any file is older than the app's version", () => {
  assert.equal(
    installStatus(
      [
        { path: "a", version: 2 },
        { path: "b", version: 1 },
      ],
      2,
    ),
    "outdated",
  );
});

test("installStatus is current when every file matches or is newer", () => {
  assert.equal(
    installStatus(
      [
        { path: "a", version: 1 },
        { path: "b", version: 1 },
      ],
      1,
    ),
    "current",
  );
  assert.equal(
    installStatus(
      [
        { path: "a", version: 3 },
        { path: "b", version: 2 },
      ],
      2,
    ),
    "current",
  );
});