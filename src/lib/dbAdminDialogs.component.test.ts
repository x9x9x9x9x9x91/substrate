/** The two database-creation cards rendered for real, through the component
    harness (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    What is worth executing here is the WIRING, not the markup: a kind picked
    in the import card has to travel through the column model into the props
    the create call receives AND into the values each row stores, and a
    `select` chosen in either card has to reach the engine as the kindless
    schema entry it really is. tsc sees a string flow between two functions;
    only a render shows whether the chosen kind ever left the picker. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { CsvEntry } from "./csvimport.ts";
import { setNumberLocale } from "./numberLocale.ts";
import type { NewTypeProp } from "./types.ts";

/** The open menu's rows, with the current row's ✓ marker stripped. */
function menuLabels(): string[] {
  return [...document.querySelectorAll(".selmenu-item")].map((el) =>
    (el.textContent ?? "").trim().replace(/✓$/, "")
  );
}

/** A menu row by its label. SelectMenu portals to document.body, so it is
    outside the render container the harness hands back. */
function menuRow(label: string): Element {
  const rows = [...document.querySelectorAll(".selmenu-item")];
  const hit = rows.find((el) => (el.textContent ?? "").trim().replace(/✓$/, "") === label);
  assert.ok(hit, `no “${label}” row in the open menu (${menuLabels().join(", ")})`);
  return hit;
}

/** Type into a field. The harness synthesizes clicks only, so the value goes
    in through the native setter React's onChange listens behind. */
