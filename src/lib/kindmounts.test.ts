/** `ctx.mounts` / `ctx.mountRows` — the read-only half of what a built-in
 *  board gets from `dashboardMounts`.
 *
 *  Three things worth pinning past the compile-time contract: that what a kind
 *  holds is a copy all the way down (a `.sort()` or a nested `.push()` in
 *  vault code must not reach the cache the built-in surfaces read), that the
 *  loader and this lookup fold a mount name the same way, and that the three
 *  answers stay apart — rows, "no such mount", and "the mount is there and its
 *  index would not read". */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { MountInfo, MountRow } from "./types.ts";
import { kindMountRows, kindMounts } from "./kindmounts.ts";
import { foldMountName } from "./mounts.ts";

const MOUNT: MountInfo = {
  id: "mount-finance",
  name: "finance-doc",
  globs: ["**/*.pdf"],
  ignore: [".DS_Store"],
  path: "~/Personal/Finance",
  missing: false,
  scanned: "2026-08-20T09:00:00Z",
  files: 13,
};

const ROW: MountRow = {
  rel: "invoices/2026-01.pdf",
  name: "2026-01",
  extension: ".pdf",
  size: 118_004,
  modified: "2026-01-31T10:00:00Z",
  created: "2026-01-31T10:00:00Z",
  identity: "finance-doc:invoices/2026-01.pdf",
  props: { status: "paid" },
};

test("the roster carries the metadata a board needs to say where a folder is", () => {
  const [got] = kindMounts([MOUNT]);
  assert.deepEqual(got, MOUNT);
});

test("the roster is a copy, arrays included — vault code cannot reorder the shelf", () => {
  const live = [MOUNT];
  const handed = kindMounts(live);
  handed.reverse();
  handed[0].globs.push("**/*.txt");
  handed[0].ignore?.push("junk");
  handed[0].missing = true;
  assert.deepEqual(live[0].globs, ["**/*.pdf"]);
  assert.deepEqual(live[0].ignore, [".DS_Store"]);
  assert.equal(live[0].missing, false);
});

test("a mount's rows come back copied, props map included", () => {
  const state = { mount: MOUNT, rows: [ROW] };
  const got = kindMountRows("finance-doc", state);
  assert.ok("rows" in got);
  assert.deepEqual(got.rows, [ROW]);
  got.rows[0].props.status = "unpaid";
  assert.equal(ROW.props.status, "paid");
});

test("a row's props are copied ALL the way down — nested values are the cache's", () => {
  // the state object is the one `dashboardMounts` caches and every chart and
  // card over the same folder reads, so a nested array or map handed over
  // uncopied is vault code editing what the built-in surfaces beside it draw
  const nested: MountRow = {
    ...ROW,
    props: { tags: ["invoice", "2026"], meta: { paid: true, by: { name: "Avery" } } },
  };
  const state = { mount: MOUNT, rows: [nested] };
  const first = kindMountRows("finance-doc", state);
  assert.ok("rows" in first);
  (first.rows[0].props.tags as string[]).push("junk");
  (first.rows[0].props.meta as { paid: boolean }).paid = false;
  ((first.rows[0].props.meta as { by: { name: string } }).by).name = "someone else";

  // the same state object again, the way the same cached read is handed to the
  // next draw: untouched, or the cache is now carrying the kind's edits
  const second = kindMountRows("finance-doc", state);
  assert.ok("rows" in second);
  assert.deepEqual(second.rows[0].props, {
    tags: ["invoice", "2026"],
    meta: { paid: true, by: { name: "Avery" } },
  });
});

test("a padded stored name is reachable — loader and lookup fold the same way", () => {
  // the loader keys its map by the fold of the STORED name and the pane looks
  // it up by the fold of the name a kind asked for; the two spellings of that
  // fold drifted once (trim on one side only) and a mount with a stray space
  // in its name answered "no mount named that" while sitting in the roster
  const padded: MountInfo = { ...MOUNT, name: "  Finance-Doc  " };
  const loaded = new Map([[foldMountName(padded.name), { mount: padded, rows: [ROW] }]]);
  const got = kindMountRows("finance-doc", loaded.get(foldMountName("finance-doc")));
  assert.ok("rows" in got);
  assert.deepEqual(got.rows, [ROW]);
});

test("a name no mount carries refuses by name", () => {
  const got = kindMountRows("no-such-folder", undefined);
  assert.deepEqual(got, { refusal: "no mount named “no-such-folder”" });
});

test("an unreadable index refuses with the reason, not as an empty folder", () => {
  // the one wrong answer here: a board drawing "0 files" over a drive that is
  // simply unplugged from the index
  const got = kindMountRows("finance-doc", { error: "the folder is not bound on this machine" });
  assert.deepEqual(got, { refusal: "the folder is not bound on this machine" });
});
