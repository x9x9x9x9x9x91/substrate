import { test } from "node:test";
import assert from "node:assert/strict";

/* The database-definition undo helpers against the mock backend. Same shim as
   undostruct.test.ts: `isTauri` sniffs `window` at module scope, so node has
   to look like a browser before the first app import. */
(globalThis as { window?: unknown }).window = globalThis;
const {
  propIn,
  recordCreateTypeUndo,
  recordSchemaHomeUndo,
  recordSchemaIconUndo,
  recordSchemaPropUndo,
  schemaSetFromProp,
} = await import("./undodb.ts");
const { vaultSchemaHomeSet, vaultSchemaRead, vaultSchemaSet, vaultSchemaSetIcon, vaultCreateType } =
  await import("./ipc.ts");
const { typeIcon } = await import("./dbicons.ts");
const { typeSchemaFor } = await import("./schemalookup.ts");
const { typeHome } = await import("./types.ts");

type Entry = Omit<import("./undo.ts").UndoEntry, "id"> & { id?: number };

/** the recorder every test uses: keep the last entry, assert on it */
function recorder() {
  const box: { entry: Entry | null } = { entry: null };
  return { box, record: (e: Entry) => (box.entry = e) };
}

const noAdopt = () => undefined;
const stored = async (db: string, prop: string) => propIn(await vaultSchemaRead(), db, prop);

test("editing a property's kind undoes to the whole prior definition", async () => {
  const db = "undodb-kind";
  await vaultSchemaSet(db, "stage", [{ value: "draft" }, { value: "done" }]);
  const before = await stored(db, "stage");
  const cfg = await vaultSchemaSet(db, "stage", [], "date");
  const { box, record } = recorder();
  recordSchemaPropUndo({ db, prop: "stage", before, cfg, record, adopt: noAdopt });
  assert.equal((await stored(db, "stage"))!.kind, "date");

  await box.entry!.undo();
  const back = await stored(db, "stage");
  assert.equal(back!.kind, undefined, "back to the kindless select it was");
  assert.deepEqual(
    back!.options.map((o) => o.value),
    ["draft", "done"],
    "with its option list, which the date kind had emptied"
  );

  await box.entry!.redo!();
  assert.equal((await stored(db, "stage"))!.kind, "date");
});

test("undoing a date alert clears it rather than leaving it standing", async () => {
  const db = "undodb-notify";
  await vaultSchemaSet(db, "due", [], "date");
  const before = await stored(db, "due");
  assert.equal(before!.notify ?? false, false);
  assert.equal(before!.notifyBefore ?? 0, 0);

  const cfg = await vaultSchemaSet(db, "due", [], "date", true, 3);
  const { box, record } = recorder();
  recordSchemaPropUndo({ db, prop: "due", before, cfg, record, adopt: noAdopt });
  assert.equal((await stored(db, "due"))!.notify, true);

  await box.entry!.undo();
  // vault_schema_set keeps the stored alert when the argument is omitted, so
  // an inverse that didn't spell out `false`/`0` would leave both switched on
  const back = await stored(db, "due");
  assert.equal(back!.notify ?? false, false, "the alert is off again");
  assert.equal(back!.notifyBefore ?? 0, 0, "and so is the lead time");
});

test("undoing a review window clears it, not just leaves the old text", async () => {
  const db = "undodb-review";
  await vaultSchemaSet(db, "source", [], "text");
  const before = await stored(db, "source");
  const cfg = await vaultSchemaSet(db, "source", [], "text", undefined, undefined, undefined, undefined, undefined, "90d");
  const { box, record } = recorder();
  recordSchemaPropUndo({ db, prop: "source", before, cfg, record, adopt: noAdopt });
  assert.equal((await stored(db, "source"))!.review, "90d");
  await box.entry!.undo();
  assert.equal((await stored(db, "source"))!.review, undefined);
});

test("adding a property undoes to no property at all", async () => {
  const db = "undodb-add";
  await vaultSchemaSet(db, "keep", [], "text");
  const cfg = await vaultSchemaSet(db, "fresh", [], "number");
  const { box, record } = recorder();
  recordSchemaPropUndo({ db, prop: "fresh", before: null, cfg, record, adopt: noAdopt });
  await box.entry!.undo();
  assert.equal(await stored(db, "fresh"), null, "the property is gone");
  assert.ok(await stored(db, "keep"), "the rest of the database stands");
  await box.entry!.redo!();
  assert.equal((await stored(db, "fresh"))!.kind, "number");
});

