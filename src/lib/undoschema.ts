/* "Add “x” to options" is ONE action, not two writes (docs/undo.md §6.2).

   Picking that row on a value picker stores an option in schema.json AND puts
   the value into the note. Fired independently, the pair came apart in both
   directions: a refused schema write still let the value land, where it
   rendered as an unschema'd extra, and when both landed one ⌘Z took the value
   back while the new option stayed in the schema forever.

   Here the two are sequenced — the option first, the value only once the
   option is stored — and their inverses are folded into a single undo entry,
   so one ⌘Z leaves neither half behind. A value the vault refuses takes the
   option back out with it, which is what makes the pair atomic as far as
   anything on disk can see. */

import type { PropKind, SelectOption } from "./types.ts";
import type { UndoEntry } from "./undo.ts";
import type { UndoRecorder } from "./undoprops.ts";

/** An entry as a recorder receives it — the id is minted on the way in. */
type PendingEntry = Omit<UndoEntry, "id"> & { id?: number };

/** Where a property's option list stands, and under which kind. The two travel
    together on purpose: an option list is only meaningful beside the kind that
    owns it, and putting a list back under the wrong kind is what turns a
    restore into a demotion — an empty list with no kind is the vault's signal
    to drop the property out of schema.json entirely. */
export type OptionState = {
  options: SelectOption[];
  /** null is the kindless select a bare option list defines (text when the
      list is empty); anything else is the property's explicit kind */
  kind: PropKind | null;
};

/** The option half: which state to put back, which state to store, and how to
    read what the property holds right now (the guard undo leans on). */
export type OptionStore = {
  /** where the property stood before this action */
  before: OptionState;
  /** where this action puts it */
  after: OptionState;
  write: (state: OptionState) => Promise<void>;
  read: () => Promise<SelectOption[]>;
};

/** Two option lists are the same list — same values in the same order, with
    the same colors. Undo compares against this rather than trusting that
    nothing touched the schema in between. */
// colors are part of the comparison, so this disarms undo's option half the
// day the vault starts coloring promoted options itself — a stored color the
// action never wrote reads here as "someone else edited the list"
export function sameOptions(a: SelectOption[], b: SelectOption[]): boolean {
  return (
    a.length === b.length &&
    a.every((o, i) => o.value === b[i].value && (o.color ?? null) === (b[i].color ?? null))
  );
}

/** Store one more option and write the value that goes into it, as a single
    takeable-back action.

    `writeValue` runs only after the option is stored, and is handed the
    recorder it should give its inverse to — that inverse is folded into this
    action's one entry instead of becoming a second ⌘Z step. A `writeValue`
    that records nothing (it threw, or every note refused the value) means
    nothing landed, so the option is taken back out and no entry is recorded
    at all: the vault ends exactly where it started. */
export async function addOptionAndWriteUndoable(opts: {
  store: OptionStore;
  writeValue: (record: UndoRecorder) => Promise<void>;
  record: UndoRecorder;
  /** pre-minted (undo.nextUndoId()) when the caller needs to reference the
      entry — a toast's Undo button pointing at exactly this action */
  id?: number;
}): Promise<void> {
  const { store, writeValue, record } = opts;
  // a refused option write throws straight out: the value never runs, so
  // there is nothing to take back and nothing half-written to explain
  await store.write(store.after);
  // a box, not a bare `let`: the assignment happens inside a callback, which
  // the compiler cannot follow, and reading through a property keeps the
  // captured entry's type instead of narrowing it away
  const captured: { entry: PendingEntry | null } = { entry: null };
  let failure: unknown = null;
  try {
    await writeValue((e) => {
      captured.entry = e;
    });
  } catch (e) {
    failure = e;
  }
  const value = captured.entry;
  if (!value) {
    // nothing landed — roll the option back out. The caller's report of why
    // the value didn't land is the better one, so a failing rollback only
    // speaks up when there is no such report: silence there would leave an
    // orphan option standing with no entry to take it back.
    let rollback: unknown = null;
    await store.write(store.before).catch((e) => {
      rollback = e;
    });
    if (failure) throw failure;
    if (rollback) throw rollback;
    return;
  }
  record({
    id: opts.id,
    label: value.label,
    scope: value.scope,
    at: value.at,
    paths: value.paths,
    undo: async () => {
      await value.undo();
      // the option leaves only while the property still holds exactly what
      // this action wrote — a schema edit since then owns the list now, and
      // taking it back would drop options the user added after this
      if (sameOptions(await store.read(), store.after.options)) await store.write(store.before);
    },
    redo: value.redo
      ? async () => {
          if (sameOptions(await store.read(), store.before.options)) await store.write(store.after);
          await value.redo?.();
        }
      : undefined,
  });
  // the value write partly failed but partly landed: the entry above covers
  // what landed, and the caller still gets to report the rest
  if (failure) throw failure;
}
