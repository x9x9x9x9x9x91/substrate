import assert from "node:assert/strict";
import { test } from "node:test";
import { appendPage, yamlScalar } from "./pagesedit.ts";

const ok = (r: ReturnType<typeof appendPage>) => {
  assert.ok("fm" in r, `expected an edit, got ${JSON.stringify(r)}`);
  return r.fm;
};

test("the new entry copies the indentation the list already uses", () => {
  const fm = ok(
    appendPage(
      ["type: dashboard", "pages:", "  - label: Statements", "    note: Label Statements"].join("\n"),
      { label: "Releases", key: "view", value: "release" }
    )
  );
  assert.equal(
    fm,
    [
      "type: dashboard",
      "pages:",
      "  - label: Statements",
      "    note: Label Statements",
      "  - label: Releases",
      "    view: release",
      "",
    ].join("\n")
  );
});

test("a zero-indent list stays zero-indent", () => {
  const fm = ok(
    appendPage(["pages:", "- label: One", "  note: One"].join("\n"), {
      label: "Two",
      key: "note",
      value: "Two",
    })
  );
  assert.equal(fm, ["pages:", "- label: One", "  note: One", "- label: Two", "  note: Two", ""].join("\n"));
});

test("keys below the list are left where they are", () => {
  const fm = ok(
    appendPage(
      ["pages:", "  - label: One", "    note: One", "created: 2026-08-17"].join("\n"),
      { label: "Two", key: "note", value: "Two" }
    )
  );
  assert.equal(
    fm,
    [
      "pages:",
      "  - label: One",
      "    note: One",
      "  - label: Two",
      "    note: Two",
      "created: 2026-08-17",
      "",
    ].join("\n")
  );
});

test("a note with no pages: key gets one", () => {
  const fm = ok(
    appendPage("type: dashboard\ndashboard: hub", { label: "Ledger", key: "note", value: "Ledger" })
  );
  assert.equal(fm, ["type: dashboard", "dashboard: hub", "pages:", "  - label: Ledger", "    note: Ledger", ""].join("\n"));
});

test("titles that YAML would misread are quoted", () => {
  const fm = ok(
    appendPage("pages:\n  - label: One\n    note: One", {
      label: "Q3: numbers",
      key: "note",
      value: "#hash note",
    })
  );
  assert.match(fm, /- label: "Q3: numbers"/);
  assert.match(fm, /note: "#hash note"/);
  assert.equal(yamlScalar('a "quoted" one'), '"a \\"quoted\\" one"');
});

test("a title YAML would read as a number, bool or null is quoted too", () => {
  for (const title of ["2026", "007", "1.5", "-3", "true", "False", "null", "~", "yes", "no", "on", "off"]) {
    assert.equal(yamlScalar(title), `"${title}"`, `${title} must not stay a plain scalar`);
  }
  // a title that merely contains digits is still plain
  assert.equal(yamlScalar("Q3 2026"), "Q3 2026");
  assert.equal(yamlScalar("2026 Ledger"), "2026 Ledger");
  const fm = ok(
    appendPage("pages:\n  - label: One\n    note: One", { label: "2026", key: "note", value: "2026" })
  );
  assert.match(fm, /- label: "2026"/);
  assert.match(fm, /note: "2026"/);
});

test("a one-line pages: is refused with a sentence, not rewritten", () => {
  const r = appendPage("pages: [a, b]", { label: "Two", key: "note", value: "Two" });
  assert.ok("error" in r && /one line/.test(r.error));
});

test("a pages: block that is not a list is refused too", () => {
  const r = appendPage("pages:\n  label: One", { label: "Two", key: "note", value: "Two" });
  assert.ok("error" in r && /not a plain list/.test(r.error));
});

test("a cased Pages: is the same key", () => {
  const fm = ok(
    appendPage("Pages:\n  - label: One\n    note: One", { label: "Two", key: "note", value: "Two" })
  );
  assert.match(fm, /- label: Two/);
});
