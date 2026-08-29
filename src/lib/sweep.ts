/** Toast text for the bulk database sweeps. The outcome is built
    first and is ALWAYS reported; a missing safety snapshot is appended to it,
    never substituted for it — the user must learn what the sweep actually did
    even, and especially, when something else went wrong. Pure, node-testable. */

import { errText } from "./errtext.ts";

/** The count half of a `BulkSweep` plus the error of a sweep that stopped
    partway. Structurally a `BulkSweep`, declared locally so this
    module stays free of the IPC types. */
export interface SweepResult {
  notes: number;
  skipped?: number;
  failed?: string | null;
}

function notes(n: number): string {
  return n === 1 ? "note" : "notes";
}

/** A sweep that stopped partway rewrote some notes and then gave up, so the
    headline it was aiming for never happened: the engine skips its schema /
    views / template bookkeeping on the failing note, which means the database
    keeps its name and the property keeps its own. Reporting "Renamed to X"
    with an error tacked on would name a change the vault never made — so the
    partial message states the notes that DID change and what did not. */
function partial(changed: string, unchanged: string, failed: string): string {
  return `${changed}, then failed — ${unchanged}: ${failed}`;
}

export function renameDbOutcome(dbType: string, newName: string, sweep: SweepResult): string {
  const n = sweep.notes;
  return sweep.failed
    ? partial(
        `Retyped ${n} ${notes(n)}`,
        `the database is still “${dbType}”`,
        sweep.failed
      )
    : `Renamed to “${newName}” — ${n} ${notes(n)} updated`;
}

/** Trashing the notes and keeping them are materially different outcomes —
    they must stay distinguishable however the sweep otherwise went. */
export function deleteDbOutcome(
  dbType: string,
  trashNotes: boolean,
  sweep: SweepResult
): string {
  const n = sweep.notes;
  if (sweep.failed) {
    return partial(
      trashNotes ? `Moved ${n} ${notes(n)} to Trash` : `Untyped ${n} ${notes(n)}`,
      `“${dbType}” was not removed`,
      sweep.failed
    );
  }
  return trashNotes
    ? `Moved ${n} ${notes(n)} to Trash`
    : `Database removed — ${n} ${notes(n)} kept`;
}

export function renamePropOutcome(
  prop: string,
  newName: string,
  sweep: SweepResult
): string {
  const n = sweep.notes;
  const skipped = sweep.skipped ?? 0;
  if (sweep.failed) {
    return partial(
      `Renamed in ${n} ${notes(n)}`,
      `the property is still “${prop}”`,
      sweep.failed
    );
  }
  return (
    `Renamed in ${n} ${notes(n)}` +
    (skipped > 0 ? ` — ${skipped} skipped (kept existing “${newName}”)` : "")
  );
}

/** The strip has no bookkeeping left to lose — the schema entry went with the
    earlier demote — so its partial message is just the count and the error. */
export function stripPropOutcome(prop: string, sweep: SweepResult): string {
  const n = sweep.notes;
  const done = `Deleted “${prop}” values from ${n} ${notes(n)}`;
  return sweep.failed ? `${done}, then failed: ${sweep.failed}` : done;
}

/** Result of the non-destructive half of property removal: the schema entry
    is already gone, and this second call only cleans saved metadata. A views
    write failure therefore must not masquerade as a completed removal or
    trigger a config reload that obscures which half landed. */
export function schemaOnlyClearOutcome(
  prop: string,
  sweep: SweepResult
): { completed: boolean; message: string } {
  return sweep.failed
    ? {
        completed: false,
        message: `Couldn't clean saved views after “${prop}” was removed from the schema: ${sweep.failed}`,
      }
    : { completed: true, message: `Property “${prop}” removed` };
}

/** `snapped` false means no restore point exists for this vault (history is
    off — a foreign repo), so the sweep just ran unprotected. Say so alongside
    the outcome; the sweep is never blocked on it. */
export function withSnapshotWarning(outcome: string, snapped: boolean): string {
  return snapped ? outcome : `${outcome}; no safety snapshot taken`;
}

/** The sweep's parachute, and the two ways it can be missing.
 *
 *  `history_snapshot` resolves false for exactly one reason: this vault has
 *  no history to snapshot into (a foreign folder, git off). That is a known
 *  state the sweep proceeds through, saying so in its outcome.
 *
 *  A REJECTION is the other thing entirely — history exists and the commit
 *  failed — and it used to be caught and reported as the first, so a sweep
 *  that could rewrite hundreds of notes ran believing it had a restore point
 *  it did not have. It stops the sweep now: nothing is written, and the
 *  message says both what went wrong and that nothing changed, because "the
 *  snapshot failed" alone leaves a reader unsure which half of the operation
 *  they are looking at. */
export function presweep(
  snapshot: (label: string) => Promise<boolean>,
  label: string
): Promise<boolean> {
  return snapshot(label).catch((e) => {
    throw new Error(
      `Couldn't take the safety snapshot ${label} — nothing was changed: ${errText(e)}`
    );
  });
}

export const SNAPSHOT_RESTORE_LABEL = "Restore from snapshot";

/** The way back out of a sweep that did land. The snapshot is a vault history
    point, so the door is the vault's own time travel — the sweep's label is
    the newest entry in that list. Offered only when a snapshot was actually
    taken; a toast that offers a restore there is none of is worse than
    silence. */
export function snapshotRestore(
  snapped: boolean,
  openRestore: () => void
): { label: string; run: () => void } | undefined {
  return snapped ? { label: SNAPSHOT_RESTORE_LABEL, run: openRestore } : undefined;
}
