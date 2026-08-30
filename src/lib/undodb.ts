/* Database-definition edits become undoable (docs/undo.md §6.7).

   What a database IS — one property's definition, the database's icon, its
   home folder, and the act of creating it — rather than what its rows hold.
   Same discipline as the view-config helpers: each edit is a whole-object
   replace, so the inverse is the whole prior object, and the guard baseline
   is read out of the write's own response rather than out of what the UI
   asked for (the engine drops a `target` off a non-relation, canonicalizes a
   number format, and clamps a lead time, so the request and the stored truth
   are routinely different objects).

   `vault_schema_set` carries one trap worth naming: its `notify`,
   `notifyBefore` and `review` arguments all mean "leave the stored one alone"
   when omitted. An inverse that spelled out only the fields it wanted back
   would silently KEEP the alert and the review window the edit had just
   turned on. So every write from here spells all three out — `false`, `0` and
   `""` are how the vault is told to clear them — which is also why the whole
   prior entry, not a delta, is what these helpers hold. */

import { propSchemaFor, typeSchemaFor } from "./schemalookup.ts";
import { typeIcon } from "./dbicons.ts";
import {
  vaultCreateType,
  vaultSchemaHomeSet,
  vaultSchemaRead,
  vaultSchemaSet,
  vaultSchemaSetIcon,
} from "./ipc.ts";
import type { DbIcon, NewTypeProp, PropSchema, SchemaConfig } from "./types.ts";
import { typeHome } from "./types.ts";
import { sameConfig, type UndoScope } from "./undo.ts";
import type { UndoRecorder } from "./undoprops.ts";

/** What a schema entry names as the thing it would rewrite. The watcher never
    reports `.vault/` as a note path, so this is inert against path-scoped
    invalidation and only the whole-stack sweep reaches it. */
export const SCHEMA_CONFIG_PATH = ".vault/schema.json";

type Common = {
  record: UndoRecorder;
  adopt: (cfg: SchemaConfig) => void;
  /** pre-minted (undo.nextUndoId()) when a toast's Undo button must run the
      very entry ⌘Z would run */
  id?: number;
  label?: string;
  scope?: UndoScope;
};

/** The refusal every inverse here raises when the schema moved under it —
    the `conflict:` prefix is what the runner reads as "it changed on disk". */
function moved(what: string): Error {
  return new Error(`conflict: ${what} changed since`);
}

/** One property's whole definition as a single `vault_schema_set` call.
    `null` is the property's absence: an empty option list with no kind is how
    the vault is told to drop the entry, which makes "put it back" and "take
    it away" the same call with different arguments. */
export function schemaSetFromProp(
  db: string,
  prop: string,
  ps: PropSchema | null
): Promise<SchemaConfig> {
  if (!ps) return vaultSchemaSet(db, prop, [], undefined, false, 0, undefined, undefined, "", "");
  return vaultSchemaSet(
    db,
    prop,
    ps.options ?? [],
    ps.kind,
    // spelled out rather than omitted — see the header: omitting these keeps
    // whatever the edit being undone put there
    ps.notify ?? false,
    ps.notifyBefore ?? 0,
    ps.type,
    ps.format,
    ps.description ?? "",
    ps.review ?? "",
    ps.kind === "rollup" && ps.relation && ps.prop && ps.agg
      ? { relation: ps.relation, prop: ps.prop, agg: ps.agg }
      : null
  );
}

/** A property's definition, resolved the way every schema reader resolves
    one (type and prop both case-folded), or null when it isn't there. */
export function propIn(cfg: SchemaConfig, db: string, prop: string): PropSchema | null {
  return propSchemaFor(cfg, db, prop) ?? null;
}

/** One property's definition: kind, options, alert, lead time, target,
    format, description, review window, rollup wiring — added, edited, or
    removed. The caller has already written it and passes the config the write
    returned, so `after` is the stored truth the guard compares against. */
export function recordSchemaPropUndo(
  opts: Common & {
    db: string;
    prop: string;
    /** the whole prior entry; null when this action added the property */
    before: PropSchema | null;
    /** the config `vault_schema_set` returned */
    cfg: SchemaConfig;
  }
): void {
  const { db, prop, before, cfg, record, adopt } = opts;
  const after = propIn(cfg, db, prop);
  if (sameConfig(before, after)) return;
  const write = (want: PropSchema | null, expected: PropSchema | null) => async () => {
    if (!sameConfig(propIn(await vaultSchemaRead(), db, prop), expected))
      throw moved(`“${prop}”`);
    adopt(await schemaSetFromProp(db, prop, want));
  };
  record({
    id: opts.id,
    // an add is not an edit: "Undid Edit “owner”" for a property that did not
    // exist a second ago names something the user never did
    label: opts.label ?? (after ? (before ? `Edit “${prop}”` : `Add “${prop}”`) : `Remove “${prop}”`),
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [SCHEMA_CONFIG_PATH],
    undo: write(before, after),
    redo: write(after, before),
  });
}

