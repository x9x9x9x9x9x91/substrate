import { test } from "node:test";
import assert from "node:assert/strict";

/* The view-config undo helpers against the mock backend. Same shim as
   undostruct.test.ts: `isTauri` sniffs `window` at module scope, so node has
   to look like a browser before the first app import. */
(globalThis as { window?: unknown }).window = globalThis;
const { sameConfig } = await import("./undo.ts");
const {
  savedViewDeleteUndoable,
  savedViewSetUndoable,
  setDbPrefUndoable,
  setFolderIconUndoable,
  setSidebarOrderUndoable,
} = await import("./undoviews.ts");
const {
  vaultFolderMetaRead,
  vaultSavedViewSet,
  vaultSavedViewsRead,
  vaultSetSidebarOrder,
  vaultSidebarOrder,
  vaultViewsRead,
  vaultViewsSet,
} = await import("./ipc.ts");
type SavedView = import("./types.ts").SavedView;
type ViewPref = import("./types.ts").ViewPref;

type Entry = Omit<import("./undo.ts").UndoEntry, "id"> & { id?: number };

/** the recorder every test uses: keep the last entry, assert on it */
function recorder() {
  const box: { entry: Entry | null } = { entry: null };
  return { box, record: (e: Entry) => (box.entry = e) };
}

/** the app's queued writer, minus React: run the write, hand its response to
    the adopter, return it for the guard to read */
const apply = async <T,>(write: () => Promise<T>, adopt: (value: T) => void): Promise<T> => {
  const value = await write();
  adopt(value);
  return value;
};
const noAdopt = () => undefined;

const pref = (p: Partial<ViewPref>): ViewPref => ({ view: "table", ...p }) as ViewPref;

test("a db pref undo puts the whole prior pref back, not just the field that changed", async () => {
  const db = "undoviews-pref";
  await vaultViewsSet(db, "table", undefined, undefined, undefined, [{ key: "due", dir: 1 as const }], [
    "due",
    "status",
  ]);
  const before = (await vaultViewsRead())[db];
  const { box, record } = recorder();
  await setDbPrefUndoable({
    db,
    pref: pref({ view: "board", group_by: "status" }),
    before,
    record,
    apply,
    adopt: noAdopt,
  });
  assert.equal((await vaultViewsRead())[db].view, "board");
  assert.deepEqual(box.entry!.paths, [".vault/views.json"]);

  await box.entry!.undo();
  // the sorts and column order the board edit never mentioned are the whole
  // point: a partial vault_views_set would have wiped them
  assert.ok(sameConfig((await vaultViewsRead())[db], before), "the prior pref came back whole");

  await box.entry!.redo!();
  assert.equal((await vaultViewsRead())[db].view, "board");
});

test("a db pref with nothing stored before it records nothing", async () => {
  const db = "undoviews-fresh";
  const { box, record } = recorder();
  await setDbPrefUndoable({
    db,
    pref: pref({ view: "board" }),
    before: undefined,
    record,
    apply,
    adopt: noAdopt,
  });
  // vault_views_set can replace an entry but never remove one, so "no pref at
  // all" is a state no inverse could write back
  assert.equal(box.entry, null);
});

test("a db pref undo refuses once someone else moved the pref", async () => {
  const db = "undoviews-moved";
  await vaultViewsSet(db, "table");
  const before = (await vaultViewsRead())[db];
  const { box, record } = recorder();
  await setDbPrefUndoable({
    db,
    pref: pref({ view: "board" }),
    before,
    record,
    apply,
    adopt: noAdopt,
  });
  await vaultViewsSet(db, "gallery");
  await assert.rejects(box.entry!.undo(), /conflict:/);
  assert.equal((await vaultViewsRead())[db].view, "gallery", "the other edit stands");
});

test("saving a new pin undoes to no pin; saving over one undoes to the old pin", async () => {
  const view: SavedView = { id: "uv-new", name: "Kestrel", db: "task", view: "table" };
  const fresh = recorder();
  await savedViewSetUndoable({ view, before: null, record: fresh.record, apply, adopt: noAdopt });
  assert.ok((await vaultSavedViewsRead()).some((v) => v.id === view.id));
  await fresh.box.entry!.undo();
  assert.equal(
    (await vaultSavedViewsRead()).some((v) => v.id === view.id),
    false,
    "a pin that didn't exist goes away again"
  );
  await fresh.box.entry!.redo!();

  const renamed: SavedView = { ...view, name: "Kestrel rework" };
  const over = recorder();
  await savedViewSetUndoable({
    view: renamed,
    before: view,
    record: over.record,
    apply,
    adopt: noAdopt,
  });
  await over.box.entry!.undo();
  assert.equal((await vaultSavedViewsRead()).find((v) => v.id === view.id)!.name, "Kestrel");
});

