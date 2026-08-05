/* Structural actions become undoable (docs/undo.md §6.3).

   Same shape as undoprops.ts, one layer up: create, trash, move, rename and
   the three folder actions each record their inverse rather than a snapshot.

   Two things are specific to this slice:

   - Trash and create are inverses of each other, and both are keyed by the
     trash id the engine returns — never by a path scan, because the
     same path can sit in the trash twice and a scan restores the wrong one.
   - A rename's `paths` is the whole set the engine rewrote (`touched`), not
     just the renamed note. The link sweep edits third-party notes; if the
     entry didn't name them, an external edit to one of them wouldn't
     invalidate the undo and taking it back would clobber that edit. */

import {
  vaultCreateFolder,
  vaultDelete,
  vaultDeleteFolder,
  vaultMove,
  vaultMoveFolder,
  vaultRename,
  vaultRenameFolder,
  vaultTrashRestore,
  vaultTrashRestoreFolder,
} from "./ipc.ts";
import type { NoteMeta } from "./types.ts";
import type { UndoScope } from "./undo.ts";
import type { UndoRecorder } from "./undoprops.ts";

type Common = {
  record: UndoRecorder;
  /** pre-minted (undo.nextUndoId()) when a toast's Undo button must run the
      very entry ⌘Z would run, rather than a lookalike closure */
  id?: number;
  label?: string;
  scope?: UndoScope;
};

/** The folder part of a vault-relative path ("" at the root). */
function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** The last segment of a folder rel — what vault_rename_folder takes. */
function baseName(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at === -1 ? rel : rel.slice(at + 1);
}

/** Trash a note and record the restore. Resolves to the trash id, exactly
    like vaultDelete did, so call sites keep their `.then` shape. `restore`
    is the caller's restore-with-UI (re-select, refresh) so undo and the
    toast's Undo button do the same visible thing. */
export async function trashUndoable(
  opts: Common & { path: string; restore: (trashId: string) => void | Promise<unknown> }
): Promise<string> {
  const { path, record, restore } = opts;
  const trashId = await vaultDelete(path);
  record({
    id: opts.id,
    label: opts.label ?? "Move to Trash",
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [path],
    // no redo: restoring may land the note on a numbered path, so
    // "trash it again" is no longer the same action the user took
    undo: async () => {
      await restore(trashId);
    },
  });
  return trashId;
}

/** Bulk trash: one entry for the whole selection, covering the notes that
    actually made it to the trash (a partial failure is normal). */
export function recordTrashBulk(
  opts: Common & {
    trashed: { path: string; id: string }[];
    restore: (trashId: string) => void | Promise<unknown>;
  }
): void {
  const { trashed, record, restore } = opts;
  if (trashed.length === 0) return;
  const n = trashed.length;
  record({
    id: opts.id,
    label: opts.label ?? `Move ${n} ${n === 1 ? "note" : "notes"} to Trash`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: trashed.map((t) => t.path),
    undo: async () => {
      for (const t of trashed) await restore(t.id);
    },
  });
}

/** A note was created: undoing trashes it, redoing restores that same trash
    entry by id — so a create/undo/redo cycle keeps one note, not two. */
export function recordCreate(opts: Common & { meta: NoteMeta }): void {
  const { meta, record } = opts;
  let trashId: string | null = null;
  record({
    id: opts.id,
    label: opts.label ?? `Create “${meta.title}”`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [meta.path],
    undo: async () => {
      trashId = await vaultDelete(meta.path);
    },
    redo: async () => {
      if (trashId === null) throw new Error("nothing to restore");
      await vaultTrashRestore(trashId);
    },
  });
}

/** Move a note between folders — the cleanest structural inverse there is
    (docs/undo.md §1.3): the filename and every link stay put. */
export async function moveUndoable(
  opts: Common & {
    path: string;
    folder: string;
    /** Undo/redo move the file outside the caller's own `.then`,
        so the app is left pointing at the path the note just vacated — the
        selection-guard then snaps the editor to a neighbour (the
        wrong-note trap, now at ⌘Z time). Callers pass the same follow
        wiring the forward move uses; fires after the inverse move resolves,
        before the stack's refresh. Same hook `renameUndoable` got for the
        identical asymmetry on rename undo. */
    onApplied?: (oldPath: string, meta: NoteMeta) => void;
  }
): Promise<NoteMeta> {
  const { path, folder, record, onApplied } = opts;
  const priorFolder = folderOf(path);
  const meta = await vaultMove(path, folder);
  if (meta.path !== path) {
    record({
      id: opts.id,
      label: opts.label ?? `Move to ${folder || "the vault root"}`,
      scope: opts.scope ?? "vault",
      at: Date.now(),
      paths: [path, meta.path],
      undo: async () => {
        const back = await vaultMove(meta.path, priorFolder);
        onApplied?.(meta.path, back);
      },
      redo: async () => {
        const again = await vaultMove(path, folder);
        onApplied?.(path, again);
      },
    });
  }
  return meta;
}