test("a property undo refuses once someone else edited that property", async () => {
  const db = "undodb-conflict";
  await vaultSchemaSet(db, "stage", [], "text");
  const before = await stored(db, "stage");
  const cfg = await vaultSchemaSet(db, "stage", [], "number");
  const { box, record } = recorder();
  recordSchemaPropUndo({ db, prop: "stage", before, cfg, record, adopt: noAdopt });
  await vaultSchemaSet(db, "stage", [], "date");
  await assert.rejects(box.entry!.undo(), /conflict:/);
  assert.equal((await stored(db, "stage"))!.kind, "date", "the other edit stands");
});

test("a database icon undoes to the prior icon and to none", async () => {
  const db = "undodb-icon";
  await vaultSchemaSet(db, "title", [], "text");
  const first = recorder();
  recordSchemaIconUndo({
    db,
    before: null,
    cfg: await vaultSchemaSetIcon(db, { emoji: "🜂" }),
    record: first.record,
    adopt: noAdopt,
  });
  const iconNow = async () => typeIcon(typeSchemaFor(await vaultSchemaRead(), db)) ?? null;
  assert.equal((await iconNow())?.emoji, "🜂");

  const second = recorder();
  recordSchemaIconUndo({
    db,
    before: await iconNow(),
    cfg: await vaultSchemaSetIcon(db, { emoji: "🝳" }),
    record: second.record,
    adopt: noAdopt,
  });
  await second.box.entry!.undo();
  assert.equal((await iconNow())?.emoji, "🜂");
  await first.box.entry!.undo();
  assert.equal(await iconNow(), null);
});

test("a home folder undoes back to homeless", async () => {
  const db = "undodb-home";
  await vaultSchemaSet(db, "title", [], "text");
  const { box, record } = recorder();
  recordSchemaHomeUndo({
    db,
    before: null,
    cfg: await vaultSchemaHomeSet(db, "Inbox"),
    record,
    adopt: noAdopt,
  });
  const homeNow = async () => typeHome(typeSchemaFor(await vaultSchemaRead(), db)) ?? null;
  assert.equal(await homeNow(), "Inbox");
  await box.entry!.undo();
  assert.equal(await homeNow(), null);
  await box.entry!.redo!();
  assert.equal(await homeNow(), "Inbox");
});

test("creating a database undoes to no database, and refuses once it has notes", async () => {
  const db = "undodb-created";
  const props = [{ name: "stage", kind: "select" as const, options: [{ value: "draft" }] }];
  const cfg = await vaultCreateType(db, props);
  const { box, record } = recorder();
  let notes = 0;
  recordCreateTypeUndo({
    db,
    props,
    home: null,
    cfg,
    countNotes: async () => notes,
    record,
    adopt: noAdopt,
  });
  assert.ok(typeSchemaFor(await vaultSchemaRead(), db));

  notes = 2;
  await assert.rejects(box.entry!.undo(), /has 2 notes now/);
  assert.ok(typeSchemaFor(await vaultSchemaRead(), db), "the definition its rows rely on stands");

  notes = 0;
  await box.entry!.undo();
  assert.equal(typeSchemaFor(await vaultSchemaRead(), db), undefined, "the database is gone");
  await box.entry!.redo!();
  assert.ok(typeSchemaFor(await vaultSchemaRead(), db));
});

test("creating a database refuses to undo once a property was added to it", async () => {
  const db = "undodb-grown";
  const props = [{ name: "stage", kind: "select" as const, options: [{ value: "draft" }] }];
  const cfg = await vaultCreateType(db, props);
  const { box, record } = recorder();
  recordCreateTypeUndo({
    db,
    props,
    home: null,
    cfg,
    countNotes: async () => 0,
    record,
    adopt: noAdopt,
  });

  // a property the create never declared — added by hand, or by a later edit
  await vaultSchemaSet(db, "owner", [], "text");

  // taking the create back would either delete a property that isn't this
  // entry's, or leave a half database standing and call it an undo
  await assert.rejects(box.entry!.undo(), /conflict:/);
  assert.ok(await stored(db, "owner"), "the property added since is untouched");
  assert.ok(await stored(db, "stage"), "and so is the one the create declared");
});

test("the whole-property write removes a property when handed no definition", async () => {
  const db = "undodb-writer";
  await vaultSchemaSet(db, "keep", [], "text");
  await vaultSchemaSet(db, "gone", [], "text");
  await schemaSetFromProp(db, "gone", null);
  assert.equal(await stored(db, "gone"), null);
  assert.ok(await stored(db, "keep"));
});
