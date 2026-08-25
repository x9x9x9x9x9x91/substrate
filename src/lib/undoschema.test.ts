import { test } from "node:test";
import assert from "node:assert/strict";
import type { PropKind, SelectOption } from "./types.ts";
import type { UndoEntry } from "./undo.ts";
import type { OptionState } from "./undoschema.ts";

/* "Add “x” to options" writes twice — the option into schema.json, the value
   into the note — and the two used to be independent: a refused option still
   let the value land as an unschema'd extra, and one ⌘Z took the value back
   while the option stayed. These run against the mock backend, which lives
   behind `isTauri` and sniffs `window` at module scope, so shim one before
   importing (same trick as undoprops.test.ts) and import dynamically. */
(globalThis as { window?: unknown }).window = globalThis;
const { vaultCreate, vaultRead, vaultSchemaRead, vaultSchemaSet, vaultSetProp } = await import(
  "./ipc.ts"
);
const { setPropUndoable } = await import("./undoprops.ts");
const { addOptionAndWriteUndoable, sameOptions } = await import("./undoschema.ts");

type Pending = Omit<UndoEntry, "id"> & { id?: number };

function recorder(): { entries: Pending[]; record: (e: Pending) => void } {
  const entries: Pending[] = [];
  return { entries, record: (e) => entries.push(e) };
}

/** The option list the vault currently holds for a property. */
async function storedOptions(db: string, prop: string): Promise<string[]> {
  const schema = await vaultSchemaRead();
  return (schema[db]?.[prop]?.options ?? []).map((o) => o.value);
}

/** An option store over the real schema commands, for one database property.
    `kinds` is what the property rides under on each side — a promote on an
    explicitly-kinded column stores its options kindless and puts the kind back
    on the way out. */
function store(
  db: string,
  prop: string,
  before: SelectOption[],
  added: string,
  kinds: { before: PropKind | null; after: PropKind | null } = { before: null, after: null }
) {
  return {
    before: { options: before, kind: kinds.before },
    after: { options: [...before, { value: added }], kind: kinds.after },
    write: (state: OptionState) =>
      vaultSchemaSet(db, prop, state.options, state.kind ?? undefined).then(() => undefined),
    read: async () => (await vaultSchemaRead())[db]?.[prop]?.options ?? [],
  };
}

test("one undo step takes back both the new option and the value it went into", async () => {
  const db = "atomicpromote";
  const before: SelectOption[] = [{ value: "Draft" }];
  await vaultSchemaSet(db, "stage", before);
  const note = await vaultCreate("Promote Target", db, undefined, undefined, "body\n");
  await vaultSetProp(note.path, "stage", "Draft");
  const rec = recorder();

  await addOptionAndWriteUndoable({
    store: store(db, "stage", before, "Shipped"),
    writeValue: (record) =>
      setPropUndoable({ path: note.path, key: "stage", value: "Shipped", record }).then(
        () => undefined
      ),
    record: rec.record,
  });

  assert.deepEqual(await storedOptions(db, "stage"), ["Draft", "Shipped"]);
  assert.equal((await vaultRead(note.path)).props["stage"], "Shipped");
  assert.equal(rec.entries.length, 1, "the pair records exactly ONE undo entry");
  assert.deepEqual(rec.entries[0].paths, [note.path]);

  await rec.entries[0].undo();
  assert.equal(
    (await vaultRead(note.path)).props["stage"],
    "Draft",
    "the single undo puts the value back"
  );
  assert.deepEqual(
    await storedOptions(db, "stage"),
    ["Draft"],
    "and takes the option it created back out of the schema"
  );

  await rec.entries[0].redo?.();
  assert.deepEqual(await storedOptions(db, "stage"), ["Draft", "Shipped"]);
  assert.equal((await vaultRead(note.path)).props["stage"], "Shipped");
});

