/* View-config edits become undoable (docs/undo.md §6.6).

   Everything in `.vault/views.json` — a database's view pref, the saved-view
   pins, the sidebar order, a folder's icon — is written as a WHOLE-OBJECT
   replace, so the inverse is simply the whole prior object written back. That
   is what makes these the cheapest entries in the design and why they capture
   a snapshot rather than a delta: a partial `vault_views_set` silently wipes
   the fields it omits, so anything short of the whole prior pref is a data
   loss dressed up as an undo.

   Three things are specific to this family:

   - **The helper does the forward write.** Not for symmetry with
     `undoprops.ts` but because the engine NORMALIZES what it stores (empty
     lists collapse to absent, an emoji beats a glyph, a tint with no mark
     drops). The guard below compares against what the vault actually holds,
     so it has to be the write's own response — comparing against what the UI
     asked for would refuse an undo after every edit the engine tidied.
   - **There is no engine-side guard.** `vault_set_prop` takes an `expected`
     and refuses a clobber at the door; none of the views commands do. So each
     inverse re-reads the config and writes only while it still holds exactly
     what the action wrote — the same check-then-act, with the same one
     round-trip window, that `undoschema.ts` already accepts. A moved config
     throws `conflict:`, which is the app's spelling for "it changed on disk".
   - **Every write rides the caller's queue.** `.vault/views.json` has one
     writer queue (`queueViewsWrite`) because two read-modify-writes in flight
     lose a key. Forward writes and inverses both go through the `apply` the
     caller hands in, so an undo can never interleave with a live write. */

import {
  vaultFolderIconSet,
  vaultFolderMetaRead,
  vaultSavedViewDelete,
  vaultSavedViewSet,
  vaultSavedViewsRead,
  vaultSetSidebarOrder,
  vaultSidebarOrder,
  vaultViewsRead,
  vaultViewsSet,
} from "./ipc.ts";
import type {
  DbIcon,
  FolderMetaMap,
  SavedView,
  SidebarOrder,
  ViewPref,
  ViewsConfig,
} from "./types.ts";
import { sameConfig, type UndoScope } from "./undo.ts";
import type { UndoRecorder } from "./undoprops.ts";

/** What a views.json entry names as the thing it would rewrite. The watcher
    never reports this file as a note path, so it is inert against the
    path-scoped invalidation and only the whole-stack sweep reaches it — which
    is the conservative side to be on. */
export const VIEWS_CONFIG_PATH = ".vault/views.json";

/** How a write reaches views.json: the caller's queued writer, so undo takes
    its turn behind whatever the UI already issued. It resolves to the
    command's own response — the stored truth the guard is written against —
    and rejects when the write failed, so the stack never advances past an
    inverse that did not land. */
export type ViewsApply = <T>(write: () => Promise<T>, adopt: (value: T) => void) => Promise<T>;

type Common = {
  record: UndoRecorder;
  apply: ViewsApply;
  /** pre-minted (undo.nextUndoId()) when a toast's Undo button must run the
      very entry ⌘Z would run */
  id?: number;
  label?: string;
  scope?: UndoScope;
};

/** The one place a `ViewPref` becomes the flat argument list `vault_views_set`
    takes. Both the forward write and its inverse go through it, so an undo
    cannot send a shorter list than the edit did and wipe the difference. */
export function viewsSetFromPref(db: string, p: ViewPref): Promise<ViewsConfig> {
  return vaultViewsSet(
    db,
    p.view,
    p.group_by,
    p.table_group_by,
    p.aggregations,
    p.sorts,
    p.col_order,
    p.hidden,
    p.widths,
    p.wrap,
    p.grid,
    p.hidden_per_layout,
    p.card_order,
    p.group_order,
    p.collapsed_groups,
    p.cal_date
  );
}

/** The refusal every inverse here raises when the config moved under it. The
    `conflict:` prefix is what the runner reads to say "it changed on disk"
    rather than blaming the write. */
