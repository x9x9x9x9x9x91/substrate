import { test } from "node:test";
import assert from "node:assert/strict";
import type { UndoEntry } from "./undo.ts";

/* Dropping a note on a tag folder is undoable like every other
   prop edit. The mock backend lives behind `isTauri`, which sniffs `window`
   at module scope, so shim one before importing (same trick as
   noteactions.test.ts) and import the app modules dynamically. */
(globalThis as { window?: unknown }).window = globalThis;
const { vaultCreate, vaultFmWrite, vaultRead, vaultSetProp } = await import("./ipc.ts");
const { addTagsUndoable, setPropUndoable, setPropsUndoable } = await import("./undoprops.ts");

/** A note whose frontmatter really holds `key: []`. It has to be hand-written:
    the write domain removes a key set to an empty list, so no amount of
    setProp can leave one behind — and `prior` coming back as `[]` is exactly
    the state the redo-side guards have to expect. */
async function noteWithEmptyList(title: string, key: string) {
  const note = await vaultCreate(title, "Topics", undefined, undefined, "body\n");
  await vaultFmWrite(note.path, `${key}: []\n`);
  assert.deepEqual((await vaultRead(note.path)).props[key], [], "the fixture starts from a written []");
  return note;
}

function recorder(): { entries: (Omit<UndoEntry, "id"> & { id?: number })[]; record: (e: Omit<UndoEntry, "id"> & { id?: number }) => void } {
  const entries: (Omit<UndoEntry, "id"> & { id?: number })[] = [];
  return { entries, record: (e) => entries.push(e) };
}

test("addTagsUndoable: records an entry and undo restores the prior tags", async () => {
  const note = await vaultCreate("Drop Target", "Tagged", undefined, undefined, "body\n");
  await vaultSetProp(note.path, "tags", ["keep"]);
  const rec = recorder();

  await addTagsUndoable({ path: note.path, tags: ["demo", "live"], record: rec.record });

  assert.equal(rec.entries.length, 1, "the drop records exactly one undo entry");
  const entry = rec.entries[0];
  assert.deepEqual(entry.paths, [note.path]);
  assert.equal(entry.label, "Tagged #demo #live");
  assert.deepEqual((await vaultRead(note.path)).props["tags"], ["keep", "demo", "live"]);

  await entry.undo?.();
  assert.deepEqual(
    (await vaultRead(note.path)).props["tags"],
    ["keep"],
    "undo restores the exact prior list"
  );

  await entry.redo?.();
  assert.deepEqual((await vaultRead(note.path)).props["tags"], ["keep", "demo", "live"]);
});

test("addTagsUndoable: overlapping tags survive undo — the add is a union", async () => {
  const note = await vaultCreate("Overlap", "Tagged", undefined, undefined, "body\n");
  await vaultSetProp(note.path, "tags", ["demo", "keep"]);
  const rec = recorder();

  await addTagsUndoable({ path: note.path, tags: ["demo", "live"], record: rec.record });
  assert.deepEqual((await vaultRead(note.path)).props["tags"], ["demo", "keep", "live"]);

  await rec.entries[0].undo?.();
  assert.deepEqual(
    (await vaultRead(note.path)).props["tags"],
    ["demo", "keep"],
    "the tag the note already carried is NOT removed by undo"
  );
});

test("addTagsUndoable: a note with no tags yet undoes back to none", async () => {
  const note = await vaultCreate("Bare", "Tagged", undefined, undefined, "body\n");
  const rec = recorder();

  await addTagsUndoable({ path: note.path, tags: ["demo"], record: rec.record });
  assert.deepEqual((await vaultRead(note.path)).props["tags"], ["demo"]);

  await rec.entries[0].undo?.();
  assert.equal((await vaultRead(note.path)).props["tags"], undefined);
});

test("addTagsUndoable: a no-op drop records nothing", async () => {
  const note = await vaultCreate("Already", "Tagged", undefined, undefined, "a #demo body\n");
  const rec = recorder();

  await addTagsUndoable({ path: note.path, tags: ["demo"], record: rec.record });
  assert.equal(rec.entries.length, 0, "the note already carried the tag inline — nothing to undo");
});

test("addTagsUndoable: undo is refused when the tags moved on disk", async () => {
  const note = await vaultCreate("Conflict", "Tagged", undefined, undefined, "body\n");
  await vaultSetProp(note.path, "tags", ["keep"]);
  const rec = recorder();

  await addTagsUndoable({ path: note.path, tags: ["demo"], record: rec.record });
  // someone else edits the prop between the drop and the ⌘Z
  await vaultSetProp(note.path, "tags", ["elsewhere"]);

  await assert.rejects(() => rec.entries[0].undo!(), /conflict:/);
  assert.deepEqual(
    (await vaultRead(note.path)).props["tags"],
    ["elsewhere"],
    "the refused undo left the other edit alone"
  );
});