/** A database's icon — the whole icon each write, null for none. */
export function recordSchemaIconUndo(
  opts: Common & { db: string; before: DbIcon | null; cfg: SchemaConfig }
): void {
  const { db, before, cfg, record, adopt } = opts;
  const after = typeIcon(typeSchemaFor(cfg, db)) ?? null;
  if (sameConfig(before, after)) return;
  const write = (want: DbIcon | null, expected: DbIcon | null) => async () => {
    if (!sameConfig(typeIcon(typeSchemaFor(await vaultSchemaRead(), db)) ?? null, expected))
      throw moved("the database icon");
    adopt(await vaultSchemaSetIcon(db, want));
  };
  record({
    id: opts.id,
    label: opts.label ?? (after ? "Database icon" : "Remove database icon"),
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [SCHEMA_CONFIG_PATH],
    undo: write(before, after),
    redo: write(after, before),
  });
}

/** A database's home folder — the switch that moves it between the Folders
    tree and the flat database list. The inverse can legitimately be REFUSED:
    a folder may only be one database's home, so if another database took the
    old folder in the meantime the engine says no. That is a plain failure,
    not a disk conflict — the entry goes stale with the engine's own words and
    the stack moves on rather than retrying into the same wall. */
export function recordSchemaHomeUndo(
  opts: Common & {
    db: string;
    before: string | null;
    cfg: SchemaConfig;
    /** the gesture this write belongs to (undo.nextUndoGroup()), when the
        caller writes another store in the same breath — re-homing a HIDDEN
        database also reveals it, and the two are one ⌘Z */
    group?: number;
  }
): void {
  const { db, before, cfg, record, adopt } = opts;
  const after = typeHome(typeSchemaFor(cfg, db)) ?? null;
  if (before === after) return;
  const write = (want: string | null, expected: string | null) => async () => {
    if ((typeHome(typeSchemaFor(await vaultSchemaRead(), db)) ?? null) !== expected)
      throw moved("the home folder");
    adopt(await vaultSchemaHomeSet(db, want));
  };
  record({
    id: opts.id,
    label: opts.label ?? (after ? `Home “${db}” in “${after}”` : `Unhome “${db}”`),
    scope: opts.scope ?? "vault",
    group: opts.group,
    at: Date.now(),
    paths: [SCHEMA_CONFIG_PATH],
    undo: write(before, after),
    redo: write(after, before),
  });
}

/** Creating a database. Undo takes the definition back out the only way that
    is safe to do automatically: drop the home, then drop each property the
    create declared, which retires the type entry once nothing is left. It
    never touches notes — so it refuses outright once the database has rows,
    because a definition removed out from under existing notes is a data loss
    with an undo's face on it. Emptying a database that already has rows is
    "Delete database", a swept action that stays off the stack (§4). */
export function recordCreateTypeUndo(
  opts: Common & {
    db: string;
    props: NewTypeProp[];
    /** the home the create landed on, if any — it goes back on redo */
    home: string | null;
    cfg: SchemaConfig;
    /** how many notes claim this database right now (undo's refusal check) */
    countNotes: () => Promise<number>;
  }
): void {
  const { db, props, home, cfg, record, adopt, countNotes } = opts;
  if (!typeSchemaFor(cfg, db)) return;
  record({
    id: opts.id,
    label: opts.label ?? `Create database “${db}”`,
    scope: opts.scope ?? "vault",
    at: Date.now(),
    paths: [SCHEMA_CONFIG_PATH],
    undo: async () => {
      const notes = await countNotes();
      if (notes > 0)
        throw new Error(
          `“${db}” has ${notes} ${notes === 1 ? "note" : "notes"} now — delete the database instead`
        );
      /* Check-then-act on the WHOLE definition, not merely on the database
         still existing. A property added since — by hand, by a later edit —
         is not this entry's to delete, and stripping only the ones the create
         declared leaves a half database standing while the undo reports it
         took the create back. Either way the honest answer is to refuse. */
      if (!sameConfig(typeSchemaFor(await vaultSchemaRead(), db), typeSchemaFor(cfg, db)))
        throw moved(`“${db}”`);
      /* Removals are one call per property, so a failure lands mid-strip:
         what came out goes back before the error leaves, or the create's undo
         has itself become the edit nobody asked for. */
      const removed: string[] = [];
      let homeDropped = false;
      try {
        let latest = await vaultSchemaHomeSet(db, null);
        homeDropped = true;
        for (const p of props) {
          latest = await schemaSetFromProp(db, p.name, null);
          removed.push(p.name);
        }
        adopt(latest);
      } catch (e) {
        adopt(await restoreCreatedType(db, cfg, removed, homeDropped ? home : null));
        throw e;
      }
    },
    redo: async () => {
      let latest = await vaultCreateType(db, props);
      if (home) latest = await vaultSchemaHomeSet(db, home);
      adopt(latest);
    },
  });
}

/** Best effort after a create-undo stopped mid-strip: put the properties it
    already removed back as they were declared, and the home with them. Each
    is tried on its own so one refusal doesn't strand the rest, and nothing
    here throws — the caller is already carrying the real error. The returned
    config is whatever the schema reads as afterwards, so the UI shows what
    actually stands rather than the half-stripped state the failure left. */
async function restoreCreatedType(
  db: string,
  cfg: SchemaConfig,
  removed: string[],
  home: string | null
): Promise<SchemaConfig> {
  for (const name of removed) {
    const want = propIn(cfg, db, name);
    if (!want) continue;
    try {
      await schemaSetFromProp(db, name, want);
    } catch {
      // nothing further to try for this one
    }
  }
  if (home !== null) {
    try {
      await vaultSchemaHomeSet(db, home);
    } catch {
      // the folder may be another database's home by now — the props matter more
    }
  }
  try {
    return await vaultSchemaRead();
  } catch {
    return cfg;
  }
}
