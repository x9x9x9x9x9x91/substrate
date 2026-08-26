/* The one place a property edit becomes undoable (docs/undo.md §6.2).

   Every surface that writes a property goes through here rather than calling
   vaultSetProp directly, so ⌘Z behaves identically whether the edit came from
   a database cell, a calendar drag, the palette or the note's own prop row.

   The inverse of "set K to V" is "set K back to prior", guarded on V still
   being what's on disk. That guard is the whole safety story: if anything
   changed the prop since, the undo is refused instead of clobbering it. */

import { vaultNoteAddTags, vaultRead, vaultSetProp } from "./ipc.ts";
import { noteOwnWrite } from "./ownwrites.ts";
import { foldedPropKey } from "./types.ts";
import type { NoteMeta, PropValue, SetPropResult } from "./types.ts";
import type { UndoEntry, UndoScope } from "./undo.ts";
import { errText } from "./errtext.ts";

/** A recorder accepts a pre-minted id so a surface that shows its own "Undo"
    button can point that button at the very entry ⌘Z would run. */
export type UndoRecorder = (entry: Omit<UndoEntry, "id"> & { id?: number }) => void;

/** How a surface actually lands a property write. Everything ordinary uses
    `vaultSetProp`; a mount's rows route through `mount_annotate`
    instead, because a row's note may not exist until this very write creates
    it. Undo/redo go back through the same writer, so ⌘Z behaves the same on
    a mounted folder as anywhere else. */
export type PropWriter = (
  path: string,
  key: string,
  value: PropValue,
  guard?: { value: PropValue }
) => Promise<SetPropResult>;

const defaultWrite: PropWriter = (path, key, value, guard) =>
  vaultSetProp(path, key, value, guard);

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
  /** non-default write path (a mount's rows) */
  write?: PropWriter;
}): Promise<NoteMeta> {
  const { path, key, value, record } = opts;
  const vaultSetProp = opts.write ?? defaultWrite;
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

/** The `tags:` value in a shape the write domain accepts. Anything else (a
    nested map under `tags:`) has no inverse we could write back, so the
    caller declines to record rather than risk clobbering it. */
function tagsPropValue(raw: unknown): PropValue | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) return raw as string[];
  return undefined;
}

/** Drop a note on a tag folder: add tags, record the inverse.

    `vault_note_add_tags` is a union — additive and de-duped — so the inverse
    is "put the prior `tags:` back", never "remove the tags we asked for": the
    note may already have carried one of them, and removing it would take away
    something the drop never added.

    The engine returns no prior (unlike vaultSetProp), so the pre-write value
    is read here and the post-write value is read back for the guard. Undo is
    then an ordinary guarded prop write — refused, not forced, if the tags
    moved since (docs/undo.md §6.2). */
export async function addTagsUndoable(opts: {
  path: string;
  tags: string[];
  record: UndoRecorder;
  label?: string;
  scope?: UndoScope;
  id?: number;
  onApplied?: () => void | Promise<void>;
}): Promise<NoteMeta> {
  const { path, tags, record } = opts;
  const before = await vaultRead(path);
  const key = foldedPropKey(before.props, "tags");
  const prior = tagsPropValue(before.props[key]);
  const meta = await vaultNoteAddTags(path, tags);
  const after = await vaultRead(path);
  const writtenKey = foldedPropKey(after.props, "tags");
  const written = tagsPropValue(after.props[writtenKey]);
  // nothing changed (every tag was already on the note, inline or in the
  // prop): there is no edit to take back
  const same = JSON.stringify(prior ?? null) === JSON.stringify(written ?? null);
  if (prior === undefined || written === undefined || same) return meta;
  record({
    id: opts.id,
    label: opts.label ?? `Tagged ${tags.map((t) => `#${t}`).join(" ")}`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [path],
    undo: async () => {
      await vaultSetProp(path, writtenKey, prior, { value: written });
      await opts.onApplied?.();
    },
    redo: async () => {
      await vaultSetProp(path, writtenKey, written, { value: prior });
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
  /** non-default write path (a mount's rows) */
  write?: PropWriter;
}): Promise<BulkPropResult> {
  const { paths, key, value, record } = opts;
  const vaultSetProp = opts.write ?? defaultWrite;
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
      out.failed.push({ path, error: errText(e) });
    }
  }
  if (priors.length === 0) return out;
  /* Re-stamp the whole burst at its end. The watcher coalesces the sweep into
     ONE event ~300ms after its LAST write, so a sweep that runs longer than
     the echo window had its early paths' stamps expire before their own echo
     arrived: they read as somebody else's edit, and the invalidate that
     followed staled the entry recorded just below — the next ⌘Z silently ran
     an OLDER one. Stamp age has to be measured from the end of the burst.

     Known trade, accepted: an external write to an early path DURING the sweep
     is coalesced into the same event, and the tail stamp makes it read as ours,
     so the invalidate it should have caused never fires. The stack is not the
     last guard against that — every inverse below is a guarded write (`{ value }`
     = "only if the prop is still what we wrote"), so an undo over a prop
     somebody else moved is refused at apply time rather than clobbering it. A
     narrower rule (own only while a stamp inside the window post-dates the
     burst's start) would keep both, and belongs with the echo layer, not here. */
  noteOwnWrite(out.ok.map((o) => o.path));
  const n = priors.length;
  record({
    label:
      opts.label ?? `${propLabel(opts.keyLabel ?? key, value)} on ${n} note${n === 1 ? "" : "s"}`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: priors.map((p) => p.path),
    // both directions replay the same sequential sweep, so both need the same
    // tail stamp: a 50-note ⌘Z that outruns the echo window would otherwise
    // read as external when its coalesced event lands and stale the very entry
    // it just pushed onto the other side of the stack
    undo: async () => {
      for (const { path, key: actualKey, prior } of priors)
        await vaultSetProp(path, actualKey, prior, { value });
      noteOwnWrite(priors.map((p) => p.path));
    },
    redo: async () => {
      for (const { path, key: actualKey, prior } of priors)
        await vaultSetProp(path, actualKey, value, { value: prior });
      noteOwnWrite(priors.map((p) => p.path));
    },
  });
  return out;
}
