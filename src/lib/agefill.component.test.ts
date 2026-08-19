/* The freshness column as the EDITOR paints it: a plain-DOM table, filled by
   `agefill.ts`. Imported for its jsdom globals only — nothing here renders a
   React component, but the module under test writes real DOM and reads
   `CSS.escape`. */
import "./componentHarness.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { fillAges, forgetFreshnessFailures } from "./agefill.ts";
import { freshCache } from "./freshcache.ts";
import type { EmbedResult } from "./embeds.ts";
import type { FactFreshness } from "./types.ts";

const YEAR = 365 * 24 * 60 * 60 * 1000;

function answer(path: string, key: string, agoMs: number): FactFreshness {
  return {
    path,
    key,
    reviewed_ts_ms: Date.now() - agoMs,
    reviewed_commit: "abc123",
    reviewed_actor: { kind: "external" },
    only_bulk: false,
    oldest_ts_ms: Date.now() - agoMs,
  };
}

/** A one-row table with one freshness column, built the way the widget builds
    it: the table hangs off a wrapper that is NOT in the document, which is the
    state `toDOM` paints in. */
function tableFor(path: string, key: string): { wrap: HTMLElement; table: HTMLElement } {
  const wrap = document.createElement("div");
  const table = document.createElement("table");
  const tr = document.createElement("tr");
  tr.dataset.path = path;
  const td = document.createElement("td");
  td.dataset.age = key;
  tr.appendChild(td);
  table.appendChild(tr);
  wrap.appendChild(table);
  return { wrap, table };
}

function result(path: string, noteKey: string, schemaKey: string, review: string): EmbedResult {
  return {
    dbType: "contact",
    columns: ["Name", `age(${noteKey})`],
    rows: [{ path, title: "A contact", updated_ms: 7, cells: ["A contact", ""], props: {} }],
    total: 1,
    typeSchema: { [schemaKey]: { kind: "text", review } },
    query: "type: contact",
    ages: { [`age(${noteKey})`]: noteKey },
  } as EmbedResult;
}

const never = async () => {
  assert.fail("the history was asked about a fact already cached");
};

test("a table built off-screen still shows the ages it already knows", () => {
  const path = "warm.md";
  freshCache.fill([{ path, key: "phone", updated_ms: 7 }], [answer(path, "phone", 2 * YEAR)]);
  const { table } = tableFor(path, "phone");
  // painted while the whole widget is still detached — the widget builds its
  // node before CodeMirror inserts it, and an age dropped here never returns
  assert.equal(table.isConnected, false);
  fillAges(table, result(path, "phone", "phone", "yearly"), never);
  assert.match(table.querySelector("td")?.textContent ?? "", /\d/);
});

test("the window is found even when the note spells the key its own way", () => {
  const path = "cased.md";
  freshCache.fill([{ path, key: "Phone", updated_ms: 7 }], [answer(path, "Phone", 2 * YEAR)]);
  const { table } = tableFor(path, "Phone");
  // the schema declares `phone`; the note writes `Phone:` — the same fold
  // every other live prop read uses has to find the window, or the column
  // never tints over a value the whole-vault report flags as past due
  fillAges(table, result(path, "Phone", "phone", "yearly"), never);
  const span = table.querySelector("td span");
  assert.equal(span?.className, "embed-view-age embed-view-age-due");
  assert.match(span?.getAttribute("title") ?? "", /reviewed yearly/);
});

test("an answer for a table that has been replaced is dropped", async () => {
  const path = "stale.md";
  const { wrap, table } = tableFor(path, "phone");
  let release: (a: FactFreshness[]) => void = () => {};
  const ask = () =>
    new Promise<FactFreshness[]>((r) => {
      release = r;
    });
  fillAges(table, result(path, "phone", "phone", "yearly"), ask);
  // a repaint removes the old table from the wrapper before building the new
  // one; this answer belongs to a node nobody is looking at
  wrap.removeChild(table);
  release([answer(path, "phone", 2 * YEAR)]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(table.querySelector("td")?.textContent, "");
});

test("a vault with no history is asked once, not once per repaint", async () => {
  forgetFreshnessFailures();
  const path = "nohistory.md";
  let calls = 0;
  const ask = async () => {
    calls += 1;
    throw new Error("history is off");
  };
  const r = result(path, "phone", "phone", "yearly");
  for (let i = 0; i < 3; i += 1) {
    const { table } = tableFor(path, "phone");
    fillAges(table, r, ask);
    await new Promise((res) => setTimeout(res, 0));
  }
  assert.equal(calls, 1);
});
