/* Optimistic property writes: the value paints the frame the user
   commits it, the vault write and its re-scan reconcile behind it.

   Every database write already round-trips IPC and then asks App for a full
   re-sync (onMutated). Cell mode masked that wait with a ghost placeholder,
   but a board drag or a 20-row bulk set sat visibly still until disk answered.

   This is the smallest honest mechanic for that: a per-pane overlay of writes
   in flight, laid over the notes the pane renders. Nothing here writes, reads
   or caches anything — the vault stays the only source of truth, and an
   overlay entry lives exactly as long as the write it stands for:

     add    — the user committed; the value paints now
     settle — the write landed; the entry dies on the next `notes` the
              refresh delivers, so the swap to disk truth is never a flash of
              the old value
     drop   — the write was refused; the value rolls back visibly and the
              caller's existing failure path (reportFailure / the toast) says
              why. A rejected value is never silently kept.

   Undo is untouched: the inverse writes still come from the engine's `prior`
   (lib/undoprops), never from anything overlaid here. */

import type { NoteMeta, PropValue } from "./types.ts";

export interface PendingWrite {
  path: string;
  /** the note's OWN spelling of the key (foldedPropKey), not the column's */
  key: string;
  value: PropValue;
}

interface PendingEntry extends PendingWrite {
  /** the write resolved; the entry is waiting for the refresh to catch up */
  settled: boolean;
  /** how many refreshes have arrived since it settled WITHOUT carrying the
      value — see prunePending: one is absorbed (a watcher refresh already in
      flight), the next retires the entry */
  staleRefreshes: number;
  /** the exact write object this entry was created from. settle and drop
      arrive late and must not act on a cell a NEWER write has taken over;
      comparing values would confuse a re-write of the same value (toggle
      A → B → A) with the write that is actually on screen, so ownership is
      identity, not equality. Callers already hand the same array back. */
  token: PendingWrite;
}

export type PendingProps = ReadonlyMap<string, PendingEntry>;

export const NO_PENDING: PendingProps = new Map();

/* NUL as the separator: a path or a prop key may hold any other character,
   so any printable one could be forged into a collision. Written as an escape
   rather than the literal byte — a literal NUL makes git read the whole file
   as binary and stop diffing it. */
const idOf = (path: string, key: string) => `${path}\u0000${key}`;

/** Does what's stored on the note already say what we optimistically wrote?
    Props come off YAML as `unknown`, so this compares by the shape the write
    used: null means "absent", a list compares element-wise as text, and a
    scalar compares as text (a typed "12" and a stored 12 are the same value). */
function sameValue(stored: unknown, written: PropValue): boolean {
  if (written === null) return stored === undefined || stored === null;
  if (stored === undefined || stored === null) return false;
  if (Array.isArray(written)) {
    return (
      Array.isArray(stored) &&
      stored.length === written.length &&
      stored.every((v, i) => String(v) === String(written[i]))
    );
  }
  if (typeof written === "boolean") return stored === written;
  return String(stored) === String(written);
}

/** Is this entry still the one that write put on screen? A late settle or
    drop for a superseded write must leave the newer one alone. Callers keep
    the array they handed to addPending and hand its own elements back (a
    filter preserves them), so ownership is the identity of that object. */
const owns = (e: PendingEntry, w: PendingWrite): boolean => e.token === w;

/** Start showing these writes. Re-writing a cell that is already pending
    replaces its value (and un-settles it — a second write is in flight). */
export function addPending(cur: PendingProps, writes: readonly PendingWrite[]): PendingProps {
  if (writes.length === 0) return cur;
  const next = new Map(cur);
  for (const w of writes)
    next.set(idOf(w.path, w.key), { ...w, settled: false, staleRefreshes: 0, token: w });
  return next;
}

/** The write landed. The value stays on screen until the refresh it triggered
    delivers the same value from disk — dropping it here would paint the old
    value for the frames between the resolve and the re-sync. */
export function settlePending(cur: PendingProps, writes: readonly PendingWrite[]): PendingProps {
  let next: Map<string, PendingEntry> | null = null;
  for (const w of writes) {
    const id = idOf(w.path, w.key);
    const e = cur.get(id);
    // a newer write replaced this one — that one owns the cell now
    if (!e || e.settled || !owns(e, w)) continue;
    next ??= new Map(cur);
    next.set(id, { ...e, settled: true });
  }
  return next ?? cur;
}