test("setPropUndoable: a list cleared to nothing still undoes and redoes", async () => {
  // the write domain removes a key written as an empty list, so the inverse
  // has to be guarded on the key being ABSENT — guarding on the `[]` we asked
  // for is a claim no note can satisfy, and every undo of a cleared list
  // (the feed's "all topics" chip, a cleared tag set) would be refused as a
  // conflict with the state that write had just produced
  const note = await vaultCreate("Cleared List", "Topics", undefined, undefined, "body\n");
  await vaultSetProp(note.path, "feed-topics", ["plugins", "ai"]);
  const rec = recorder();

  await setPropUndoable({ path: note.path, key: "feed-topics", value: [], record: rec.record });
  assert.equal((await vaultRead(note.path)).props["feed-topics"], undefined, "the key is gone");

  const entry = rec.entries[0];
  await entry.undo?.();
  assert.deepEqual((await vaultRead(note.path)).props["feed-topics"], ["plugins", "ai"]);

  await entry.redo?.();
  assert.equal((await vaultRead(note.path)).props["feed-topics"], undefined);
});

test("setPropUndoable: a hand-written empty list undoes back to absence", async () => {
  // the other side of the same rule: `prior` can itself be an empty list when
  // a person typed `feed-topics: []` into the note, and the redo guard has to
  // expect what the undo actually left behind — no key
  const note = await noteWithEmptyList("Empty List", "feed-topics");
  const rec = recorder();

  await setPropUndoable({
    path: note.path,
    key: "feed-topics",
    value: ["scene"],
    record: rec.record,
  });
  const entry = rec.entries[0];
  await entry.undo?.();
  assert.equal(
    (await vaultRead(note.path)).props["feed-topics"],
    undefined,
    "the written [] came back as no key at all"
  );
  await entry.redo?.();
  assert.deepEqual((await vaultRead(note.path)).props["feed-topics"], ["scene"]);
});

test("addTagsUndoable: a hand-written empty tag list round-trips undo → redo", async () => {
  // same rule, the tag-drop path: undo puts `tags: []` back, which is no key,
  // so redo has to guard on absence or refuse the state it just asked for
  const note = await noteWithEmptyList("Empty Tags", "tags");
  const rec = recorder();

  await addTagsUndoable({ path: note.path, tags: ["demo"], record: rec.record });
  assert.deepEqual((await vaultRead(note.path)).props["tags"], ["demo"]);

  const entry = rec.entries[0];
  await entry.undo?.();
  assert.equal((await vaultRead(note.path)).props["tags"], undefined);
  await entry.redo?.();
  assert.deepEqual((await vaultRead(note.path)).props["tags"], ["demo"]);
});

test("setPropsUndoable: a hand-written empty list round-trips undo → redo", async () => {
  // and the multi-key path, both directions: one edit starts from a written
  // [] (redo-side guard), the other is cleared TO nothing (undo-side guard)
  const note = await noteWithEmptyList("Empty List Multi", "feed-topics");
  await vaultSetProp(note.path, "tags", ["keep"]);
  const rec = recorder();

  await setPropsUndoable({
    path: note.path,
    edits: [
      { key: "feed-topics", value: ["scene"] },
      { key: "tags", value: [] },
    ],
    record: rec.record,
    label: "Two keys",
  });
  assert.deepEqual((await vaultRead(note.path)).props["feed-topics"], ["scene"]);
  assert.equal((await vaultRead(note.path)).props["tags"], undefined, "cleared to nothing");

  const entry = rec.entries[0];
  await entry.undo?.();
  const undone = (await vaultRead(note.path)).props;
  assert.equal(undone["feed-topics"], undefined, "the written [] is absence again");
  assert.deepEqual(undone["tags"], ["keep"]);

  await entry.redo?.();
  const redone = (await vaultRead(note.path)).props;
  assert.deepEqual(redone["feed-topics"], ["scene"]);
  assert.equal(redone["tags"], undefined);
});

test("setPropUndoable: an inverse is still refused when the prop moved on disk", async () => {
  // the guard relaxation above must not become "no guard": a scalar that
  // somebody else changed since is still off limits
  const note = await vaultCreate("Moved Prop", "Topics", undefined, undefined, "body\n");
  const rec = recorder();

  await setPropUndoable({ path: note.path, key: "status", value: "draft", record: rec.record });
  await vaultSetProp(note.path, "status", "shipped");

  await assert.rejects(() => rec.entries[0].undo!(), /conflict/);
  assert.equal((await vaultRead(note.path)).props["status"], "shipped");
});
