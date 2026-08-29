import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  vaultClearProp,
  vaultCreate,
  vaultCreateFolder,
  vaultCreateType,
  vaultDeleteType,
  vaultList,
  vaultRenameProp,
  vaultRenameType,
  vaultSchemaHomeSet,
  vaultSchemaSet,
} from "../lib/ipc";
import { foldedPropKey, foldedPropStr } from "../lib/types";
import type { NewTypeProp, NoteMeta, SchemaConfig, View } from "../lib/types";
import { byFoldedKey, typeSchemaFor } from "../lib/schemalookup";
import {
  deleteDbOutcome,
  renameDbOutcome,
  renamePropOutcome,
  schemaOnlyClearOutcome,
  stripPropOutcome,
  snapshotRestore,
  withSnapshotWarning,
} from "../lib/sweep";
import { pickCsvFile } from "../lib/csvpick";
import type { CsvEntry } from "../lib/csvimport";
import { parseCsv } from "../lib/sheet";
import { errText } from "../lib/errtext";
import { recordCreateTypeUndo } from "../lib/undodb";
import type { UndoRecorder } from "../lib/undoprops";
import type { ToastAction } from "./useToast";

/** what the admin lane needs from the rest of App */
type DbAdminDeps = {
  notes: NoteMeta[];
  folders: string[];
  schema: SchemaConfig;
  setSchema: Dispatch<SetStateAction<SchemaConfig>>;
  setView: Dispatch<SetStateAction<View>>;
  refresh: () => void;
  showToast: (msg: string, action?: ToastAction) => void;
  reloadDbMeta: () => void;
  reloadSidebarOrder: () => void;
  presweepSnapshot: (label: string) => Promise<boolean>;
  /** open the vault history, where the pre-sweep snapshot is the newest point */
  restoreFromSnapshot: () => void;
  /** the stored (user-authored) casing of a database / property name */
  schemaDbKey: (db: string) => string;
  schemaPropKey: (db: string, prop: string) => string;
  /** the session undo stack's write end */
  record: UndoRecorder;
};

/**
 * Database administration: which admin dialog is open, the CSV import waiting
 * on one, and every act those dialogs confirm — create, import, rename and
 * delete a database, rename, remove and strip a property.
 *
 * Each sweep opens with a snapshot and each partial sweep rejects rather than
 * toasts, so the count survives in the dialog's inline error instead of
 * vanishing with a 4s toast. That contract lives with the handlers.
 */
