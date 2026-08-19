/** What a structured filter with no query text lists (the harness is
    `componentHarness.ts`, written up in `docs/component-tests.md`).

    Such a query never reaches the engine: the pane builds those rows itself,
    out of what it can see. It could see notes and nothing else — so a bare
    `type:` operator naming a mount listed none of the mount's files, however
    squarely they answered it, and the pane said "0 results" over a folder
    full of them. The engine half of the same rule (a mounted row rides past
    the note allow-list into a filtered TEXT search, and out of its count)
    lives in `search.rs`; this pins the half that has no engine in it. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MountInfo, MountRow, NoteMeta } from "./types.ts";

/* `ipc.ts` pulls in the bridge, which reads the window as it evaluates — so
   it is imported from inside the tests, after the harness has installed the
   DOM globals. Same reason every component here is a dynamic import. */
const ipc = async () => await import("./ipc.ts");

let mounts: MountInfo[] = [];
/** the seeded mount, whose name is what `type:` names */
let mount: MountInfo;
let rows: MountRow[] = [];
/** The vault's own notes as the pane is handed them: a mount's ANNOTATED rows
    are ordinary notes carrying the mount as their type, which is what makes
    the de-duplication below a real case rather than a hypothetical one. */
let notes: NoteMeta[] = [];

before(async () => {
  await mockBackend();
  const { mountRows, mountsList } = await ipc();
  mounts = await mountsList();
  const seeded = mounts.find((m) => m.id === "mount-finance");
  assert.ok(seeded, "the mock vault seeds a mount to filter on");
  mount = seeded;
  rows = await mountRows(mount.id);
  assert.ok(
    rows.some((r) => r.note),
    "the seeded mount has an annotated row — the one that is also a note"
  );
  notes = [
    ...rows.filter((r) => r.note).map((r) => note(r.note!, r.name, mount.name)),
    // and one note the filter must keep rejecting
    note("Ledger.md", "Ledger", "invoice"),
  ];
});

function note(path: string, title: string, type: string): NoteMeta {
  return {
    path,
    stem: title,
    title,
    folder: "",
    props: { type },
    updated_ms: 1_770_000_000_000,
    excerpt: "",
    sealed: false,
  };
}

function paneProps(query: string, notes: NoteMeta[]) {
  return {
    notes,
    mounts,
    query,
    setQuery: () => {},
    onOpenMatch: () => {},
    onClose: () => {},
    onRowContextMenu: () => {},
    excludeAppFiles: false,
    recallEnabled: false,
    onOpenPast: () => {},
  };
}

test("an operator naming a mount lists the mount's files", async (t) => {
  const { default: SearchPane } = await import("../components/SearchPane.tsx");
  const r = await renderComponent(t, h(SearchPane, paneProps(`type:${mount.name}`, notes)));

  const text = r.text();
  for (const row of rows) {
    assert.ok(text.includes(row.name), `the mount's row is missing from the results: ${row.name}`);
  }
  assert.ok(
    !text.includes("Ledger"),
    "a note the filter excludes is still excluded — the rule widened what is offered to the filter, not what passes it"
  );
  assert.equal(
    r.all(".search-note-row").length,
    rows.length,
    "every row once: an annotated row is its sidecar note, not a second entry beside it"
  );
});

test("the count over the results counts what the results show", async (t) => {
  const { default: SearchPane } = await import("../components/SearchPane.tsx");
  const r = await renderComponent(t, h(SearchPane, paneProps(`type:${mount.name}`, notes)));

  // "results", not "notes": a page holding mounted files says so
  assert.match(r.text(), new RegExp(`^${rows.length} results`));
});
