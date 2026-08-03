/* SUB-477 — the one place a property edit becomes undoable (docs/undo.md §6.2).

   Every surface that writes a property goes through here rather than calling
   vaultSetProp directly, so ⌘Z behaves identically whether the edit came from
   a database cell, a calendar drag, the palette or the note's own prop row.

   The inverse of "set K to V" is "set K back to prior", guarded on V still
   being what's on disk. That guard is the whole safety story: if anything
   changed the prop since, the undo is refused instead of clobbering it. */

import { vaultSetProp } from "./ipc.ts";
import type { NoteMeta, PropValue } from "./types.ts";
import type { UndoEntry, UndoScope } from "./undo.ts";

/** A recorder accepts a pre-minted id so a surface that shows its own "Undo"
    button can point that button at the very entry ⌘Z would run. */
export type UndoRecorder = (entry: Omit<UndoEntry, "id"> & { id?: number }) => void;

/** Human phrasing for the toast and the shortcut hint: "Status → in review". */
function propLabel(key: string, value: PropValue): string {
  if (value === null) return `Clear ${key}`;
  const shown = Array.isArray(value) ? value.join(", ") : String(value);
  return `${key} → ${shown}`;
}

/** Write one property and record the inverse. Returns the fresh meta, exactly
    like vaultSetProp did before, so call sites keep their .then shape. */
export async function setPropUndoable(opts: {
  path: string;
  key: string;
  value: PropValue;
  record: UndoRecorder;
  /** the whole phrase, when a surface knows better than "Key → value" */
  label?: string;
  /** just the property's display name, when the surface renames columns */
  keyLabel?: string;
  scope?: UndoScope;
  /** pre-minted (undo.nextUndoId()) when the caller needs to reference the
      entry — a toast's Undo button pointing at exactly this action */
  id?: number;
  /** Refresh caller-owned state after an inverse lands. The forward write is
      still the caller's promise to follow; this hook belongs to undo/redo,
      whose closures otherwise have no route back to the originating UI. */
  onApplied?: () => void | Promise<void>;
}): Promise<NoteMeta> {
  const { path, key, value, record } = opts;
  const { meta, prior } = await vaultSetProp(path, key, value);
  record({
    id: opts.id,
    label: opts.label ?? propLabel(opts.keyLabel ?? key, value),
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [path],
    // guarded on what we wrote: if the prop moved since, refuse rather than
    // overwrite whatever replaced it
    undo: async () => {
      await vaultSetProp(path, key, prior, { value });
      await opts.onApplied?.();
    },
    redo: async () => {
      await vaultSetProp(path, key, value, { value: prior });
      await opts.onApplied?.();
    },
  });
  return meta;
}

/** Write several properties of ONE note as a single undoable action. The
    calendar's "repeat: None" clears repeat, repeat_until and repeat_skip
    together — three writes, one thing the user did, so one ⌘Z. */
export async function setPropsUndoable(opts: {
  path: string;
  edits: { key: string; value: PropValue }[];
  record: UndoRecorder;
  label: string;
  scope?: UndoScope;
  id?: number;
}): Promise<NoteMeta | null> {
  const { path, edits, record } = opts;
  const done: { key: string; value: PropValue; prior: PropValue }[] = [];
  let meta: NoteMeta | null = null;
  let failure: unknown = null;
  for (const { key, value } of edits) {
    try {
      const res = await vaultSetProp(path, key, value);
      meta = res.meta;
      done.push({ key, value, prior: res.prior });
    } catch (e) {
      // a key partway through refused (the note vanished, the frontmatter went
      // unparseable). The keys before it DID change, so record an entry for
      // exactly those and then rethrow — the caller still reports the failure,
      // but the half-applied action is takeable back (docs/undo.md §2.2).
      failure = e;
      break;
    }
  }
  if (done.length === 0) {
    if (failure) throw failure;
    return meta;
  }
  record({
    id: opts.id,
    label: opts.label,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [path],
    // undo walks backwards: the last write is the first to be taken back
    undo: async () => {
      for (const e of [...done].reverse()) await vaultSetProp(path, e.key, e.prior, { value: e.value });
    },
    redo: async () => {
      for (const e of done) await vaultSetProp(path, e.key, e.value, { value: e.prior });
    },
  });
  if (failure) throw failure;
  return meta;
}

export type BulkPropResult = {
  ok: { path: string; meta: NoteMeta }[];
  failed: { path: string; error: string }[];
};

/** Write one property across many notes and record ONE undo entry covering
    the writes that actually landed. A partial failure is normal (a note can
    be gone, or its frontmatter unparseable); undoing then reverts exactly the
    notes that changed, which is what the user saw happen. */
export async function setPropUndoableBulk(opts: {
  paths: string[];
  key: string;
  /** Per-note existing spelling for case-folded database columns. Missing
      paths keep `key`, so new props still use the database's canonical key. */
  keysByPath?: Readonly<Record<string, string>>;
  value: PropValue;
  record: UndoRecorder;
  /** the whole phrase, when a surface knows better than "Key → value" */
  label?: string;
  /** just the property's display name, when the surface renames columns */
  keyLabel?: string;
  scope?: UndoScope;
}): Promise<BulkPropResult> {
  const { paths, key, value, record } = opts;
  const out: BulkPropResult = { ok: [], failed: [] };
  const priors: { path: string; key: string; prior: PropValue }[] = [];
  for (const path of paths) {
    const actualKey = opts.keysByPath?.[path] ?? key;
    try {
      // sequential on purpose: each write is a read-modify-write of a file,
      // and the engine's lock would serialize them anyway
      const { meta, prior } = await vaultSetProp(path, actualKey, value);
      out.ok.push({ path, meta });
      priors.push({ path, key: actualKey, prior });
    } catch (e) {
      out.failed.push({ path, error: String(e) });
    }
  }
  if (priors.length === 0) return out;
  const n = priors.length;
  record({
    label:
      opts.label ?? `${propLabel(opts.keyLabel ?? key, value)} on ${n} note${n === 1 ? "" : "s"}`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: priors.map((p) => p.path),
    undo: async () => {
      for (const { path, key: actualKey, prior } of priors)
        await vaultSetProp(path, actualKey, prior, { value });
    },
    redo: async () => {
      for (const { path, key: actualKey, prior } of priors)
        await vaultSetProp(path, actualKey, value, { value: prior });
    },
  });
  return out;
}