export function useDbAdmin(deps: DbAdminDeps) {
  const {
    notes,
    folders,
    schema,
    setSchema,
    setView,
    refresh,
    showToast,
    reloadDbMeta,
    reloadSidebarOrder,
    presweepSnapshot,
    restoreFromSnapshot,
    schemaDbKey,
    schemaPropKey,
    record,
  } = deps;

  // Database management: which admin dialog is open (null = none);
  // create's fromSidebar marks the Folders "+" entry point — the new db is
  // homed into the tree on creation; homeFolder is the folder
  // menu's "Open as database…" birth — the new db homes on that
  // exact folder instead of an eponymous root
  const [dbDialog, setDbDialog] = useState<
    | { kind: "create"; fromSidebar?: boolean; homeFolder?: string }
    | { kind: "rename-db"; dbType: string }
    | { kind: "delete-db"; dbType: string }
    | { kind: "rename-prop"; dbType: string; prop: string }
    | {
        kind: "strip-prop";
        dbType: string;
        prop: string;
        count: number;
        wasNumber: boolean;
      }
    | null
  >(null);
  // CSV import: the picked, parsed file waiting on the import dialog
  const [csvImport, setCsvImport] = useState<{ fileName: string; rows: string[][] } | null>(null);

  const createDatabase = useCallback(
    (name: string, props: NewTypeProp[], homeInTree?: boolean, homeFolder?: string): Promise<void> =>
      vaultCreateType(name, props).then(async (cfg) => {
        setSchema(cfg);
        setDbDialog(null);
        const type = name.trim();
        // born from the Folders "+": the db lands in the tree
        // immediately — a root folder named like its sidebar label becomes
        // its home, created now or REUSED when one already exists
        // (never "Name 2"); engine refusals surface as THE toast (the plain
        // "created" one would replace it unseen), the db itself still stands.
        // A folder's "Open as database…" skips the eponymous-root
        // dance: homeFolder IS the home, it already exists.
        let homeErr: string | null = null;
        let home: string | null = null;
        let latest = cfg;
        if (homeFolder) {
          try {
            latest = await vaultSchemaHomeSet(type, homeFolder);
            home = homeFolder;
            setSchema(latest);
            refresh();
          } catch (e) {
            homeErr = errText(e);
          }
        } else if (homeInTree) {
          const label = type.charAt(0).toUpperCase() + type.slice(1);
          try {
            const existing = folders.find(
              (f) => !f.includes("/") && f.toLowerCase() === label.toLowerCase()
            );
            home = existing ?? (await vaultCreateFolder(label));
            latest = await vaultSchemaHomeSet(type, home);
            setSchema(latest);
            refresh();
          } catch (e) {
            homeErr = errText(e);
          }
        }
        /* ⌘Z takes the definition back out — the home first, then each
           property, which retires the type entry once nothing is left. A
           folder created for the home stays: it is a folder now, and the
           user may already have put something in it. */
        recordCreateTypeUndo({
          db: type,
          props,
          home,
          cfg: latest,
          countNotes: async () =>
            (await vaultList()).filter(
              (n) => foldedPropStr(n.props, "type")?.toLowerCase() === type.toLowerCase()
            ).length,
          record,
          adopt: setSchema,
        });
        setView({ kind: "db", type });
        showToast(homeErr ?? `Database “${type}” created`);
      }),
    [showToast, folders, refresh, record]
  );

  // CSV import: pick → parse → dialog. The dialog's confirm creates
  // the type through the same vault_create_type path as "New database", then
  // one vault_create per row — best-effort per row, so a title the engine
  // guards skips that row instead of aborting the whole import
  const openCsvImport = useCallback(() => {
    pickCsvFile()
      .then((picked) => {
        if (!picked) return;
        const rows = parseCsv(picked.text);
        if (rows.length === 0) {
          showToast(`${picked.name} has no rows`);
          return;
        }
        setCsvImport({ fileName: picked.name, rows });
      })
      .catch((e) => showToast(errText(e)));
  }, [showToast]);

  const importCsv = useCallback(
    (name: string, props: NewTypeProp[], entries: CsvEntry[]): Promise<void> =>
      vaultCreateType(name, props)
        .then((cfg) => setSchema(cfg))
        .then(async () => {
          let imported = 0;
          let failed = 0;
          for (const e of entries) {
            try {
              await vaultCreate(e.title, undefined, name, e.props);
              imported++;
            } catch (rowErr) {
              failed++;
              console.error(`csv import: row "${e.title}" failed:`, rowErr);
            }
          }
          setCsvImport(null);
          setView({ kind: "db", type: name.trim() });
          refresh();
          showToast(
            failed > 0
              ? `Imported ${imported} ${imported === 1 ? "entry" : "entries"} — ${failed} skipped`
              : `Imported ${imported} ${imported === 1 ? "entry" : "entries"}`
          );
        }),
    [refresh, showToast]
  );

  const renameDatabase = useCallback(
    (dbType: string, newName: string): Promise<void> =>
      presweepSnapshot(`before rename database ${dbType}`).then((snapped) => {
        const storedDb = schemaDbKey(dbType);
        return vaultRenameType(storedDb, newName).then((sweep) => {
          // a partial sweep still changed the vault, so both paths refresh
          reloadDbMeta();
          refresh();
          // the engine retargets a key bound to this database
          reloadSidebarOrder();
          if (sweep.failed) {
            // the rename did NOT land (the type keeps its old name) and notes
            // were partially retyped — that message must outlive a 4s toast,
            // so it rejects back into the dialog's persistent inline error
            // surface, which stays open exactly as it did pre
            return Promise.reject(
              withSnapshotWarning(renameDbOutcome(dbType, newName, sweep), snapped)
            );
          }
          setDbDialog(null);
          // an open database view follows the rename
          setView((v) =>
            v.kind === "db" && v.type.toLowerCase() === dbType.toLowerCase()
              ? { kind: "db", type: newName }
              : v
          );
          showToast(
            withSnapshotWarning(renameDbOutcome(dbType, newName, sweep), snapped),
            snapshotRestore(snapped, restoreFromSnapshot)
          );
        });
      }),
    [presweepSnapshot, restoreFromSnapshot, reloadDbMeta, refresh, reloadSidebarOrder, showToast, schemaDbKey]
  );

  const deleteDatabase = useCallback(
    (dbType: string, trashNotes: boolean): Promise<void> =>
      presweepSnapshot(`before delete database ${dbType}`).then((snapped) => {
        const storedDb = schemaDbKey(dbType);
        return vaultDeleteType(storedDb, trashNotes).then((sweep) => {
          // a partial sweep still changed the vault, so both paths refresh
          reloadDbMeta();
          refresh();
          // …and drops it when the database goes
          reloadSidebarOrder();
          if (sweep.failed) {
            // the database survives a sweep that failed partway; the partial
            // count must outlive a 4s toast, so it rejects into the dialog's
            // inline error surface (the dialog stays open)
            return Promise.reject(
              withSnapshotWarning(deleteDbOutcome(dbType, trashNotes, sweep), snapped)
            );
          }
          setDbDialog(null);
          setView((v) =>
            v.kind === "db" && v.type.toLowerCase() === dbType.toLowerCase()
              ? { kind: "notes" }
              : v
          );
          showToast(
            withSnapshotWarning(deleteDbOutcome(dbType, trashNotes, sweep), snapped),
            snapshotRestore(snapped, restoreFromSnapshot)
          );
        });
      }),
    [presweepSnapshot, restoreFromSnapshot, reloadDbMeta, refresh, reloadSidebarOrder, showToast, schemaDbKey]
  );

  const renameProperty = useCallback(
    (dbType: string, prop: string, newName: string): Promise<void> =>
      presweepSnapshot(`before rename property ${dbType}.${prop}`).then((snapped) => {
        const storedDb = schemaDbKey(dbType);
        const storedProp = schemaPropKey(dbType, prop);
        return vaultRenameProp(storedDb, storedProp, newName).then((sweep) => {
          // a partial sweep still changed the vault, so both paths refresh
          reloadDbMeta();
          refresh();
          if (sweep.failed) {
            // the schema key never moved — the partial message outlives a 4s
            // toast by rejecting into the dialog's inline error (stays open,
            // the pre-change failure behavior)
            return Promise.reject(
              withSnapshotWarning(renamePropOutcome(prop, newName, sweep), snapped)
            );
          }
          setDbDialog(null);
          showToast(
            withSnapshotWarning(renamePropOutcome(prop, newName, sweep), snapped),
            snapshotRestore(snapped, restoreFromSnapshot)
          );
        });
      }),
    [presweepSnapshot, restoreFromSnapshot, reloadDbMeta, refresh, showToast, schemaDbKey, schemaPropKey]
  );

  // remove property = instant schema demote; the value strip is a separate,
  // separately-confirmed sweep offered only when notes actually carry values
  const removeProperty = useCallback(
    (dbType: string, prop: string) => {
      const storedDb = schemaDbKey(dbType);
      const storedProp = schemaPropKey(dbType, prop);
      const count = notes.filter(
        (n) =>
          foldedPropStr(n.props, "type")?.toLowerCase() === dbType.toLowerCase() &&
          Object.prototype.hasOwnProperty.call(n.props, foldedPropKey(n.props, prop))
      ).length;
      const wasNumber = byFoldedKey(typeSchemaFor(schema, storedDb), storedProp)?.kind === "number";
      // Not undoable on purpose: the demotion is the head of a value strip
      // the user confirms next, and an inverse that put the definition back
      // while the values were already swept would restore a column that
      // means something different from the one it replaced. Taking this back
      // is a snapshot restore (docs/undo.md §4).
      vaultSchemaSet(storedDb, storedProp, [])
        .then((cfg) => {
          setSchema(cfg);
          if (count > 0)
            setDbDialog({ kind: "strip-prop", dbType: storedDb, prop: storedProp, count, wasNumber });
          else
            // There are no note values to confirm destructively, but the
            // backend still has to drop saved-view query/column references.
            vaultClearProp(storedDb, storedProp, wasNumber, false)
              .then((sweep) => {
                const outcome = schemaOnlyClearOutcome(prop, sweep);
                if (!outcome.completed) {
                  // The schema demotion already landed. Keep that local state
                  // and report the metadata failure without reloading stale
                  // saved views or claiming the whole removal completed.
                  showToast(outcome.message);
                  return;
                }
                reloadDbMeta();
                showToast(outcome.message);
              })
              .catch((e) => showToast(errText(e)));
        })
        .catch((e) => showToast(errText(e)));
    },
    [notes, reloadDbMeta, schema, showToast, schemaDbKey, schemaPropKey]
  );

  const stripPropValues = useCallback(
    (dbType: string, prop: string, wasNumber: boolean): Promise<void> =>
      presweepSnapshot(`before strip ${dbType}.${prop} values`).then((snapped) => {
        const storedDb = schemaDbKey(dbType);
        const storedProp = schemaPropKey(dbType, prop);
        return vaultClearProp(storedDb, storedProp, wasNumber, true).then((sweep) => {
          // a partial sweep still changed the vault, so both paths refresh
          reloadDbMeta();
          refresh();
          if (sweep.failed) {
            // partial count outlives the toast via the dialog's inline error
            return Promise.reject(
              withSnapshotWarning(stripPropOutcome(prop, sweep), snapped)
            );
          }
          setDbDialog(null);
          showToast(
            withSnapshotWarning(stripPropOutcome(prop, sweep), snapped),
            snapshotRestore(snapped, restoreFromSnapshot)
          );
        });
      }),
    [presweepSnapshot, restoreFromSnapshot, reloadDbMeta, refresh, showToast, schemaDbKey, schemaPropKey]
  );

  return {
    dbDialog,
    setDbDialog,
    csvImport,
    setCsvImport,
    createDatabase,
    openCsvImport,
    importCsv,
    renameDatabase,
    deleteDatabase,
    renameProperty,
    removeProperty,
    stripPropValues,
  };
}
