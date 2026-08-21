/** TaxDashboard rendered for real — one of the surfaces pinned by the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    What is worth pinning here is the case fold on BOTH sides of the board's
    one indirection: the dashboard note's own `Sheet:`/`Missing:` props, and
    the `Type: Sheet` on the notes those names resolve to. Before this, "the
    fold works" was a reading of the diff.

    Assertions name the sheet that was actually read — each cased fixture
    carries a row the default source does not — rather than just counting rows:
    both fixtures are clones of the default sources, so a row count alone would
    pass just as happily on the fallback path the fold is supposed to make
    unnecessary. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

const CASED_AGG_TITLE = "Tax 2026 Cased";
const CASED_MISSING_TITLE = "Tax Missing Cased";
const CASED_AGG = `${CASED_AGG_TITLE}.md`;
const CASED_MISSING = `${CASED_MISSING_TITLE}.md`;
/** unique to the cased copies — prove WHICH sheets were read */
const CASED_ROW = "Cased-fixture rent";
const CASED_CATEGORY = "Cased-fixture income";

/** A dashboard note as a hand-typed frontmatter block would leave it: every
    key capitalised, which is exactly what the folded reads have to survive. */
function casedDashboard(props: Record<string, unknown>): NoteMeta {
  return {
    path: "Dashboards/Tax Cased.md",
    stem: "Tax Cased",
    title: "Tax Cased",
    folder: "Dashboards",
    props: { Type: "Dashboard", Dashboard: "Tax", ...props },
    updated_ms: Date.now(),
    excerpt: "",
    sealed: false,
  };
}

/* not `Window`: `mockBackend` hands back a window the staging seams are
   present on, so these calls are written without `?.` — see its guard */
let win: MockWindow;

before(async () => {
  /* Cased copies of both sources, staged through the same seams the e2e suite
     uses. `type: sheet` is dropped and re-added as `Type: Sheet` — the fold
     has to carry both the KEY and the VALUE to read these notes at all. */
  win = await mockBackend();
  for (const [source, copy] of [
    ["Tax 2026.md", CASED_AGG],
    ["Tax Missing.md", CASED_MISSING],
  ]) {
    win.__mockCloneNote(source, copy);
    win.__mockEditProp(copy, "type", null);
    win.__mockEditProp(copy, "Type", "Sheet");
  }
  const ipc = await import("./ipc.ts");
  const missing = await ipc.vaultRead(CASED_MISSING);
  win.__mockEditNote(CASED_MISSING, missing.body.replace("Studio rent — March", CASED_ROW));
  const agg = await ipc.vaultRead(CASED_AGG);
  win.__mockEditNote(CASED_AGG, agg.body.replace("Income,Income,", `${CASED_CATEGORY},Income,`));
});

after(() => {
  win.__mockDeleteNote(CASED_AGG);
  win.__mockDeleteNote(CASED_MISSING);
  win.__mockFail?.delete("vault_read");
});

test("reads both sources through cased frontmatter keys", async (t) => {
  const { default: TaxDashboard } = await import("../components/TaxDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(TaxDashboard, {
      meta: casedDashboard({ Sheet: CASED_AGG_TITLE, Missing: CASED_MISSING_TITLE }),
      vaultEpoch: 0,
      onOpenSource: () => {},
    })
  );

  // it parsed as a sheet despite `Type: Sheet` being cased on the target too
  assert.doesNotMatch(rendered.text(), /is not a sheet/);
  // no alert banner: neither source failed to read, and the snapshot is fresh
  assert.doesNotMatch(rendered.text(), /unavailable|cannot be trusted/);
  const categories = rendered.all(".tax-table tbody tr td:first-child").map((td) => td.textContent);
  // the first row is the cased copy's own — `Sheet:` resolved to it, not the default
  assert.deepEqual(categories, [
    CASED_CATEGORY,
    "Business expenses",
    "Equipment",
    "Home office",
    "Rental",
    "Partnership",
  ]);
  // and `Missing:` resolved to the cased copy, not the default snapshot
  assert.match(rendered.text(), new RegExp(CASED_ROW));
  assert.doesNotMatch(rendered.text(), /Studio rent — March/);
});

test("names the source that isn't a sheet instead of parsing it", async (t) => {
  const { default: TaxDashboard } = await import("../components/TaxDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(TaxDashboard, {
      // Tax Readiness is the dashboard note itself — a csv fence in something
      // that isn't a sheet is not this board's data
      meta: casedDashboard({ Sheet: "Tax Readiness", Missing: "Tax Missing" }),
      vaultEpoch: 0,
      onOpenSource: () => {},
    })
  );

  assert.match(rendered.text(), /“Tax Readiness” is not a sheet/);
  assert.equal(rendered.all(".tax-table").length, 0);
});