function moved(what: string): Error {
  return new Error(`conflict: ${what} changed since`);
}

/* A note on the guard reads below. These commands take no `expected`
   parameter, so each inverse re-reads the stored value and compares it before
   writing — and that read sits OUTSIDE the write queue, which serializes
   writes only. A queued write of somebody else's can therefore land between
   the read and the inverse's own write, and the guard would have passed
   against a value that is already gone.

   Named rather than closed. The window is one queue slot wide and only opens
   when another writer's write is already queued behind this one; threading
   the read through the queue would need a read seam `ViewsApply` does not
   carry, and it would still not order against another process editing
   views.json — the same hazard, one layer out, which is what the vault's
   change events and the staling they trigger are for. */

/** A database's view pref: layout, sorts, grouping, hidden columns, widths,
    wrap, card and group order — one entry for the whole object, because the
    command replaces the whole object.

    `before` is the stored pref this edit replaced. A database with none yet
    records nothing: `vault_views_set` can only replace an entry, never remove
    one, so "no pref at all" is a state no inverse can write back. The first
    edit on a fresh database is therefore not undoable; every one after it is. */
export async function setDbPrefUndoable(
  opts: Common & {
    db: string;
    pref: ViewPref;
    before: ViewPref | undefined;
    adopt: (cfg: ViewsConfig) => void;
  }
): Promise<ViewsConfig> {
  const { db, pref, before, record, apply, adopt } = opts;
  const cfg = await apply(() => viewsSetFromPref(db, pref), adopt);
  const after = cfg[db];
  if (!before || !after || sameConfig(before, after)) return cfg;
  const write = (p: ViewPref, expected: ViewPref) => async () => {
    if (!sameConfig((await vaultViewsRead())[db], expected)) throw moved("the view settings");
    await apply(() => viewsSetFromPref(db, p), adopt);
  };
  record({
    id: opts.id,
    label: opts.label ?? "View settings",
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [VIEWS_CONFIG_PATH],
    undo: write(before, after),
    redo: write(after, before),
  });
  return cfg;
}

/** Saving or updating a pin. `before` is null when the pin is new — the
    inverse is then a delete rather than a restore. */
export async function savedViewSetUndoable(
  opts: Common & {
    view: SavedView;
    before: SavedView | null;
    adopt: (views: SavedView[]) => void;
  }
): Promise<SavedView[]> {
  const { view, before, record, apply, adopt } = opts;
  const views = await apply(() => vaultSavedViewSet(view), adopt);
  const after = views.find((v) => v.id === view.id) ?? null;
  if (!after || sameConfig(before, after)) return views;
  const stored = async () => (await vaultSavedViewsRead()).find((v) => v.id === view.id) ?? null;
  record({
    id: opts.id,
    label: opts.label ?? `Save pin “${after.name}”`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [VIEWS_CONFIG_PATH],
    undo: async () => {
      if (!sameConfig(await stored(), after)) throw moved(`the pin “${after.name}”`);
      await apply(
        () => (before ? vaultSavedViewSet(before) : vaultSavedViewDelete(after.id)),
        adopt
      );
    },
    redo: async () => {
      if (!sameConfig(await stored(), before)) throw moved(`the pin “${after.name}”`);
      await apply(() => vaultSavedViewSet(after), adopt);
    },
  });
  return views;
}

/** Deleting a pin. Two things go with it that a bare re-`set` would not bring
    back: its POSITION (a re-`set` appends to the end) and its sidebar
    shortcut (the engine drops `sv:<id>` from `$sidebar.keys` on delete). Both
    are captured here, so the inverse restores the row where it stood with the
    key it answered to. */
