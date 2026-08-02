import { test } from "node:test";
import assert from "node:assert/strict";

/* SUB-515 — the structural undo helpers against the mock backend. Same shim
   as undo.test.ts: `isTauri` sniffs `window` at module scope, so node has to
   look like a browser before the first app import. */
(globalThis as { window?: unknown }).window = globalThis;
const {
  createFolderUndoable,
  moveFolderUndoable,
  moveUndoable,
  recordCreate,
  recordTrashBulk,
  renameFolderUndoable,
  renameUndoable,
  trashFolderUndoable,
  trashUndoable,
} = await import("./undostruct.ts");
const {
  vaultCreate,
  vaultCreateFolder,
  vaultList,
  vaultRead,
  vaultSetProp,
  vaultTrashList,
  vaultTrashRestore,
  vaultFolders,
  vaultSidebarOrder,
  vaultSetSidebarOrder,
} = await import("./ipc.ts");

type Entry = Omit<import("./undo.ts").UndoEntry, "id"> & { id?: number };

/** the recorder every test uses: keep the last entry, assert on it */
function recorder() {
  const box: { entry: Entry | null } = { entry: null };
  return { box, record: (e: Entry) => (box.entry = e) };
}

const listed = async (path: string) => (await vaultList()).some((n) => n.path === path);

test("trash records an entry whose undo restores that exact note by id", async () => {
  const m = await vaultCreate("Undo Trash Kestrel", "Inbox", "note", [], "body\n");
  const { box, record } = recorder();
  const restored: string[] = [];
  await trashUndoable({ path: m.path, record, restore: (id) => void restored.push(id) });
  assert.equal(await listed(m.path), false, "the note left the vault");
  assert.deepEqual(box.entry!.paths, [m.path]);
  await box.entry!.undo();
  // the restore closure is the caller's (it re-selects and refreshes) — what
  // matters here is that it got the id vault_delete returned, not a path
  assert.equal(restored.length, 1);
  const trash = await vaultTrashList();
  assert.ok(
    trash.some((t) => t.id === restored[0] && t.path === m.path),
    "the id names this note's trash entry"
  );
});

test("two notes trashed from the same path undo to the right one (SUB-478)", async () => {
  const first = await vaultCreate("Undo Same Path", "Inbox", "note", [], "first body\n");
  const ra = recorder();
  let firstId = "";
  await trashUndoable({ path: first.path, record: ra.record, restore: (id) => void (firstId = id) });

  // same title, same folder — the engine hands back the same rel path
  const second = await vaultCreate("Undo Same Path", "Inbox", "note", [], "second body\n");
  assert.equal(second.path, first.path, "the path is genuinely reused");
  const rb = recorder();
  await trashUndoable({ path: second.path, record: rb.record, restore: async () => {} });

  assert.equal(
    (await vaultTrashList()).filter((t) => t.path === first.path).length,
    2,
    "both versions sit in the trash under one path — a path scan would pick wrong"
  );
  // undo the FIRST trash: the entry closed over its own trash id
  await ra.box.entry!.undo();
  const back = await vaultTrashRestore(firstId);
  assert.equal((await vaultRead(back.path)).body.trim(), "first body");
});

test("bulk trash records ONE entry covering every note that landed in the trash", async () => {
  const a = await vaultCreate("Undo Bulk Marram", "Inbox", "note", [], "a\n");
  const b = await vaultCreate("Undo Bulk Sedge", "Inbox", "note", [], "b\n");
  const { box, record } = recorder();
  const restored: string[] = [];
  recordTrashBulk({
    trashed: [
      { path: a.path, id: "id-a" },
      { path: b.path, id: "id-b" },
    ],
    record,
    restore: (id) => void restored.push(id),
  });
  assert.deepEqual(box.entry!.paths, [a.path, b.path]);
  assert.equal(box.entry!.label, "Move 2 notes to Trash");
  await box.entry!.undo();
  assert.deepEqual(restored, ["id-a", "id-b"]);
});

test("bulk trash of nothing records nothing", () => {
  const { box, record } = recorder();
  recordTrashBulk({ trashed: [], record, restore: async () => {} });
  assert.equal(box.entry, null);
});

test("create: undo trashes the note, redo brings back that same trash entry", async () => {
  const m = await vaultCreate("Undo Create Halcyon", "Inbox", "note", [], "kept body\n");
  const { box, record } = recorder();
  recordCreate({ meta: m, record });
  assert.deepEqual(box.entry!.paths, [m.path]);
  await box.entry!.undo();
  assert.equal(await listed(m.path), false, "undoing a create trashes it");
  await box.entry!.redo!();
  assert.equal(await listed(m.path), true, "redo restores it");
  assert.equal(
    (await vaultRead(m.path)).body.trim(),
    "kept body",
    "redo restored the note, it did not create an empty second one"
  );
  assert.equal((await vaultList()).filter((n) => n.title === "Undo Create Halcyon").length, 1);
});