test("a refused option write never lets the value land", async () => {
  const db = "atomicrefuse";
  const before: SelectOption[] = [{ value: "Draft" }];
  await vaultSchemaSet(db, "stage", before);
  const note = await vaultCreate("Refused Option", db, undefined, undefined, "body\n");
  const rec = recorder();
  let valueRan = false;

  await assert.rejects(
    addOptionAndWriteUndoable({
      store: {
        before: { options: before, kind: null },
        after: { options: [...before, { value: "Shipped" }], kind: null },
        write: () => Promise.reject(new Error("schema refused")),
        read: async () => (await vaultSchemaRead())[db]?.["stage"]?.options ?? [],
      },
      writeValue: (record) => {
        valueRan = true;
        return setPropUndoable({
          path: note.path,
          key: "stage",
          value: "Shipped",
          record,
        }).then(() => undefined);
      },
      record: rec.record,
    }),
    /schema refused/
  );

  assert.equal(valueRan, false, "the value write never runs after a refused option");
  assert.equal(
    (await vaultRead(note.path)).props["stage"],
    undefined,
    "so nothing landed on the note"
  );
  assert.deepEqual(await storedOptions(db, "stage"), ["Draft"], "and the schema is untouched");
  assert.equal(rec.entries.length, 0, "nothing to take back, so nothing is recorded");
});

test("a refused value write takes the option back out with it", async () => {
  const db = "atomicvaluefail";
  const before: SelectOption[] = [{ value: "Draft" }];
  await vaultSchemaSet(db, "stage", before);
  const rec = recorder();

  await assert.rejects(
    addOptionAndWriteUndoable({
      store: store(db, "stage", before, "Shipped"),
      writeValue: () => Promise.reject(new Error("note vanished")),
      record: rec.record,
    }),
    /note vanished/
  );

  assert.deepEqual(
    await storedOptions(db, "stage"),
    ["Draft"],
    "the schema never keeps an option whose value could not land"
  );
  assert.equal(rec.entries.length, 0);
});

test("a value write that lands on nothing rolls the option back and records nothing", async () => {
  // the bulk shape: every note in the selection refused, so the helper
  // reports failures rather than throwing and hands back no inverse
  const db = "atomicbulkfail";
  const before: SelectOption[] = [{ value: "Draft" }];
  await vaultSchemaSet(db, "stage", before);
  const rec = recorder();

  await addOptionAndWriteUndoable({
    store: store(db, "stage", before, "Shipped"),
    writeValue: () => Promise.resolve(),
    record: rec.record,
  });

  assert.deepEqual(await storedOptions(db, "stage"), ["Draft"]);
  assert.equal(rec.entries.length, 0);
});

test("undo leaves the options alone when the schema moved since", async () => {
  const db = "atomicguard";
  const before: SelectOption[] = [{ value: "Draft" }];
  await vaultSchemaSet(db, "stage", before);
  const note = await vaultCreate("Guarded Promote", db, undefined, undefined, "body\n");
  const rec = recorder();

  await addOptionAndWriteUndoable({
    store: store(db, "stage", before, "Shipped"),
    writeValue: (record) =>
      setPropUndoable({ path: note.path, key: "stage", value: "Shipped", record }).then(
        () => undefined
      ),
    record: rec.record,
  });

  // someone edits the column's options after the promote
  await vaultSchemaSet(db, "stage", [{ value: "Draft" }, { value: "Shipped" }, { value: "Held" }]);

  await rec.entries[0].undo();
  assert.equal(
    (await vaultRead(note.path)).props["stage"],
    undefined,
    "the value still comes back"
  );
  assert.deepEqual(
    await storedOptions(db, "stage"),
    ["Draft", "Shipped", "Held"],
    "but the later edit owns the option list now — undo does not drop what it added"
  );
});

test("undo restores the kind of a column that had no options at all", async () => {
  // the plain "turn this column into a select" gesture: the property carries
  // an explicit kind and an empty option list, so putting the options back
  // WITHOUT the kind would leave it empty and kindless — which is the vault's
  // signal to drop the property, and the database entry with it
  const db = "atomickindless";
  await vaultSchemaSet(db, "count", [], "number");
  const note = await vaultCreate("Kindless Promote", db, undefined, undefined, "body\n");
  const rec = recorder();

  await addOptionAndWriteUndoable({
    store: store(db, "count", [], "many", { before: "number", after: null }),
    writeValue: (record) =>
      setPropUndoable({ path: note.path, key: "count", value: "many", record }).then(
        () => undefined
      ),
    record: rec.record,
  });

  assert.deepEqual(await storedOptions(db, "count"), ["many"]);
  assert.equal(
    (await vaultSchemaRead())[db]?.["count"]?.kind,
    undefined,
    "the promote turns the column into a plain select"
  );

  await rec.entries[0].undo();
  const back = (await vaultSchemaRead())[db]?.["count"];
  assert.ok(back, "undo leaves the column standing rather than deleting it");
  assert.equal(back.kind, "number", "and hands it back the kind it had");
  assert.deepEqual(back.options ?? [], [], "with the empty option list it had");
  assert.equal((await vaultRead(note.path)).props["count"], undefined);
});