test("falls back to the default sources when the props are absent", async (t) => {
  const { default: TaxDashboard } = await import("../components/TaxDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(TaxDashboard, {
      meta: casedDashboard({}),
      vaultEpoch: 0,
      onOpenSource: () => {},
    })
  );

  // DEFAULT_SHEET / DEFAULT_MISSING — "Tax 2026" and "Tax Missing"
  const categories = rendered.all(".tax-table tbody tr td:first-child").map((td) => td.textContent);
  assert.deepEqual(categories[0], "Income");
  assert.doesNotMatch(rendered.text(), new RegExp(CASED_CATEGORY));
  assert.match(rendered.text(), /Studio rent — March/);
});

test("the board's cards are the note's own bindings, not a roster in the code", async (t) => {
  const { default: TaxDashboard } = await import("../components/TaxDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(TaxDashboard, {
      // capitalised like the rest of this note's keys: the card list folds too
      meta: casedDashboard({
        Sheet: CASED_AGG_TITLE,
        Missing: CASED_MISSING_TITLE,
        Cards: [
          { label: "Takings", bind: `{{${CASED_AGG_TITLE}.income_ytd}}`, format: "eur", emph: true },
          { label: "Nothing there", bind: `{{${CASED_AGG_TITLE}.not_a_summary}}`, format: "eur" },
        ],
      }),
      vaultEpoch: 0,
      onOpenSource: () => {},
    })
  );

  const labels = rendered.all(".dash-card .dash-label").map((el) => el.textContent);
  assert.deepEqual(labels, ["Takings", "Nothing there"]);
  // the vault named the card, and a bound summary that isn't there says so on
  // the card rather than silently reading as "—"
  assert.match(rendered.text(), /no summary “not_a_summary”/);
});

test("a broken source names the table it broke, not the cards it didn't", async (t) => {
  const { default: TaxDashboard } = await import("../components/TaxDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(TaxDashboard, {
      // the board's own source is repointed at a note that is not a sheet,
      // while the cards keep binding a sheet that reads fine — the split the
      // audit caught: a banner claiming aggregates were unavailable over a
      // fully populated metric strip
      meta: casedDashboard({
        Sheet: "Tax Readiness",
        Missing: CASED_MISSING_TITLE,
        Cards: [
          { label: "Takings", bind: `{{${CASED_AGG_TITLE}.income_ytd}}`, format: "eur" },
        ],
      }),
      vaultEpoch: 0,
      onOpenSource: () => {},
    })
  );

  // the category table is what this source feeds, and the banner says so
  assert.equal(rendered.all(".tax-table").length, 0);
  assert.match(rendered.text(), /Category breakdown unavailable/);
  assert.doesNotMatch(rendered.text(), /Aggregates unavailable/);
  // the card resolved its own binding and is still paying out — which the
  // banner now says out loud instead of leaving as a contradiction on screen
  const value = rendered.one(".dash-card .dash-card-eur");
  assert.ok(value, "the card strip still rendered");
  assert.match(value.textContent ?? "", /\d/);
  assert.match(rendered.text(), /read their own bindings and are unaffected/);
});

test("a source that cannot be read names the failure, not the Error class", async (t) => {
  // the banner this board rewrote for legibility is also where a CAUGHT read
  // failure lands, and that path used to arrive with "Error:" in front of it
  win.__mockFail = new Set(["vault_read"]);
  const { default: TaxDashboard } = await import("../components/TaxDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(TaxDashboard, {
      meta: casedDashboard({ Sheet: CASED_AGG_TITLE, Missing: CASED_MISSING_TITLE }),
      vaultEpoch: 0,
      onOpenSource: () => {},
    })
  );
  win.__mockFail.delete("vault_read");

  const banners = rendered.all(".dash-alert").map((el) => el.textContent ?? "");
  assert.ok(
    banners.some((b) => /Category breakdown unavailable — mock failure: vault_read/.test(b)),
    `the breakdown banner names the failure: ${banners.join(" | ")}`
  );
  assert.ok(banners.every((b) => !/Error:/.test(b)), "no banner shows the Error class");
  // and the sentence ends once
  assert.doesNotMatch(rendered.text(), /\.\./);
});
