import { useCallback, useMemo } from "react";
import type { ComponentProps } from "react";
import type { DbIcon, SavedView } from "../lib/types";
import { typeSchemaFor } from "../lib/schemalookup";
import { iconForType } from "../lib/dbicons";
import DatabasePane from "./DatabasePane";

type PaneProps = ComponentProps<typeof DatabasePane>;

/** Everything the three database call sites pass *identically* — either a
 *  literal shared value, or a handler whose only per-site difference is the
 *  database name it is bound to.
 *
 *  WHY THIS EXISTS. The three `DatabasePane` mounts (a mounted folder, a plain
 *  database, an open pin) shared ~35 of their 37–44 props, spelled out three
 *  times. That made them the file's worst measured conflict magnet: one recent
 *  branch added the same prop at five call sites in a single merge, so every
 *  parallel branch touching a pane prop collided. Collected here, a new shared
 *  prop is written once and the call sites keep only what differs.
 *
 *  It is also what makes `memo(DatabasePane)` more than decoration. The
 *  per-database closures (`onSaveIcon`, `onRenameProp`, the filtered pin list,
 *  the `?? {}` type-schema fallback) used to be fresh literals in App's render,
 *  so the pane's props changed identity on every unrelated App state change and
 *  a memo boundary would have been a silent no-op. Derived here from `ctx` plus
 *  `dbType`, they keep identity for as long as their real inputs do.
 *
 *  Types are read off `DatabasePane`'s own props rather than re-typed, so a
 *  signature change there is a compile error here instead of a silent drift. */
export interface DbPaneCtx
  extends Pick<
    PaneProps,
    | "allNotes"
    | "schema"
    | "relationCandidates"
    | "onCreateEntry"
    | "dbTypes"
    | "exportRef"
    | "gridDefault"
    | "onMutated"
    | "pinKeys"
    | "onOpenView"
    | "onViewMenu"
    | "onToast"
  > {
  /** every pin in the vault — narrowed to this database's inside */
  savedViews: SavedView[];
  /** the whole icon map — narrowed to this database's inside */
  dbIcons: Record<string, DbIcon>;
  onSaveIcon: (dbType: string, ...rest: Parameters<PaneProps["onSaveIcon"]>) => void;
  usedValues: (dbType: string, ...rest: Parameters<PaneProps["usedValues"]>) => string[];
  onSaveSchema: (dbType: string, ...rest: Parameters<PaneProps["onSaveSchema"]>) => void;
  onPromoteOption: (
    dbType: string,
    ...rest: Parameters<NonNullable<PaneProps["onPromoteOption"]>>
  ) => void | Promise<void>;
  onSaveView: (dbType: string, ...rest: Parameters<PaneProps["onSaveView"]>) => void;
  onRenameDb: (dbType: string) => void;
  onDeleteDb: (dbType: string) => void;
  onRenameProp: (dbType: string, prop: string) => void;
  onRemoveProp: (dbType: string, prop: string) => void;
  onSetParentProp: (dbType: string, prop: string | null) => void;
}

/** The half that genuinely differs between the three mounts: which rows, which
    pref, what a row click does, and the pin-only extras. */
export interface DbPaneStackProps
  extends Pick<
    PaneProps,
    | "dbType"
    | "notes"
    | "pref"
    | "openPath"
    | "reveal"
    | "newSignal"
    | "numberLocale"
    | "onPrefChange"
    | "onOpenNote"
    | "onNoteMenu"
    | "onCellMenu"
    | "onTrashNotes"
    | "onRenameNote"
    | "writeProp"
    | "initialQuery"
    | "initialColumns"
    | "onColumnsChange"
    | "saveViewSeed"
    | "activeViewId"
    | "onOpenDb"
  > {
  ctx: DbPaneCtx;
}

/** One database pane, with the shared prop belt resolved from `ctx`. */
export default function DbPaneStack({ ctx, dbType, ...site }: DbPaneStackProps) {
  const {
    savedViews,
    dbIcons,
    onSaveIcon,
    usedValues,
    onSaveSchema,
    onPromoteOption,
    onSaveView,
    onRenameDb,
    onDeleteDb,
    onRenameProp,
    onRemoveProp,
    onSetParentProp,
    ...shared
  } = ctx;

  // `typeSchemaFor` misses on an unknown database, and the `?? {}` fallback
  // used to be a fresh literal per render — on its own enough to defeat the
  // memo boundary this component exists to make real.
  const typeSchema = useMemo(
    () => typeSchemaFor(shared.schema, dbType) ?? {},
    [shared.schema, dbType]
  );
  const icon = useMemo(() => iconForType(dbIcons, dbType), [dbIcons, dbType]);
  const dbSavedViews = useMemo(
    () => savedViews.filter((v) => v.db.toLowerCase() === dbType.toLowerCase()),
    [savedViews, dbType]
  );

  const bindSaveIcon = useCallback<PaneProps["onSaveIcon"]>(
    (...a) => onSaveIcon(dbType, ...a),
    [onSaveIcon, dbType]
  );
  const bindUsedValues = useCallback<PaneProps["usedValues"]>(
    (...a) => usedValues(dbType, ...a),
    [usedValues, dbType]
  );
  const bindSaveSchema = useCallback<PaneProps["onSaveSchema"]>(
    (...a) => onSaveSchema(dbType, ...a),
    [onSaveSchema, dbType]
  );
  const bindPromoteOption = useCallback<NonNullable<PaneProps["onPromoteOption"]>>(
    (...a) => onPromoteOption(dbType, ...a),
    [onPromoteOption, dbType]
  );
  const bindSaveView = useCallback<PaneProps["onSaveView"]>(
    (...a) => onSaveView(dbType, ...a),
    [onSaveView, dbType]
  );
  const bindRenameDb = useCallback(() => onRenameDb(dbType), [onRenameDb, dbType]);
  const bindDeleteDb = useCallback(() => onDeleteDb(dbType), [onDeleteDb, dbType]);
  const bindRenameProp = useCallback(
    (prop: string) => onRenameProp(dbType, prop),
    [onRenameProp, dbType]
  );
  const bindRemoveProp = useCallback(
    (prop: string) => onRemoveProp(dbType, prop),
    [onRemoveProp, dbType]
  );
  const bindSetParentProp = useCallback(
    (prop: string | null) => onSetParentProp(dbType, prop),
    [onSetParentProp, dbType]
  );

  return (
    <DatabasePane
      {...shared}
      {...site}
      dbType={dbType}
      typeSchema={typeSchema}
      icon={icon}
      savedViews={dbSavedViews}
      onSaveIcon={bindSaveIcon}
      usedValues={bindUsedValues}
      onSaveSchema={bindSaveSchema}
      onPromoteOption={bindPromoteOption}
      onSaveView={bindSaveView}
      onRenameDb={bindRenameDb}
      onDeleteDb={bindDeleteDb}
      onRenameProp={bindRenameProp}
      onRemoveProp={bindRemoveProp}
      onSetParentProp={bindSetParentProp}
    />
  );
}