test("move: undo puts the note back in its prior folder", async () => {
  const m = await vaultCreate("Undo Move Tern", "Inbox", "note", [], "body\n");
  await vaultCreateFolder("Undo Move Dest");
  const { box, record } = recorder();
  const moved = await moveUndoable({ path: m.path, folder: "Undo Move Dest", record });
  assert.equal(moved.folder, "Undo Move Dest");
  assert.deepEqual(box.entry!.paths, [m.path, moved.path], "both rel paths invalidate the entry");
  await box.entry!.undo();
  assert.equal(await listed(m.path), true, "back where it started");
  await box.entry!.redo!();
  assert.equal(await listed(moved.path), true);
});

test("a move that didn't move records nothing", async () => {
  const m = await vaultCreate("Undo Move Noop", "Inbox", "note", [], "body\n");
  const { box, record } = recorder();
  await moveUndoable({ path: m.path, folder: "Inbox", record });
  assert.equal(box.entry, null);
});

test("rename: the entry names every note the link sweep rewrote (SUB-515)", async () => {
  const target = await vaultCreate("Undo Rename Alder", "Releases", "note", [], "the note\n");
  // link sources OUTSIDE the renamed note's folder — the case that makes
  // path-only invalidation wrong
  const src = await vaultCreate(
    "Undo Rename Field Log",
    "Journal",
    "note",
    [],
    "saw [[Undo Rename Alder]] again\n"
  );
  const bystander = await vaultCreate("Undo Rename Bystander", "Journal", "note", [], "nothing\n");
  const { box, record } = recorder();
  const m = await renameUndoable({
    path: target.path,
    title: "Undo Rename Birch",
    priorTitle: "Undo Rename Alder",
    record,
  });
  assert.equal((await vaultRead(src.path)).body.trim(), "saw [[Undo Rename Birch]] again");
  assert.ok(box.entry!.paths.includes(m.path), "the renamed note");
  assert.ok(box.entry!.paths.includes(src.path), "the link source in another folder");
  assert.ok(!box.entry!.paths.includes(bystander.path), "a note it never touched stays out");

  await box.entry!.undo();
  assert.equal(
    (await vaultRead(src.path)).body.trim(),
    "saw [[Undo Rename Alder]] again",
    "undoing a rename sweeps the links back with it"
  );
  assert.equal(await listed(target.path), true);
});

test("rename: undo and redo announce their move through onApplied (SUB-783)", async () => {
  const target = await vaultCreate("Undo Rename Announce", "Releases", "note", [], "x\n");
  const { box, record } = recorder();
  const applied: [string, string][] = [];
  const m = await renameUndoable({
    path: target.path,
    title: "Undo Rename Announced",
    priorTitle: "Undo Rename Announce",
    record,
    onApplied: (oldPath, meta) => void applied.push([oldPath, meta.path]),
  });
  // the forward rename is the caller's own .then — onApplied is undo/redo only
  assert.deepEqual(applied, []);
  await box.entry!.undo();
  assert.deepEqual(applied, [[m.path, target.path]], "undo announces new→old");
  await box.entry!.redo!();
  assert.deepEqual(applied[applied.length - 1], [target.path, m.path], "redo announces old→new");
});

test("rename: a relation prop pointing at the note counts as touched", async () => {
  await vaultCreate("Undo Rel Contact", "People", "contact", [], "x\n");
  const { vaultSchemaSet } = await import("./ipc.ts");
  await vaultSchemaSet("charter", "contact", [], "relation", undefined, "contact");
  const charter = await vaultCreate("Undo Rel Charter", "Releases", "charter", [], "y\n");
  await vaultSetProp(charter.path, "contact", "Undo Rel Contact");
  const { box, record } = recorder();
  await renameUndoable({
    path: "People/Undo Rel Contact.md",
    title: "Undo Rel Contact Two",
    priorTitle: "Undo Rel Contact",
    record,
  });
  assert.equal((await vaultRead(charter.path)).props.contact, "Undo Rel Contact Two");
  assert.ok(box.entry!.paths.includes(charter.path), "the relation source invalidates the entry too");
});

test("folder create: undo trashes the folder, redo restores it", async () => {
  const { box, record } = recorder();
  const rel = await createFolderUndoable({ path: "Undo Folder Quarry", record });
  assert.ok((await vaultFolders()).includes(rel));
  await box.entry!.undo();
  assert.ok(!(await vaultFolders()).includes(rel), "undo took the folder back");
  await box.entry!.redo!();
  assert.ok((await vaultFolders()).includes(rel));
});