test("deleting a pin undoes to its old position, with its sidebar shortcut back", async () => {
  const ids = ["uv-a", "uv-b", "uv-c"];
  for (const id of ids)
    await vaultSavedViewSet({ id, name: id.toUpperCase(), db: "task", view: "table" });
  const before = await vaultSavedViewsRead();
  const middle = before.find((v) => v.id === "uv-b")!;
  const order = await vaultSidebarOrder();
  const beforeKeys = { ...(order.keys ?? {}), "5": "sv:uv-b" };
  await vaultSetSidebarOrder({ ...order, keys: beforeKeys });

  const { box, record } = recorder();
  await savedViewDeleteUndoable({
    removed: middle,
    before,
    beforeKeys,
    record,
    apply,
    adopt: noAdopt,
  });
  assert.equal(
    (await vaultSavedViewsRead()).some((v) => v.id === "uv-b"),
    false
  );
  assert.equal((await vaultSidebarOrder()).keys?.["5"], undefined, "the shortcut went with it");

  await box.entry!.undo();
  const after = await vaultSavedViewsRead();
  assert.deepEqual(
    after.map((v) => v.id),
    before.map((v) => v.id),
    "the pin came back where it stood, not appended to the end"
  );
  assert.equal((await vaultSidebarOrder()).keys?.["5"], "sv:uv-b", "and answers to its key again");
});

/** Fail the Nth call to a command and only that one. `__mockFailOnce` binds
    to the NEXT call, and the call under test is three writes deep inside a
    single closure; the mock only ever asks `__mockFail` whether it `has(cmd)`,
    so a counting stand-in puts the rejection exactly where the walk is most
    fragile. */
function failOnNthCall(cmd: string, n: number): () => void {
  const win = globalThis as { __mockFail?: Set<string> };
  let seen = 0;
  win.__mockFail = { has: (c: string) => c === cmd && ++seen === n } as unknown as Set<string>;
  return () => {
    delete win.__mockFail;
  };
}

test("a pin delete undo that fails mid-walk loses no pin", async () => {
  const ids = ["uv-f1", "uv-f2", "uv-f3", "uv-f4"];
  for (const id of ids)
    await vaultSavedViewSet({ id, name: id.toUpperCase(), db: "task", view: "table" });
  const before = await vaultSavedViewsRead();
  const first = before.find((v) => v.id === "uv-f1")!;

  /* Shortcuts on the pin being restored AND on one the walk re-issues behind
     it: the walk's deletes knock both out, so a failure that leaves without
     putting them back loses them permanently — the captured map is the only
     copy left. */
  const order = await vaultSidebarOrder();
  const beforeKeys = { ...(order.keys ?? {}), "8": "sv:uv-f1", "9": "sv:uv-f3" };
  await vaultSetSidebarOrder({ ...order, keys: beforeKeys });

  /* the pane's own copy of the pin list, so the test can see whether the
     rollback repaired the SIDEBAR or only the file */
  let shown: SavedView[] = before;
  const { box, record } = recorder();
  await savedViewDeleteUndoable({
    removed: first,
    before,
    beforeKeys,
    record,
    apply,
    adopt: (views: SavedView[]) => {
      shown = views;
    },
  });

  /* The walk is set(restored), then delete+set for every pin that followed —
     so the third set is one of the re-issues, taken after its delete already
     landed. That is the window where a pin exists nowhere but this closure. */
  const undoFail = failOnNthCall("vault_saved_view_set", 3);
  await assert.rejects(box.entry!.undo());
  undoFail();

  const after = await vaultSavedViewsRead();
  for (const v of before)
    assert.ok(
      after.some((p) => p.id === v.id),
      `${v.id} was dropped by the failed undo`
    );

  const keys = (await vaultSidebarOrder()).keys ?? {};
  assert.equal(keys["8"], "sv:uv-f1", "the restored pin's shortcut was lost with the failure");
  assert.equal(keys["9"], "sv:uv-f3", "a re-issued pin's shortcut was lost with the failure");

  for (const v of before)
    assert.ok(
      shown.some((p) => p.id === v.id),
      `${v.id} is back on disk but still missing from the sidebar`
    );
});

test("a pin delete undo puts its own shortcut back without erasing one assigned since", async () => {
  const ids = ["uv-k1", "uv-k2"];
  for (const id of ids)
    await vaultSavedViewSet({ id, name: id.toUpperCase(), db: "task", view: "table" });
  const before = await vaultSavedViewsRead();
  /* The removed pin is the LAST one, so the walk re-issues nothing behind it
     and the only shortcut this action is answerable for is its own. The
     shortcut assigned meanwhile therefore sits on a pin the walk never
     touches — which is the only fixture that can tell a live-first merge from
     a whole-map replace. */
  const removed = before.find((v) => v.id === "uv-k2")!;
  assert.equal(before[before.length - 1].id, "uv-k2", "the removed pin must be the last one");
  const order = await vaultSidebarOrder();
  const beforeKeys = { ...(order.keys ?? {}), "6": "sv:uv-k2" };
  await vaultSetSidebarOrder({ ...order, keys: beforeKeys });

  const { box, record } = recorder();
  await savedViewDeleteUndoable({
    removed,
    before,
    beforeKeys,
    record,
    apply,
    adopt: noAdopt,
  });

  // somebody assigns a shortcut of their own while the delete is undoable
  const mid = await vaultSidebarOrder();
  await vaultSetSidebarOrder({ ...mid, keys: { ...(mid.keys ?? {}), "7": "sv:uv-k1" } });

  await box.entry!.undo();
  const keys = (await vaultSidebarOrder()).keys ?? {};
  assert.equal(keys["6"], "sv:uv-k2", "the deleted pin answers to its key again");
  assert.equal(keys["7"], "sv:uv-k1", "the shortcut assigned meanwhile survived the restore");
});

