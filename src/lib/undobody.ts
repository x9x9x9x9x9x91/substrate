/* Actions whose implementation happens to be a body rewrite (docs/undo.md
   §3.4-3). Logging a meal is an action, not typing: the user picked a food and
   pressed Enter, and the note's csv fence grew a line as a consequence. So it
   belongs on the app stack beside a property edit, not in a private stack that
   empties the moment the pane is navigated away from.

   Typing inside the editor stays CodeMirror's, always — this is only for the
   panes that rewrite a note nobody is looking at.

   The entry is recorded AFTER the write lands. A stack mutated before the
   write resolved is the food board's long-standing bug: a refused write still
   consumed the undo step and left a redo pointing at a body that never
   existed. */

import type { UndoScope } from "./undo.ts";
import type { UndoRecorder } from "./undoprops.ts";

/** How a surface lands a guarded body write: the new body, and the body it
    believes is on disk. Rejects — with a `conflict:`-prefixed message — when
    the note moved under it, which is what makes the inverse safe to run
    minutes later. */
export type BodyWriter = (next: string, expected: string) => Promise<unknown>;

/** Write a note body and record the inverse. Resolves once the forward write
    has landed, so a caller that wants to clear a form can await it; rejects
    with the write's own error, in which case nothing was recorded. */
export async function bodyEditUndoable(opts: {
  path: string;
  /** the body this action produces */
  next: string;
  /** the body it replaces — captured before the write, not read back after */
  prior: string;
  /** what the user did, in their words: "Log Eggs" */
  label: string;
  scope: UndoScope;
  record: UndoRecorder;
  write: BodyWriter;
  /** pre-minted id, when the surface wants to point its own Undo button at
      exactly this entry */
  id?: number;
}): Promise<void> {
  const { path, next, prior, label, scope, record, write } = opts;
  await write(next, prior);
  record({
    id: opts.id,
    label,
    scope,
    at: Date.now(),
    paths: [path],
    // each direction guards on the body the other direction wrote, so an edit
    // from anywhere else in between refuses the inverse instead of erasing it
    undo: async () => {
      await write(prior, next);
    },
    redo: async () => {
      await write(next, prior);
    },
  });
}