export async function savedViewDeleteUndoable(
  opts: Common & {
    removed: SavedView;
    /** the whole pin list as it stood, in order, before the delete */
    before: SavedView[];
    /** `$sidebar.keys` as it stood before the delete */
    beforeKeys: Record<string, string> | undefined;
    adopt: (views: SavedView[]) => void;
    /** where a restored shortcut map lands in the UI. Without it the keys are
        back on disk but inert until the watcher's next re-read. */
    adoptOrder?: (order: SidebarOrder) => void;
  }
): Promise<SavedView[]> {
  const { removed, before, beforeKeys, record, apply, adopt, adoptOrder } = opts;
  const index = before.findIndex((v) => v.id === removed.id);
  const after = await apply(() => vaultSavedViewDelete(removed.id), adopt);
  if (index === -1) return after;
  record({
    id: opts.id,
    label: opts.label ?? `Delete pin “${removed.name}”`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [VIEWS_CONFIG_PATH],
    undo: async () => {
      // guard read, outside the queue — see the note above `setDbPrefUndoable`
      if (!sameConfig(await vaultSavedViewsRead(), after)) throw moved("the pins");
      /* The shortcut map as it stands NOW, before the walk below re-issues
         pins and the engine drops a key for each one it deletes on the way.
         A shortcut somebody assigned since the delete exists only here — the
         captured map predates it. */
      const beforeWalk = (await vaultSidebarOrder()).keys ?? {};
      /* Each of the walk's deletes drops its pin's shortcut too, as did the
         delete being undone. Putting those back is owed whether the walk
         finishes or falls over: a failed walk re-sets its pins, and leaving
         their shortcuts off would lose them for good — the only copy is the
         captured map this closure holds, and the closure is on its way out.
         Only the slots this action knocked out, live truth first. */
      const touched = keysTouched(removed, before, index);
      const putKeysBack = () =>
        restoreSidebarKeys(
          [...Object.entries(beforeWalk), ...Object.entries(beforeKeys ?? {})].filter(
            ([, target]) => touched.has(target)
          ),
          apply,
          adoptOrder
        );
      try {
        await apply(async () => {
          try {
            await vaultSavedViewSet(removed);
            /* `set` appends, so the restored pin sits last. Every pin that
               FOLLOWED it is re-issued behind it — delete-then-set, the only
               move the command surface offers — which walks the row back to
               its old slot. Nothing after the removed pin means nothing to
               walk. */
            for (const v of before.slice(index + 1)) {
              await vaultSavedViewDelete(v.id);
              await vaultSavedViewSet(v);
            }
          } catch (e) {
            /* The walk deletes a pin before it re-sets it, so a rejection —
               or a quit — between the two takes that pin with it, and the only
               copy left is the captured list this closure holds. Put back
               whatever is missing before the failure leaves: an undo that
               refuses is a nuisance, an undo that loses a pin is not
               recoverable from the UI. */
            await restoreMissingPins(before);
            throw e;
          }
          return vaultSavedViewsRead();
        }, adopt);
      } catch (e) {
        /* The pins are back, but their shortcuts went with the deletes and the
           sidebar still shows the list as it stood mid-walk. Repair both, then
           let the real error out. */
        await putKeysBack().catch(() => {});
        await apply(vaultSavedViewsRead, adopt).catch(() => {});
        throw e;
      }
      await putKeysBack();
    },
    redo: async () => {
      if (!sameConfig(await vaultSavedViewsRead(), before)) throw moved("the pins");
      await apply(() => vaultSavedViewDelete(removed.id), adopt);
    },
  });
  return after;
}

/** Every `sv:` shortcut target the undo walk's deletes knocked out: the pin
    being restored, plus each pin re-issued behind it to walk it back into
    place. Nothing else in the captured map is this action's to speak for. */
function keysTouched(removed: SavedView, before: SavedView[], index: number): Set<string> {
  return new Set([removed, ...before.slice(index + 1)].map((v) => `sv:${v.id}`));
}

/** Put back the shortcuts this action knocked out — MERGED into the live map,
    never written over it. The captured map is a snapshot of every shortcut in
    the vault at delete time, and the whole of it going back means a shortcut
    somebody assigned since is silently erased. So `wanted` carries only the
    slots this action is answerable for, live truth first, and each is put back
    only while the slot is still free and its target isn't already answering to
    another slot. The rest of the sidebar order — sections, collapse state — is
    not this action's to restore at all. */
