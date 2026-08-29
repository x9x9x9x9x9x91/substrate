/* Frontmatter-block rewrites become undoable (docs/undo.md §6.8).

   `vault_fm_write` replaces a note's whole frontmatter block at once — the
   repair dialog's hand-edit, the workbook's page append. Neither goes through
   the prop writers, so neither leaves anything on the stack; a repair that
   dropped a key the user still wanted had nothing to take it back.

   Two details shape the inverse:

   - The prior block is captured WHOLE, because that is the granularity the
     command works at. There is no "put this one key back".
   - `null` is a real prior state, not a missing one: a note with no
     frontmatter at all is not the same as a note with an empty block, and
     writing an empty string is how the vault is told to remove the block.
     Undoing an append onto a note that had none must land back on none. */

import { vaultFmRaw, vaultFmWrite } from "./ipc.ts";
import type { FmState, NoteMeta } from "./types.ts";
import type { UndoScope } from "./undo.ts";
import type { UndoRecorder } from "./undoprops.ts";

/** Write a note's frontmatter block and record putting the prior one back.

    `before` is the block as it stood, `null` when the note carried none.
    Resolves to the written meta exactly as `vaultFmWrite` did, so call sites
    keep their `.then` shape — and rejects the same way, since a block the
    engine refuses never lands and so has nothing to take back. */
export async function fmWriteUndoable(
  opts: {
    path: string;
    fm: string;
    before: FmState | null;
    record: UndoRecorder;
    /** pre-minted (undo.nextUndoId()) when a toast's Undo button must run the
        very entry ⌘Z would run */
    id?: number;
    label?: string;
    scope?: UndoScope;
    /** the caller's catch-up after an inverse lands — the pane that owns this
        note re-reads its props and health */
    onApplied?: (meta: NoteMeta) => void;
  }
): Promise<NoteMeta> {
  const { path, fm, before, record, onApplied } = opts;
  // the block as text, taken now: the entry outlives every object either
  // side of this call, and `null` has to stay distinguishable from ""
  const prior = before?.raw ?? null;
  const meta = await vaultFmWrite(path, fm);
  /* The stored block, not the string we sent: the engine reformats what it
     parses, and the guard has to compare against what a later reader sees.

     A readback that FAILED is not a note without frontmatter, and the two
     were treated alike here. Recording `null` as the landed block arms an
     inverse whose guard compares against a block that was never absent: it
     refuses forever, and its redo would write the note's real frontmatter
     away. A write with no entry behind it is the smaller loss, so the entry
     is skipped and the reason said out loud. */
  let landed: string | null;
  try {
    landed = (await vaultFmRaw(path))?.raw ?? null;
  } catch (e) {
    console.warn(`undo: no entry for the frontmatter write on ${path} — reading it back failed`, e);
    return meta;
  }
  if (prior === landed) return meta;
  const write = (want: string | null, expected: string | null) => async () => {
    const cur = await vaultFmRaw(path);
    if ((cur?.raw ?? null) !== expected)
      throw new Error("conflict: the frontmatter changed since");
    // an empty block is how the vault is told to remove the block entirely,
    // which is exactly the state `null` stands for. The write stands on its
    // own line because `onApplied?.(await …)` skips its own argument when
    // there is no callback — the inverse would quietly do nothing.
    const written = await vaultFmWrite(path, want ?? "");
    onApplied?.(written);
  };
  record({
    id: opts.id,
    label: opts.label ?? "Edit frontmatter",
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [path],
    undo: write(prior, landed),
    redo: write(landed, prior),
  });
  return meta;
}