test("folder rename: the inverse uses the rel the engine returned, and covers the notes inside", async () => {
  await vaultCreateFolder("Undo Folder Ren");
  const inside = await vaultCreate("Undo Folder Inside", "Undo Folder Ren", "note", [], "body\n");
  const { box, record } = recorder();
  const newRel = await renameFolderUndoable({
    path: "Undo Folder Ren",
    name: "Undo Folder Renamed",
    notePaths: [inside.path],
    record,
  });
  assert.equal(newRel, "Undo Folder Renamed");
  assert.ok(box.entry!.paths.includes(inside.path), "a note inside invalidates the entry");
  await box.entry!.undo();
  assert.ok((await vaultFolders()).includes("Undo Folder Ren"));
  assert.equal(await listed(inside.path), true, "the note came back with the folder");
});

test("folder move: undo puts the folder back, with its sidebar order lanes", async () => {
  // SUB-698 review: dragging a dash group header onto a tree row was a bare
  // vaultMoveFolder — no undo entry at all. The inverse is a move back to the
  // parent it came from, and the engine's path-keyed lanes ride the inverse.
  await vaultCreateFolder("Undo MF/Group");
  await vaultCreateFolder("Undo MF Dest");
  const a = await vaultCreate("Undo MF Alpha", "Undo MF/Group", "note", [], "a\n");
  const b = await vaultCreate("Undo MF Beta", "Undo MF/Group", "note", [], "b\n");
  const before = await vaultSidebarOrder();
  // a deliberately non-alphabetical manual order: Beta before Alpha
  await vaultSetSidebarOrder({
    ...before,
    dashboards: [b.path, a.path],
    dashgroups: ["Undo MF/Group"],
  });

  const { box, record } = recorder();
  const followed: [string, string][] = [];
  const newRel = await moveFolderUndoable({
    path: "Undo MF/Group",
    target: "Undo MF Dest",
    notePaths: [a.path, b.path],
    record,
    follow: (from, to) => void followed.push([from, to]),
  });
  assert.equal(newRel, "Undo MF Dest/Group");
  assert.ok((await vaultFolders()).includes("Undo MF Dest/Group"));
  assert.ok(box.entry!.paths.includes(a.path), "a note inside invalidates the entry");
  assert.deepEqual(followed, [["Undo MF/Group", "Undo MF Dest/Group"]]);
  const moved = await vaultSidebarOrder();
  assert.deepEqual(
    moved.dashboards,
    ["Undo MF Dest/Group/Undo MF Beta.md", "Undo MF Dest/Group/Undo MF Alpha.md"],
    "the dashboards lane is retargeted, manual order intact"
  );
  assert.deepEqual(moved.dashgroups, ["Undo MF Dest/Group"]);

  await box.entry!.undo();
  assert.ok((await vaultFolders()).includes("Undo MF/Group"), "undo moved the folder back");
  assert.equal(await listed("Undo MF/Group/Undo MF Alpha.md"), true, "the notes came back too");
  const back = await vaultSidebarOrder();
  assert.deepEqual(
    back.dashboards,
    ["Undo MF/Group/Undo MF Beta.md", "Undo MF/Group/Undo MF Alpha.md"],
    "undo restores the order lane, not just the position"
  );
  assert.deepEqual(back.dashgroups, ["Undo MF/Group"]);
  assert.deepEqual(followed[1], ["Undo MF Dest/Group", "Undo MF/Group"], "undo follows the UI too");

  await box.entry!.redo!();
  assert.ok((await vaultFolders()).includes("Undo MF Dest/Group"), "redo moves it out again");
});

test("folder trash: undo restores by the trash id, no redo", async () => {
  await vaultCreateFolder("Undo Folder Trashme");
  const inside = await vaultCreate("Undo Folder Trashed Note", "Undo Folder Trashme", "note", [], "b\n");
  const { box, record } = recorder();
  const restored: string[] = [];
  const trashId = await trashFolderUndoable({
    path: "Undo Folder Trashme",
    notePaths: [inside.path],
    record,
    restore: (id) => void restored.push(id),
  });
  assert.ok(!(await vaultFolders()).includes("Undo Folder Trashme"));
  assert.ok(box.entry!.paths.includes(inside.path));
  assert.equal(box.entry!.redo, undefined, "restore can renumber, so re-trashing isn't a redo");
  await box.entry!.undo();
  assert.deepEqual(restored, [trashId]);
});