async function type(field: Element, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("an import column's chosen kind reaches both the schema and the stored cells", async (t) => {
  const { CsvImportDialog } = await import("../components/DbAdmin.tsx");
  const rows = [
    ["title", "due", "fee"],
    ["Slow Bloom EP", "15.08.2026", "1.234,56"],
  ];
  let got: { name: string; props: NewTypeProp[]; entries: CsvEntry[] } | null = null;

  const r = await renderComponent(
    t,
    h(CsvImportDialog, {
      fileName: "Releases.csv",
      rows,
      onImport: (name: string, props: NewTypeProp[], entries: CsvEntry[]) => {
        got = { name, props, entries };
        return Promise.resolve();
      },
      onClose: () => {},
    })
  );

  /* The title column becomes the note's title, so it has no kind to pick —
     the two remaining columns each carry a control. */
  const kinds = r.all(".dbform-colkind");
  assert.equal(kinds.length, 2, "one kind control per importable column, none on the title");
  assert.deepEqual(
    kinds.map((b) => (b.textContent ?? "").trim()),
    ["Text", "Text"],
    "text is the default — what every column was before the choice existed"
  );

  await r.click(kinds[0]);
  await r.click(menuRow("Date"));
  await r.click(r.all(".dbform-colkind")[1]);
  await r.click(menuRow("Number"));
  assert.deepEqual(
    r.all(".dbform-colkind").map((b) => (b.textContent ?? "").trim()),
    ["Date", "Number"],
    "the picked kinds stay on their own rows"
  );

  await r.click(".selmenu-btn-primary");
  assert.ok(got, "the import ran");
  const done = got as unknown as { name: string; props: NewTypeProp[]; entries: CsvEntry[] };
  assert.equal(done.name, "Releases");
  assert.deepEqual(
    done.props,
    [
      // no vocabulary on either: options belong to a select column
      { name: "due", kind: "date", target: null, options: null },
      { name: "fee", kind: "number", target: null, options: null },
    ],
    "the created schema carries the picked kinds, not text"
  );
  /* And the values arrive in the shape those kinds are read in: the date
     menu's commit shape, and the number boundary's canonical dot-decimal. */
  assert.deepEqual(done.entries, [
    {
      title: "Slow Bloom EP",
      props: [
        ["due", "2026-08-15"],
        ["fee", "1234.56"],
      ],
    },
  ]);
});

test("the import card offers only the kinds a flat cell can become", async (t) => {
  const { CsvImportDialog } = await import("../components/DbAdmin.tsx");
  const r = await renderComponent(
    t,
    h(CsvImportDialog, {
      fileName: "Releases.csv",
      rows: [
        ["title", "stage"],
        ["Slow Bloom EP", "mastering"],
      ],
      onImport: () => Promise.resolve(),
      onClose: () => {},
    })
  );

  await r.click(r.all(".dbform-colkind")[0]);
  // the same labels and the same order as the new-database dialog's list,
  // minus the kinds a flat cell can't carry (multi, file, relation, checkbox)
  assert.deepEqual(menuLabels(), ["Text", "Select", "Date", "URL", "Email", "Phone", "Number"]);

  // Select is reachable here, which is the point of the list; a status
  // column is the commonest thing a spreadsheet carries
  await r.click(menuRow("Select"));
  assert.equal((r.all(".dbform-colkind")[0].textContent ?? "").trim(), "Select");
});

test("the new-database dialog does not offer select, which it cannot make", async (t) => {
  /* A select IS its options, and a database being created has no values for
     any to come from. An optionless select is not a select at all: the schema
     editor resolves the entry back to Text, and saving that shape REMOVES the
     property (the engine's demote rule). So the kind is absent here and
     present in the import card, where the values arrive with the columns. */
  const { NewDatabaseDialog } = await import("../components/DbAdmin.tsx");
  let created: NewTypeProp[] | null = null;
  const r = await renderComponent(
    t,
    h(NewDatabaseDialog, {
      dbTypes: ["Release"],
      onCreate: (_name: string, props: NewTypeProp[]) => {
        created = props;
        return Promise.resolve();
      },
      onClose: () => {},
    })
  );

  await r.click(".dbform-addprop");
  const fields = r.all(".dbform-input");
  assert.equal(fields.length, 2, "the database name, then the added property's name");
  await type(fields[0], "Films");
  await type(fields[1], "Status");

  await r.click(".dbform-select");
  const labels = menuLabels();
  assert.ok(labels.includes("Text") && labels.includes("Multi-select"), "the picker is open");
  assert.ok(!labels.includes("Select"), `select is not offered here: ${labels.join(", ")}`);
  assert.ok(!labels.includes("Rollup"), "and neither is rollup, with no relation to follow");

  await r.click(menuRow("Multi-select"));
  await r.click(".selmenu-btn-primary");
  assert.deepEqual(created, [{ name: "Status", kind: "multi", target: null }]);
});

test("a date or number column previews its first real cell against what it stores", async (t) => {
  /* The two kinds that REWRITE the cell also read it through a dialect — the
     number dial, and a date grammar that resolves a slash date month-first.
     Neither is visible in the file, so the card shows one real row's before
     and after; a misread is then a glance, not 500 wrong rows. */
  setNumberLocale("de-DE");
  const { CsvImportDialog } = await import("../components/DbAdmin.tsx");
  const r = await renderComponent(
    t,
    h(CsvImportDialog, {
      fileName: "Releases.csv",
      rows: [
        ["title", "fee", "stage"],
        ["Slow Bloom EP", "", "mastering"],
        ["Vessel Songs", "1,234", "in review"],
      ],
      onImport: () => Promise.resolve(),
      onClose: () => {},
    })
  );

  // text columns rewrite nothing, so there is nothing to preview
  assert.equal(r.all(".dbform-colsample").length, 0);

  await r.click(r.all(".dbform-colkind")[0]);
  await r.click(menuRow("Number"));
  const sample = r.one(".dbform-colsample");
  assert.ok(sample, "the number column previews a cell");
  // the first row's fee is blank — the preview skips to a row that has one
  assert.equal((sample.textContent ?? "").replace(/\s+/g, " ").trim(), "1,234 → 1.234");
  assert.match(r.text(), /Numbers are read in your de-DE format/);

  // and under the other dial the same three characters mean a thousand
  setNumberLocale("en-US");
  await r.click(r.all(".dbform-colkind")[1]);
  await r.click(menuRow("Text"));
  assert.equal(
    (r.one(".dbform-colsample")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    "1,234 → 1234"
  );
  setNumberLocale("de-DE");
});

test("a select column is created with its own values as the options", async (t) => {
  const { CsvImportDialog } = await import("../components/DbAdmin.tsx");
  let got: NewTypeProp[] | null = null;
  const r = await renderComponent(
    t,
    h(CsvImportDialog, {
      fileName: "Releases.csv",
      rows: [
        ["title", "stage"],
        ["Slow Bloom EP", "mastering"],
        ["Vessel Songs", "in review"],
        ["Nightline", "mastering"],
        ["Untitled", ""],
      ],
      onImport: (_name: string, props: NewTypeProp[]) => {
        got = props;
        return Promise.resolve();
      },
      onClose: () => {},
    })
  );

  assert.doesNotMatch(r.text(), /options/, "a text column has no vocabulary to speak of");
  await r.click(r.all(".dbform-colkind")[0]);
  await r.click(menuRow("Select"));
  assert.equal((r.all(".dbform-colkind")[0].textContent ?? "").trim(), "Select");
  assert.match(r.text(), /The select column takes its distinct values as options/);

  await r.click(".selmenu-btn-primary");
  const props = got as unknown as NewTypeProp[];
  assert.deepEqual(props, [
    {
      name: "stage",
      kind: "select",
      target: null,
      // distinct, blank dropped, in the schema editor's own order
      options: [{ value: "in review" }, { value: "mastering" }],
    },
  ]);
});

test("a created select is kindless, carries its options, and survives a schema save", async () => {
  /* Mirrors the Rust assertions in `create_type_registers_db_and_initial_props`:
     a select IS the kindless entry with options, so storing "select" as a kind
     would leave a column no cell editor knows how to read. The mock backend is
     what the e2e suite and every other component test see, so it has to agree
     with the engine here or the two diverge silently. */
  const { vaultCreateType, vaultSchemaSet } = await import("./ipc.ts");
  // the database this registers lives in the mock's own state, which is per
  // test FILE — nothing else here reads the schema, and the next file gets a
  // fresh process with the seed vault untouched
  const schema = await vaultCreateType("Component Test Films", [
    {
      name: "Status",
      kind: "select",
      target: null,
      options: [{ value: "in review" }, { value: " mastering " }, { value: "" }],
    },
    { name: "Notes", kind: "text", target: null },
  ]);
  const films = schema["Component Test Films"];
  assert.equal(films.Status.kind, undefined, "select is stored as the absence of a kind");
  assert.deepEqual(
    films.Status.options.map((o) => o.value),
    ["in review", "mastering"],
    "trimmed, blanks dropped — the normalization a schema edit applies"
  );
  assert.equal(films.Notes.kind, "text", "and the neighbouring kinds are untouched");

  /* The trap the review found: optionless-and-kindless is how this backend
     spells "no such property", so a select created empty would be DELETED by
     the first schema-editor save of the same entry. Created with its options,
     the same save is a no-op that keeps the column. */
  const after = await vaultSchemaSet(
    "Component Test Films",
    "Status",
    films.Status.options,
    undefined
  );
  assert.deepEqual(
    after["Component Test Films"].Status.options.map((o) => o.value),
    ["in review", "mastering"],
    "the round trip keeps the column and its vocabulary"
  );

  /* And the same save on an optionless one, to show the trap is real and
     not a story: this is what a select created empty would have met. */
  const empty = await vaultCreateType("Component Test Empty Select", [
    { name: "Status", kind: "select", target: null, options: [] },
    { name: "Notes", kind: "text", target: null },
  ]);
  assert.deepEqual(empty["Component Test Empty Select"].Status.options, [], "created with none");
  const gone = await vaultSchemaSet("Component Test Empty Select", "Status", [], undefined);
  assert.equal(
    gone["Component Test Empty Select"].Status,
    undefined,
    "optionless-and-kindless is how this backend spells a property that isn't there"
  );
  assert.ok(gone["Component Test Empty Select"].Notes, "its neighbour is untouched");
});