/** Rename a note. The entry's `paths` is every note the engine rewrote —
    the renamed note plus its link sources — so an external edit to any of
    them refuses the undo instead of overwriting it (docs/undo.md §6.3). */
export async function renameUndoable(
  opts: Common & {
    path: string;
    title: string;
    priorTitle: string;
    /** Undo/redo apply their rename outside any pane, so the path
        change would otherwise land as a plain prop change and remount the
        editor (the gap) with no selection repair. Callers pass the
        same announce+onRenamed wiring the forward rename uses; fires after
        the inverse rename resolves, before the stack's refresh. */
    onApplied?: (oldPath: string, meta: NoteMeta) => void;
  }
): Promise<NoteMeta> {
  const { path, title, priorTitle, record, onApplied } = opts;
  const { meta, touched } = await vaultRename(path, title);
  const paths = touched.includes(path) ? touched : [path, ...touched];
  record({
    id: opts.id,
    label: opts.label ?? `Rename to “${title}”`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths,
    // renaming back sweeps the links back with it — the inverse of a rename
    // is a rename, not a restore
    undo: async () => {
      const { meta: m } = await vaultRename(meta.path, priorTitle);
      onApplied?.(meta.path, m);
    },
    redo: async () => {
      const { meta: m } = await vaultRename(path, title);
      onApplied?.(path, m);
    },
  });
  return meta;
}

/** Create a folder. Undo trashes it; it is empty at that moment (the user
    just made it), so nothing rides along into the trash. */
export async function createFolderUndoable(opts: Common & { path: string }): Promise<string> {
  const { path, record } = opts;
  const rel = await vaultCreateFolder(path);
  let trashId: string | null = null;
  record({
    id: opts.id,
    label: opts.label ?? `Create folder “${baseName(rel)}”`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [rel],
    undo: async () => {
      trashId = await vaultDeleteFolder(rel);
    },
    redo: async () => {
      if (trashId === null) throw new Error("nothing to restore");
      await vaultTrashRestoreFolder(trashId);
    },
  });
  return rel;
}

/** Rename a folder. The engine sanitizes the requested name, so the inverse
    is captured from the rel it actually returned, never from the request. */
export async function renameFolderUndoable(
  opts: Common & { path: string; name: string; notePaths?: string[] }
): Promise<string> {
  const { path, name, record } = opts;
  const newRel = await vaultRenameFolder(path, name);
  const priorName = baseName(path);
  record({
    id: opts.id,
    label: opts.label ?? `Rename folder to “${baseName(newRel)}”`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    // the dir moves and every note under it moves with it
    paths: [path, newRel, ...(opts.notePaths ?? [])],
    undo: async () => {
      await vaultRenameFolder(newRel, priorName);
    },
    redo: async () => {
      await vaultRenameFolder(path, name);
    },
  });
  return newRel;
}

/** Move a folder under another parent — the directory keeps its
    name, so the inverse is just "move it back to the parent it came from",
    the same clean structural inverse `moveUndoable` has for a note. The
    engine's path-keyed records (sidebar lanes, folder meta, keys) ride the
    inverse call, so undo restores position and order without extra work.
    `follow` is the caller's UI catch-up (open views, collapse ids) — it runs on
    the forward move AND on undo/redo, so taking a move back doesn't leave the
    app pointing at the path the engine no longer has. */
export async function moveFolderUndoable(
  opts: Common & {
    path: string;
    target: string;
    notePaths?: string[];
    follow?: (oldRel: string, newRel: string) => void;
  }
): Promise<string> {
  const { path, target, record, follow } = opts;
  const priorParent = folderOf(path);
  const newRel = await vaultMoveFolder(path, target);
  if (newRel !== path) {
    follow?.(path, newRel);
    record({
      id: opts.id,
      label: opts.label ?? `Move folder “${baseName(path)}” to ${target || "the vault root"}`,
      scope: opts.scope ?? "vault",
      at: Date.now(),
      // the dir moves and every note under it moves with it
      paths: [path, newRel, ...(opts.notePaths ?? [])],
      undo: async () => {
        const back = await vaultMoveFolder(newRel, priorParent);
        follow?.(newRel, back);
      },
      redo: async () => {
        const again = await vaultMoveFolder(path, target);
        follow?.(path, again);
      },
    });
  }
  return newRel;
}

/** Trash a folder: the subtree goes to the trash as ONE entry, and undo
    brings it back by that id. No redo — restore can land the folder on a
    numbered rel, so re-trashing isn't the action the user took. */
export async function trashFolderUndoable(
  opts: Common & {
    path: string;
    notePaths?: string[];
    restore: (trashId: string) => void | Promise<unknown>;
  }
): Promise<string> {
  const { path, record, restore } = opts;
  const trashId = await vaultDeleteFolder(path);
  record({
    id: opts.id,
    label: opts.label ?? `Move folder “${baseName(path)}” to Trash`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [path, ...(opts.notePaths ?? [])],
    undo: async () => {
      await restore(trashId);
    },
  });
  return trashId;
}