async function restoreSidebarKeys(
  wanted: Array<[string, string]>,
  apply: ViewsApply,
  adoptOrder?: (order: SidebarOrder) => void
): Promise<void> {
  const cur = await vaultSidebarOrder();
  const live = cur.keys ?? {};
  const merged: Record<string, string> = { ...live };
  for (const [slot, target] of wanted) {
    if (merged[slot] !== undefined) continue;
    if (Object.values(merged).includes(target)) continue;
    merged[slot] = target;
  }
  if (sameConfig(merged, live)) return;
  await apply(
    () => vaultSetSidebarOrder({ ...cur, keys: merged }),
    (order) => adoptOrder?.(order)
  );
}

/** Best effort after a mid-walk failure: re-set every captured pin the vault
    no longer holds. Order is not rebuilt — a re-`set` appends, and getting a
    row back in the wrong place is a far smaller harm than not getting it back.
    Each pin is tried on its own so one refusal doesn't strand the rest, and
    nothing here throws: the caller is already on its way out with the real
    error. */
async function restoreMissingPins(before: SavedView[]): Promise<void> {
  let live: Set<string>;
  try {
    live = new Set((await vaultSavedViewsRead()).map((v) => v.id));
  } catch {
    return;
  }
  for (const v of before) {
    if (live.has(v.id)) continue;
    try {
      await vaultSavedViewSet(v);
    } catch {
      // nothing further to try — the failure the caller carries says enough
    }
  }
}

/** Sidebar reordering — a section drag, a folder drag, a collapse toggle, a
    pin, a shortcut assignment. One whole-object replace, one entry. */
export async function setSidebarOrderUndoable(
  opts: Common & {
    before: SidebarOrder;
    next: SidebarOrder;
    adopt: (order: SidebarOrder) => void;
  }
): Promise<SidebarOrder> {
  const { before, next, record, apply, adopt } = opts;
  const after = await apply(() => vaultSetSidebarOrder(next), adopt);
  if (sameConfig(before, after)) return after;
  const write = (order: SidebarOrder, expected: SidebarOrder) => async () => {
    // guard read, outside the queue — see the note above `setDbPrefUndoable`
    if (!sameConfig(await vaultSidebarOrder(), expected)) throw moved("the sidebar");
    await apply(() => vaultSetSidebarOrder(order), adopt);
  };
  record({
    id: opts.id,
    label: opts.label ?? "Sidebar order",
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [VIEWS_CONFIG_PATH],
    undo: write(before, after),
    redo: write(after, before),
  });
  return after;
}

/** A folder's icon. `null` is both a legal value and the absence, and the
    command takes the whole icon each write, so the prior icon rides whole. */
export async function setFolderIconUndoable(
  opts: Common & {
    path: string;
    icon: DbIcon | null;
    before: DbIcon | null;
    adopt: (meta: FolderMetaMap) => void;
  }
): Promise<FolderMetaMap> {
  const { path, icon, before, record, apply, adopt } = opts;
  const meta = await apply(() => vaultFolderIconSet(path, icon), adopt);
  const after = meta[path]?.icon ?? null;
  if (sameConfig(before, after)) return meta;
  const write = (want: DbIcon | null, expected: DbIcon | null) => async () => {
    const cur = (await vaultFolderMetaRead())[path]?.icon ?? null;
    if (!sameConfig(cur, expected)) throw moved("the folder icon");
    await apply(() => vaultFolderIconSet(path, want), adopt);
  };
  record({
    id: opts.id,
    label: opts.label ?? (after ? "Folder icon" : "Remove folder icon"),
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [VIEWS_CONFIG_PATH],
    undo: write(before, after),
    redo: write(after, before),
  });
  return meta;
}
