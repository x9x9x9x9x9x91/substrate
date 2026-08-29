import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deleteDbOutcome,
  renameDbOutcome,
  renamePropOutcome,
  schemaOnlyClearOutcome,
  presweep,
  snapshotRestore,
  stripPropOutcome,
  withSnapshotWarning,
} from "./sweep.ts";

/** A sweep that ran to completion. */
const ok = (notes: number, skipped = 0) => ({ notes, skipped });

test("the snapshot warning is appended to the outcome, never substituted for it", () => {
  const warned = withSnapshotWarning(deleteDbOutcome("books", true, ok(5)), false);
  assert.match(warned, /Moved 5 notes to Trash/, "the outcome survives the warning");
  assert.match(warned, /no safety snapshot/, "and the warning is there too");
});

test("both delete variants stay distinguishable when the snapshot is missing", () => {
  const trashed = withSnapshotWarning(deleteDbOutcome("books", true, ok(5)), false);
  const kept = withSnapshotWarning(deleteDbOutcome("books", false, ok(5)), false);
  assert.notEqual(trashed, kept);
  assert.match(trashed, /to Trash/);
  assert.match(kept, /5 notes kept/);
  assert.doesNotMatch(kept, /Trash/, "keeping notes never reads as trashing them");
});

test("renameProperty keeps its skipped clause alongside the warning", () => {
  const warned = withSnapshotWarning(
    renamePropOutcome("author", "state", ok(5, 2)),
    false
  );
  assert.match(warned, /Renamed in 5 notes/);
  assert.match(warned, /2 skipped \(kept existing “state”\)/);
  assert.match(warned, /no safety snapshot/);
});

test("a snapshotted sweep reports the outcome and nothing else", () => {
  assert.equal(
    withSnapshotWarning(renameDbOutcome("Record", "Album", ok(3)), true),
    "Renamed to “Album” — 3 notes updated"
  );
  assert.doesNotMatch(
    withSnapshotWarning(stripPropOutcome("status", ok(4)), true),
    /snapshot/
  );
});

test("schema-only clear keeps a failed saved-view cleanup out of the success path", () => {
  const result = schemaOnlyClearOutcome("price", {
    notes: 0,
    skipped: 0,
    failed: ".vault/views.json: permission denied",
  });

  assert.equal(result.completed, false, "the caller must not reload or announce success");
  assert.match(result.message, /Couldn't clean saved views/);
  assert.match(result.message, /removed from the schema/, "the landed demotion remains explicit");
  assert.match(result.message, /permission denied/, "the backend failure survives verbatim");
  assert.doesNotMatch(result.message, /^Property .* removed$/, "not the completed-removal toast");
});

test("outcomes single-plural their note counts", () => {
  assert.match(renameDbOutcome("Record", "Album", ok(1)), /1 note updated/);
  assert.match(deleteDbOutcome("books", true, ok(1)), /Moved 1 note to Trash/);
  assert.match(deleteDbOutcome("books", false, ok(1)), /1 note kept/);
  assert.match(renamePropOutcome("author", "state", ok(1)), /Renamed in 1 note$/);
  assert.match(stripPropOutcome("status", ok(1)), /from 1 note$/);
});

/* A sweep that dies partway used to reject the whole IPC call, so the
   user saw the error alone and never learned how much of the vault had already
   changed. Every partial outcome now carries the count AND the error. */

const died = (notes: number, skipped = 0) => ({
  notes,
  skipped,
  failed: "Inbox/B.md: fix it in the editor",
});

test("every partial sweep reports its count and the error together", () => {
  for (const outcome of [
    renameDbOutcome("Record", "Album", died(40)),
    deleteDbOutcome("books", true, died(40)),
    deleteDbOutcome("books", false, died(40)),
    renamePropOutcome("author", "writer", died(40)),
    stripPropOutcome("status", died(40)),
  ]) {
    assert.match(outcome, /40 notes/, `count reported: ${outcome}`);
    assert.match(outcome, /then failed/, `failure reported: ${outcome}`);
    assert.match(outcome, /Inbox\/B\.md/, `the error text survives: ${outcome}`);
  }
});

test("a partial sweep never claims the rename or delete it didn't finish", () => {
  const renamedDb = renameDbOutcome("Record", "Album", died(40));
  assert.doesNotMatch(renamedDb, /Renamed to/, "the database kept its old name");
  assert.match(renamedDb, /still “Record”/);

  const deleted = deleteDbOutcome("books", false, died(40));
  assert.doesNotMatch(deleted, /Database removed/, "the database is still there");
  assert.match(deleted, /“books” was not removed/);

  const renamedProp = renamePropOutcome("author", "writer", died(40));
  assert.match(renamedProp, /Renamed in 40 notes/, "the notes that changed are named");
  assert.match(renamedProp, /still “author”/, "but the property itself did not");
});

test("a partial sweep keeps the snapshot warning alongside both halves", () => {
  const warned = withSnapshotWarning(stripPropOutcome("status", died(7)), false);
  assert.match(warned, /Deleted “status” values from 7 notes/);
  assert.match(warned, /then failed: Inbox\/B\.md/);
  assert.match(warned, /no safety snapshot/);
});

test("a partial rename drops the skipped clause for the failure clause", () => {
  // the skipped tally belongs to the completed message; a sweep that stopped
  // reports where it stopped instead, so the two clauses never stack up
  const partial = renamePropOutcome("author", "writer", died(5, 2));
  assert.match(partial, /Renamed in 5 notes, then failed/);
  assert.doesNotMatch(partial, /skipped/);
});

test("a partial sweep that rewrote nothing still says so", () => {
  const outcome = renamePropOutcome("author", "writer", died(0));
  assert.match(outcome, /Renamed in 0 notes/, "zero is a real, reportable answer");
  assert.match(outcome, /then failed/);
});

test("a vault with no history lets the sweep through, saying so", async () => {
  // history off is a state, not a failure: the sweep runs and the outcome
  // carries the warning (`withSnapshotWarning` above)
  assert.equal(await presweep(() => Promise.resolve(false), "before delete database books"), false);
  assert.equal(await presweep(() => Promise.resolve(true), "before delete database books"), true);
});

test("a snapshot that failed stops the sweep and says nothing was changed", async () => {
  await assert.rejects(
    presweep(() => Promise.reject(new Error("could not write index")), "before delete database books"),
    (e: Error) => {
      assert.match(
        e.message,
        /nothing was changed/,
        "a reader has to know which half of the operation they are looking at"
      );
      assert.match(e.message, /could not write index/, "and why the snapshot failed");
      assert.match(e.message, /before delete database books/, "and which sweep it was for");
      assert.doesNotMatch(
        e.message,
        /no safety snapshot taken/,
        "a failed commit is not a vault without history — that phrasing would read as a sweep that ran"
      );
      return true;
    }
  );
});

test("the restore door is only offered when a snapshot was actually taken", () => {
  let opened = 0;
  const offered = snapshotRestore(true, () => opened++);
  assert.equal(offered?.label, "Restore from snapshot");
  offered?.run();
  assert.equal(opened, 1, "the button opens the vault history the snapshot lives in");
  assert.equal(
    snapshotRestore(false, () => opened++),
    undefined,
    "offering a restore there is none of is worse than silence"
  );
});
