/** The seal/lock/unseal + calendar-opt-out handlers every surface shares.
 *
 *  These used to exist only on the open note's ⋯ menu. Now the row menu and
 *  the palette render them too, from the one descriptor set in
 *  `noteactions.ts` — so the handlers live here rather than inside App, where
 *  nothing could execute them. What is worth pinning is the ORDERING: the
 *  pane's own versions of these verbs flush the pending save before they let
 *  the engine change the note's authorization, and a cross-surface door that
 *  skips that step parks the last seconds of typing behind an unlock.
 *
 *  Everything the ordering depends on is injected, so a test can hold the
 *  flush open and watch what does — and does not — happen meanwhile. */

import { entriesForNote } from "./calendar.ts";
import type { NoteActionHandlers } from "./noteactions.ts";
import { foldedPropKey } from "./types.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

/** The subset of the handler set these doors own. */
export type NoteExtras = Pick<
  NoteActionHandlers,
  "seal" | "lockNow" | "unseal" | "toggleCalendar" | "calendarHidden"
>;

export interface NoteExtrasDeps {
  /** Paths this session still holds an unlock authorization for. */
  unlockedSealed: string[];
  schema: SchemaConfig;
  /** Run the action only once the open pane's pending save has landed
      (App's `afterOpenFlush`; a no-op with no pane open). */
  afterFlush: <T>(fn: () => T | Promise<T>) => Promise<T>;
  /** Open the seal/unlock/unseal dialog. */
  openSealDialog: (d: { note: NoteMeta; mode: "seal" | "unlock" | "unseal"; then?: "unseal" }) => void;
  /** Release every hold this session took for the note (`relockSealed`). */
  relock: (path: string) => void;
  setCalendarHidden: (n: NoteMeta, hidden: boolean) => void;
}

export function buildNoteExtras(n: NoteMeta, deps: NoteExtrasDeps): NoteExtras {
  const unlocked = deps.unlockedSealed.includes(n.path);
  const calValue = n.props[foldedPropKey(n.props, "calendar")];
  const calHidden = calValue === false || calValue === "false";
  // same gate as the pane's: offer the verb only where it changes
  // something — a note with no dates never shows on the calendar anyway
  const calToggleable = calHidden || entriesForNote(n, deps.schema).length > 0;
  return {
    // Every verb that changes the note's authorization flushes first, the way
    // the pane's own seal/lock do: sealing encrypts what is on disk, and
    // locking drops the identity the pending write needs, so an edit still
    // inside the save debounce would land in the sealed-locked recovery
    // instead of in the file. The e2e mock's write path has no such gate,
    // which is why the ordering is pinned by `noteextras.test.ts` instead.
    seal: n.sealed ? undefined : () => void deps.afterFlush(() => deps.openSealDialog({ note: n, mode: "seal" })),
    // only when this session actually holds the authorization: locking
    // what we never unlocked would drop some other holder's identity
    lockNow: n.sealed && unlocked ? () => void deps.afterFlush(() => deps.relock(n.path)) : undefined,
    unseal: n.sealed
      ? () =>
          void deps.afterFlush(() =>
            deps.openSealDialog(
              unlocked ? { note: n, mode: "unseal" } : { note: n, mode: "unlock", then: "unseal" }
            )
          )
      : undefined,
    toggleCalendar: calToggleable ? () => deps.setCalendarHidden(n, !calHidden) : undefined,
    calendarHidden: calHidden,
  };
}