test("a sidebar reorder undoes to the whole prior order", async () => {
  const before = await vaultSidebarOrder();
  const next = { ...before, folders: ["Field", "Inbox"], collapsed: ["savedviews"] };
  const { box, record } = recorder();
  await setSidebarOrderUndoable({ before, next, record, apply, adopt: noAdopt, label: "Reorder" });
  assert.deepEqual((await vaultSidebarOrder()).folders, ["Field", "Inbox"]);
  assert.equal(box.entry!.label, "Reorder");
  await box.entry!.undo();
  assert.ok(sameConfig(await vaultSidebarOrder(), before));
  await box.entry!.redo!();
  assert.deepEqual((await vaultSidebarOrder()).collapsed, ["savedviews"]);
});

test("a folder icon undoes to the prior icon, and to no icon when there wasn't one", async () => {
  const path = "Inbox";
  const first = recorder();
  await setFolderIconUndoable({
    path,
    icon: { emoji: "🜂" },
    before: null,
    record: first.record,
    apply,
    adopt: noAdopt,
  });
  assert.equal((await vaultFolderMetaRead())[path]?.icon?.emoji, "🜂");

  const stored = (await vaultFolderMetaRead())[path]!.icon!;
  const second = recorder();
  await setFolderIconUndoable({
    path,
    icon: { emoji: "🝳" },
    before: stored,
    record: second.record,
    apply,
    adopt: noAdopt,
  });
  await second.box.entry!.undo();
  assert.equal((await vaultFolderMetaRead())[path]?.icon?.emoji, "🜂");

  await first.box.entry!.undo();
  assert.equal((await vaultFolderMetaRead())[path]?.icon ?? null, null, "back to no icon at all");
});

test("a folder icon undo refuses once the icon moved underneath it", async () => {
  const path = "Field";
  const { box, record } = recorder();
  await setFolderIconUndoable({
    path,
    icon: { emoji: "🜁" },
    before: null,
    record,
    apply,
    adopt: noAdopt,
  });
  await setFolderIconUndoable({
    path,
    icon: { emoji: "🜃" },
    before: { emoji: "🜁" },
    record: () => undefined,
    apply,
    adopt: noAdopt,
  });
  await assert.rejects(box.entry!.undo(), /conflict:/);
  assert.equal((await vaultFolderMetaRead())[path]?.icon?.emoji, "🜃");
});

test("the guard compares by value, not by key order", () => {
  assert.ok(sameConfig({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }));
  assert.ok(sameConfig({ a: 1, b: undefined }, { a: 1 }));
  assert.equal(sameConfig({ a: 1 }, { a: 2 }), false);
  assert.equal(sameConfig(null, { a: 1 }), false);
});

test("an inverse takes its turn in the caller's queue instead of writing straight through", async () => {
  const db = "undoviews-queue";
  /* The passthrough `apply` above proves nothing about ordering, and ordering
     is the whole reason these helpers take an `apply` at all: views.json has
     one writer, and an inverse that went round it could land between another
     write's read and its write and lose a key. So: a real one-at-a-time queue,
     an occupant that will not finish until told, and an inverse issued while
     it is still in flight. */
  const order: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const queued = <T,>(write: () => Promise<T>, adopt: (value: T) => void): Promise<T> => {
    const turn = chain.then(async () => {
      const value = await write();
      adopt(value);
      return value;
    });
    chain = turn.catch(() => undefined);
    return turn;
  };

  await vaultViewsSet(db, "table");
  const before = (await vaultViewsRead())[db];
  const { box, record } = recorder();
  await setDbPrefUndoable({
    db,
    pref: pref({ view: "board" }),
    before,
    record,
    apply: queued,
    adopt: noAdopt,
  });

  // a real pause, so an inverse that skipped the queue would finish first and
  // the assert below would catch it
  const gate = new Promise<void>((r) => setTimeout(r, 20));
  chain = chain.then(async () => {
    order.push("held write started");
    await gate;
    order.push("held write done");
  });
  await box.entry!.undo().then(() => order.push("undo ran"));

  assert.deepEqual(order, ["held write started", "held write done", "undo ran"]);
  assert.ok(sameConfig((await vaultViewsRead())[db], before), "the prior pref came back whole");
});
