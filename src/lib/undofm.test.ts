import { test } from "node:test";
import assert from "node:assert/strict";

/* The frontmatter-block undo helper against the mock backend. Same shim as
   undostruct.test.ts: `isTauri` sniffs `window` at module scope, so node has
   to look like a browser before the first app import. */
(globalThis as { window?: unknown }).window = globalThis;
const { fmWriteUndoable } = await import("./undofm.ts");
const { vaultCreate, vaultFmRaw, vaultFmWrite } = await import("./ipc.ts");

type Entry = Omit<import("./undo.ts").UndoEntry, "id"> & { id?: number };

/** the recorder every test uses: keep the last entry, assert on it */
function recorder() {
  const box: { entry: Entry | null } = { entry: null };
  return { box, record: (e: Entry) => (box.entry = e) };
}

test("a frontmatter rewrite undoes to the whole prior block", async () => {
  const m = await vaultCreate("Undo Fm Kestrel", "Inbox", "note", [], "body\n");
  await vaultFmWrite(m.path, "type: note\nstatus: draft\ntally: 3\n");
  const before = await vaultFmRaw(m.path);
  const { box, record } = recorder();
  await fmWriteUndoable({ path: m.path, fm: "type: note\n", before, record });
  assert.equal((await vaultFmRaw(m.path))?.raw.includes("status"), false, "the repair landed");
  assert.deepEqual(box.entry!.paths, [m.path], "the note, so an external edit disarms it");

  await box.entry!.undo();
  assert.equal((await vaultFmRaw(m.path))?.raw, before!.raw, "the dropped keys are back");
  await box.entry!.redo!();
  assert.equal((await vaultFmRaw(m.path))?.raw.includes("status"), false);
});

test("a note that had no frontmatter at all undoes back to none", async () => {
  const m = await vaultCreate("Undo Fm Bare", "Inbox", undefined, [], "just a body\n");
  await vaultFmWrite(m.path, "");
  assert.equal(await vaultFmRaw(m.path), null, "no block to start with");

  const { box, record } = recorder();
  await fmWriteUndoable({ path: m.path, fm: "pages:\n  - label: Cash\n", before: null, record });
  assert.ok(await vaultFmRaw(m.path), "the append landed");

  await box.entry!.undo();
  // an empty block and no block are different states; landing on the former
  // would leave `---\n---` at the top of a note that never had one
  assert.equal(await vaultFmRaw(m.path), null, "back to no block at all");
});

test("a frontmatter undo refuses once the block changed underneath it", async () => {
  const m = await vaultCreate("Undo Fm Moved", "Inbox", "note", [], "body\n");
  await vaultFmWrite(m.path, "type: note\nstatus: draft\n");
  const before = await vaultFmRaw(m.path);
  const { box, record } = recorder();
  await fmWriteUndoable({ path: m.path, fm: "type: note\n", before, record });
  await vaultFmWrite(m.path, "type: note\nstatus: shipped\n");
  await assert.rejects(box.entry!.undo(), /conflict:/);
  assert.equal((await vaultFmRaw(m.path))?.raw.includes("shipped"), true, "the other edit stands");
});

test("a block the engine refuses records nothing", async () => {
  const m = await vaultCreate("Undo Fm Refused", "Inbox", "note", [], "body\n");
  const before = await vaultFmRaw(m.path);
  const { box, record } = recorder();
  await assert.rejects(
    fmWriteUndoable({ path: m.path, fm: "status: [unclosed\n", before, record })
  );
  assert.equal(box.entry, null, "nothing landed, so there is nothing to take back");
  assert.equal((await vaultFmRaw(m.path))?.raw, before?.raw);
});

test("a frontmatter write whose readback fails records nothing", async () => {
  const m = await vaultCreate("Undo Fm Unread", "Inbox", "note", [], "body\n");
  await vaultFmWrite(m.path, "type: note\nstatus: draft\n");
  const before = await vaultFmRaw(m.path);

  const win = globalThis as { __mockFailOnce?: (cmd: string) => void };
  win.__mockFailOnce!("vault_fm_raw");
  const { box, record } = recorder();
  const warnings: unknown[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    await fmWriteUndoable({ path: m.path, fm: "type: note\n", before, record });
  } finally {
    console.warn = realWarn;
  }

  // a block that could not be read back is not a note without one: an entry
  // guarded on "there was nothing here" would refuse forever, and its redo
  // would write the note's real frontmatter away
  assert.equal(box.entry, null, "no entry stands on a block nobody read");
  assert.equal(warnings.length, 1, "and the skip says why");
  assert.equal((await vaultFmRaw(m.path))?.raw.includes("status"), false, "the write still landed");
});