test("a value write that records and then throws keeps both what landed and the report", async () => {
  // the partial-bulk shape: some notes took the value, others refused. What
  // landed has an inverse, so the entry is recorded — and the caller still
  // gets the failure to put in front of the user.
  const db = "atomicpartial";
  const before: SelectOption[] = [{ value: "Draft" }];
  await vaultSchemaSet(db, "stage", before);
  const note = await vaultCreate("Partly Landed", db, undefined, undefined, "body\n");
  const rec = recorder();

  await assert.rejects(
    addOptionAndWriteUndoable({
      store: store(db, "stage", before, "Shipped"),
      writeValue: async (record) => {
        await setPropUndoable({ path: note.path, key: "stage", value: "Shipped", record });
        throw new Error("2 notes refused");
      },
      record: rec.record,
    }),
    /2 notes refused/
  );

  assert.deepEqual(
    await storedOptions(db, "stage"),
    ["Draft", "Shipped"],
    "the option stays: a value did land in it"
  );
  assert.equal(rec.entries.length, 1, "and what landed is takeable back");

  await rec.entries[0].undo();
  assert.deepEqual(await storedOptions(db, "stage"), ["Draft"]);
  assert.equal((await vaultRead(note.path)).props["stage"], undefined);
});

test("a rollback the vault refuses is reported rather than swallowed", async () => {
  // nothing landed and nothing threw (every note refused), so the rollback is
  // the only thing that can go wrong — silence here would leave an orphan
  // option standing with no entry to take it back
  const db = "atomicrollbackfail";
  const before: SelectOption[] = [{ value: "Draft" }];
  const rec = recorder();
  let wrote = 0;

  await assert.rejects(
    addOptionAndWriteUndoable({
      store: {
        before: { options: before, kind: null },
        after: { options: [...before, { value: "Shipped" }], kind: null },
        write: () => (++wrote === 1 ? Promise.resolve() : Promise.reject(new Error("disk full"))),
        read: async () => (await vaultSchemaRead())[db]?.["stage"]?.options ?? [],
      },
      writeValue: () => Promise.resolve(),
      record: rec.record,
    }),
    /disk full/
  );

  assert.equal(wrote, 2, "the rollback was attempted");
  assert.equal(rec.entries.length, 0, "and still nothing is recorded");
});

test("a rollback failure never hides why the value could not land", async () => {
  const db = "atomicbothfail";
  const before: SelectOption[] = [{ value: "Draft" }];
  const rec = recorder();
  let wrote = 0;

  await assert.rejects(
    addOptionAndWriteUndoable({
      store: {
        before: { options: before, kind: null },
        after: { options: [...before, { value: "Shipped" }], kind: null },
        write: () => (++wrote === 1 ? Promise.resolve() : Promise.reject(new Error("disk full"))),
        read: async () => (await vaultSchemaRead())[db]?.["stage"]?.options ?? [],
      },
      writeValue: () => Promise.reject(new Error("note is sealed")),
      record: rec.record,
    }),
    /note is sealed/
  );

  assert.equal(rec.entries.length, 0);
});

test("sameOptions compares values, order and colors", () => {
  assert.equal(sameOptions([{ value: "a" }], [{ value: "a" }]), true);
  assert.equal(sameOptions([{ value: "a" }], [{ value: "a", color: "red" }]), false);
  assert.equal(
    sameOptions([{ value: "a" }, { value: "b" }], [{ value: "b" }, { value: "a" }]),
    false
  );
  assert.equal(sameOptions([{ value: "a" }], [{ value: "a" }, { value: "b" }]), false);
});
