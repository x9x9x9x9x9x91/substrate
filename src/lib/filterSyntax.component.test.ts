/** The filter bar's syntax reference rendered for real (the harness is
    `componentHarness.ts`, written up in `docs/component-tests.md`).

    The panel exists because the grammar has ten operator classes and the
    filter placeholder can only name one, so what is worth pinning is that
    every class the parser advertises actually reaches the reader — and that
    the panel stays a fold-out rather than a legend printed on the pane
    (design-principles §5). `query.test.ts` owns the other half: that each
    example parses back to the class its row claims. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import { QUERY_SYNTAX, QUERY_SYNTAX_FOOT } from "./query.ts";

test("the syntax panel stays folded away until it is asked for", async (t) => {
  const { FilterSyntax } = await import("../components/DbPaneShared.tsx");
  const r = await renderComponent(t, h(FilterSyntax));

  // the trigger is what proves the surface mounted — the absence check below
  // would pass just as happily on a render that never happened
  const btn = r.one(".db-syntax-btn");
  assert.ok(btn, "the ? is always there: what can I type is a question you have before you type");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(r.all(".db-syntax-row").length, 0, "and the rows are not printed on the pane");
});

test("opening it names every operator class the parser has", async (t) => {
  const { FilterSyntax } = await import("../components/DbPaneShared.tsx");
  const r = await renderComponent(t, h(FilterSyntax));
  await r.click(".db-syntax-btn");

  assert.equal(r.one(".db-syntax-btn")?.getAttribute("aria-expanded"), "true");
  assert.equal(
    r.all(".db-syntax-row").length,
    QUERY_SYNTAX.length,
    "one row per class, no class dropped on the way to the panel"
  );
  const text = r.text();
  for (const row of QUERY_SYNTAX) {
    assert.ok(text.includes(row.label), `missing label: ${row.label}`);
    assert.ok(text.includes(row.example), `missing example: ${row.example}`);
  }
  // the two facts no single example can carry
  assert.ok(text.includes(QUERY_SYNTAX_FOOT), "the operator set and what a duration counts from");
});

test("the classes the pane used to teach nowhere are all in there", async (t) => {
  const { FilterSyntax } = await import("../components/DbPaneShared.tsx");
  const r = await renderComponent(t, h(FilterSyntax));
  await r.click(".db-syntax-btn");
  const examples = r.all(".db-syntax-example").map((e) => e.textContent);

  // the placeholder has always taught key:value and nothing else; these are
  // the six that lived only in the format doc
  assert.ok(
    examples.some((e) => e?.includes(",")),
    "any-of list"
  );
  assert.ok(
    examples.some((e) => e?.includes('"')),
    "quoted value"
  );
  assert.ok(
    examples.some((e) => e?.startsWith("-")),
    "negation"
  );
  assert.ok(
    examples.some((e) => /\d+[dw]$/.test(e ?? "")),
    "duration comparison"
  );
  assert.ok(
    examples.some((e) => /\d{4}-\d{2}-\d{2}$/.test(e ?? "")),
    "ISO-day comparison"
  );
  assert.ok(
    examples.some((e) => e?.startsWith("folder:")),
    "folder"
  );
});

test("a second click folds it away again", async (t) => {
  const { FilterSyntax } = await import("../components/DbPaneShared.tsx");
  const r = await renderComponent(t, h(FilterSyntax));
  await r.click(".db-syntax-btn");
  assert.ok(r.all(".db-syntax-row").length > 0, "open");
  await r.click(".db-syntax-btn");
  assert.equal(r.all(".db-syntax-row").length, 0, "closed");
  assert.ok(r.one(".db-syntax-btn"), "and the trigger survives the round trip");
});