/** The write was refused (or undone before it landed): roll the value back on
    screen this frame — but only if this write still owns the cell. A slow
    refusal that arrives after the user retyped would otherwise erase the newer
    write's paint, flash disk's stale truth, and leave the newer settle with
    nothing to settle. Same supersession rule as settlePending. */
export function dropPending(
  cur: PendingProps,
  writes: readonly PendingWrite[]
): PendingProps {
  let next: Map<string, PendingEntry> | null = null;
  for (const w of writes) {
    const id = idOf(w.path, w.key);
    const e = cur.get(id);
    // a newer write replaced this one — that one owns the cell now
    if (!e || !owns(e, w)) continue;
    next ??= new Map(cur);
    next.delete(id);
  }
  return next ?? cur;
}

/** Fresh notes arrived: retire every entry disk has caught up with.

    An entry goes as soon as the note reads the way it paints — that refresh
    demonstrably carries the value, so the swap to disk truth is invisible.

    A settled entry that does NOT match needs care in both directions. It
    cannot be retired on the first mismatching refresh: a watcher refresh
    already in flight when the write landed knows only the OLD value, and
    retiring against it paints exactly the stale flash the settle step exists
    to prevent. But it cannot be kept forever either — the engine may
    normalize a written value into something `sameValue` will never match,
    and a permanent entry would pin a stale overlay over live disk data.

    So a settled entry survives exactly one mismatching refresh and goes on
    the next. That bounds the overlay's life at two refreshes past its write
    while absorbing the in-flight refresh that is the actual race. */
export function prunePending(
  cur: PendingProps,
  /* the shape a refresh has to carry, nothing more: the database pane hands
     its whole NoteMeta[], the note pane the one note it has open */
  notes: readonly { path: string; props: Record<string, unknown> }[]
): PendingProps {
  if (cur.size === 0) return cur;
  const byPath = new Map(notes.map((n) => [n.path, n]));
  let next: Map<string, PendingEntry> | null = null;
  for (const [id, e] of cur) {
    const note = byPath.get(e.path);
    const carriesValue = note !== undefined && sameValue(note.props[e.key], e.value);
    if (carriesValue) {
      next ??= new Map(cur);
      next.delete(id);
      continue;
    }
    if (!e.settled) continue;
    next ??= new Map(cur);
    if (e.staleRefreshes > 0) next.delete(id);
    else next.set(id, { ...e, staleRefreshes: e.staleRefreshes + 1 });
  }
  return next ?? cur;
}

/** The notes the pane renders: disk, with the writes in flight laid over it.
    Returns the input array untouched when nothing is pending, so a pane with
    no write in flight pays nothing and every downstream memo keeps its
    identity. */
export function applyPending(notes: NoteMeta[], pending: PendingProps): NoteMeta[] {
  if (pending.size === 0) return notes;
  const byPath = new Map<string, PendingEntry[]>();
  for (const e of pending.values()) {
    const list = byPath.get(e.path);
    if (list) list.push(e);
    else byPath.set(e.path, [e]);
  }
  if (byPath.size === 0) return notes;
  let touched = false;
  const out = notes.map((n) => {
    const entries = byPath.get(n.path);
    if (!entries) return n;
    const props = { ...n.props };
    for (const e of entries) {
      if (e.value === null) delete props[e.key];
      else props[e.key] = e.value;
    }
    touched = true;
    return { ...n, props };
  });
  return touched ? out : notes;
}

/** Same overlay for a pane that holds ONE note's props rather than a list
    (the note page). Returns the input object untouched when this
    note has nothing in flight, so an idle pane keeps its identity and every
    memo hanging off `props` stays put. */
export function applyPendingTo(
  path: string,
  props: Record<string, unknown>,
  pending: PendingProps
): Record<string, unknown> {
  if (pending.size === 0) return props;
  let out: Record<string, unknown> | null = null;
  for (const e of pending.values()) {
    if (e.path !== path) continue;
    out ??= { ...props };
    if (e.value === null) delete out[e.key];
    else out[e.key] = e.value;
  }
  return out ?? props;
}
