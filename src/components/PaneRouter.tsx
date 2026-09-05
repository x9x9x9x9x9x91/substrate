import { lazy, Suspense } from "react";
import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { byFoldedKey } from "../lib/schemalookup";
import type { SavedView, View } from "../lib/types";
import { todayIso } from "../lib/dates";
import { mountStatus } from "../lib/mounts";
import type { useAppSettings } from "../hooks/useAppSettings";
import type { useMobileLayout } from "../hooks/useMobileLayout";
import type { useMounts } from "../hooks/useMounts";
import type { useSearch } from "../hooks/useSearch";
import type { useTimeTravel } from "../hooks/useTimeTravel";
import type { useDbAdmin } from "../hooks/useDbAdmin";
import type { useVaultIndex } from "../hooks/useVaultIndex";
import type AppMenus from "./AppMenus";
import SearchPane from "./SearchPane";
import TrashPane from "./TrashPane";
import ChangelogPane from "./ChangelogPane";
import CookbookPane from "./CookbookPane";
import AssetsPane from "./AssetsPane";
import ShelfPane from "./ShelfPane";
import DoctorPane from "./DoctorPane";
import DbManagerPane from "./DbManagerPane";
import DashboardPane from "./DashboardPane";
import TodayPane from "./TodayPane";
import DbPaneStack from "./DbPaneStack";
import type { DbPaneCtx } from "./DbPaneStack";
import NotePane from "./NotePane";
import ListPane from "./ListPane";
import EmptyState from "./EmptyState";
import { XIcon } from "./Icons";
import { HeroMount, HeroNote, HeroPin } from "./HeroIcons";

/* lazy tier 1 — the route-exclusive panes, none of them on the cold-open path
   (`{kind:"notes"}`). Each is behind a view kind the first paint never
   satisfies, and together they are the bulk of the non-editor bundle:
   CalendarPane 3.2k lines, VaultSyncPane 1.2k, plus the two machine-local
   surfaces below. Every fallback is `null` inside the pane's own container, so
   nothing reflows while the chunk arrives. Deliberately NOT lazy: DatabasePane,
   NotePane and ListPane — they are the cold-open path itself. */
const CalendarPane = lazy(() => import("./CalendarPane"));
const VaultSyncPane = lazy(() => import("./VaultSyncPane"));
/* Lazy for the reason above and one of its own: the browse is the only pane
   that mounts a document viewer, and keeping it off the cold-open path keeps
   the page renderer's import behind two doors rather than one. */
const FilesPane = lazy(() => import("./FilesPane"));

type SearchProps = ComponentProps<typeof SearchPane>;
type DbManagerProps = ComponentProps<typeof DbManagerPane>;
type DashProps = ComponentProps<typeof DashboardPane>;
type CalendarProps = ComponentProps<typeof CalendarPane>;
type StackProps = ComponentProps<typeof DbPaneStack>;
type NoteProps = ComponentProps<typeof NotePane>;
type ListProps = ComponentProps<typeof ListPane>;
/* The receipts peek travels PaneRouter -> App state -> <AppMenus>, which is
   where the peek's shape is declared; reading the setter off there is what
   makes a change to that shape a compile error on the side that opens it. */
type MenusProps = ComponentProps<typeof AppMenus>;

type AppSettings = ReturnType<typeof useAppSettings>;
type DbAdmin = ReturnType<typeof useDbAdmin>;
type MobileLayout = ReturnType<typeof useMobileLayout>;
type Mounts = ReturnType<typeof useMounts>;
type Search = ReturnType<typeof useSearch>;
type TimeTravel = ReturnType<typeof useTimeTravel>;
type VaultIndex = ReturnType<typeof useVaultIndex>;

/** The view-kind switch: one arm per pane the main column can hold.
 *
 *  WHY THIS EXISTS. Every new pane used to insert an arm into a 500-line
 *  ternary sitting in the middle of App's render — one of the file's measured
 *  conflict magnets, because a branch adding a view and a branch editing the
 *  note split collided over the same region for no reason beyond adjacency.
 *  Here an arm is a self-contained edit, and App's render is left with the
 *  chrome around it.
 *
 *  The prop bag is wide on purpose: the arms are moved verbatim, handlers and
 *  all, so nothing about what a pane receives changed with the move. Types are
 *  read off the panes' own props (and off the hooks that own the state), so a
 *  signature change downstream is a compile error here rather than a silent
 *  drift.
 *
 *  This is a MODULE-level component, never one declared inside App's body: a
 *  component identity that changes each render would remount every pane on
 *  every App state change, throwing away scroll, selection and pane-local
 *  state. `paneRouterRoundTrip.component.test.ts` pins that. */
export interface PaneRouterProps
  extends Pick<VaultIndex, "notes" | "setNotes" | "vaultEpoch" | "changedPaths" | "refresh">,
    Pick<MobileLayout, "mobile" | "mobilePane" | "setMobilePane" | "showMobileDetail">,
    Pick<
      Search,
      | "searchQuery"
      | "setSearchQuery"
      | "searchRestore"
      | "setSearchRestore"
      | "closeSearch"
      | "openSearchHit"
      | "reveal"
      | "onNoteEscape"
    >,
    Pick<
      Mounts,
      | "mounts"
      | "activeMount"
      | "mountNotes"
      | "mountReveal"
      | "mountOpen"
      | "mountWriteProp"
      | "locateMount"
      | "openDatabase"
    >,
    Pick<AppSettings, "showAppFiles" | "taskStaleChips" | "autoSync" | "setAutoSync" | "numberLocale">,
    Pick<TimeTravel, "timePoint"> {
  /* ----- the view itself ----- */
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  selected: string | null;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setOverlay: Dispatch<SetStateAction<null | "palette" | "capture">>;
  showToast: (msg: string) => void;

  /* ----- search / trash / doctor / cookbook ----- */
  recallEnabled: SearchProps["recallEnabled"];
  openPastVersion: SearchProps["onOpenPast"];
  onRowMenu: SearchProps["onRowContextMenu"];

  /* ----- the machine-local surfaces ----- */

  /* ----- databases, dashboards, calendar ----- */
  databases: DbManagerProps["databases"];
  hiddenDbs: DbManagerProps["hiddenDbs"];
  dbIcons: DbManagerProps["icons"];
  schema: DbManagerProps["schema"];
  dbManagerMenu: DbManagerProps["onRowMenu"];
  setDbDialog: DbAdmin["setDbDialog"];
  dashMeta: DashProps["meta"] | null;
  savedViews: DashProps["savedViews"];
  viewsConfig: DashProps["viewPrefs"];
  pageStepRef: DashProps["pageStepRef"];
  dashUndo: DashProps["dashUndo"];
  embedEdit: DashProps["embedEdit"];
  openNote: DashProps["onOpenSource"];
  followLink: NonNullable<DashProps["onFollowLink"]>;
  openEmbedView: DashProps["onOpenView"];
  createEntry: NonNullable<DashProps["onCreateEntry"]>;
  calNewSeq: CalendarProps["newSignal"];
  trashNote: CalendarProps["onTrashNote"];
  renameNote: NonNullable<StackProps["onRenameNote"]>;
  openJournal: CalendarProps["onOpenJournal"];
  upcomingDock: CalendarProps["upcomingDock"];

  /* ----- the three database mounts ----- */
  dbPaneCtx: DbPaneCtx;
  mountPrefChange: StackProps["onPrefChange"];
  openMountRow: StackProps["onOpenNote"];
  mountRowMenu: StackProps["onNoteMenu"];
  onTrashMountRows: StackProps["onTrashNotes"];
  viewNotes: StackProps["notes"];
  dbPrefChange: StackProps["onPrefChange"];
  onCellMenu: StackProps["onCellMenu"];
  trashNotes: StackProps["onTrashNotes"];
  dbNote: string | null;
  setDbNote: Dispatch<SetStateAction<string | null>>;
  dbNewSeq: StackProps["newSignal"];
  activeSaved: SavedView | null;
  savedNotes: StackProps["notes"];
  savedPref: StackProps["pref"];
  setSvPref: StackProps["onPrefChange"];
  savedColumnsChange: StackProps["onColumnsChange"];
  openSavedsDb: StackProps["onOpenDb"];

  /* ----- the two note splits ----- */
  dbNoteMeta: NoteProps["meta"] | null;
  selectedMeta: NoteProps["meta"] | null;
  usedValues: NoteProps["usedValues"];
  saveSchemaProp: NoteProps["onSaveSchema"];
  promoteSchemaOption: NoteProps["onPromoteOption"];
  relCandidates: NoteProps["relationCandidates"];
  dbTypes: NoteProps["dbTypes"];
  dbTypesRecent: NoteProps["dbTypesRecent"];
  noteTitles: NoteProps["noteTitles"];
  linkedNoteBody: NoteProps["linkedNoteBody"];
  sheetTitles: NoteProps["sheetTitles"];
  openTag: NoteProps["onOpenTag"];
  tagCounts: NoteProps["tagUniverse"];
  embedQuery: NoteProps["embedQuery"];
  embedSetProp: NoteProps["onEmbedSetProp"];
  embedCreateEntry: NoteProps["onEmbedCreate"];
  embedCreateRelation: NoteProps["onEmbedCreateRelation"];
  onRenamed: NoteProps["onRenamed"];
  onRenameApplied: NoteProps["onRenameUndone"];
  startMoveToFolder: NoteProps["onMoveToFolder"];
  duplicateNote: NoteProps["onDuplicate"];
  setShare: NoteProps["onShare"];
  togglePickToday: NoteProps["onTogglePick"];
  setPinned: NoteProps["onTogglePin"];
  pinnedPaths: string[];
  flushOpenRef: NoteProps["flushRef"];
  ghostPath: string | null;
  adoptGhost: NoteProps["onGhostCreated"];
  followTyped: NoteProps["onTyped"];
  editorFocusRef: NoteProps["editorFocusRef"];
  noteInsertRef: NoteProps["editorInsertRef"];
  savedViewPins: NoteProps["savedViewPins"];
  dbPropNames: NoteProps["dbPropNames"];
  titleFocusRef: NoteProps["titleFocusRef"];
  clearReveal: NoteProps["onRevealed"];
  sheetReveal: NoteProps["revealRow"];
  clearSheetReveal: NoteProps["onRowRevealed"];
  setReceipts: MenusProps["setReceipts"];
  historyFor: NoteProps["openHistoryFor"];

  /* ----- the default arm: list + note ----- */
  viewRows: { loose: ListProps["notes"]; blocks: ListProps["blocks"] };
  onListOpenDb: ListProps["onOpenDb"];
  onListSelect: ListProps["onSelect"];
  renaming: ListProps["renaming"];
  onListRenameCancel: ListProps["onRenameCancel"];
  onListBgMenu: ListProps["onBackgroundContextMenu"];
  onListActivate: ListProps["onActivate"];
  /* Optional <ListPane> props only the private build carries, spread in as a
     bag. Deliberately NOT read off ListProps like its neighbours: the shared
     build strips those props off the pane, so naming one here would neither
     resolve there nor be publishable — the bag is the same workaround App
     builds it with, and it arrives empty in the shared build. */
  ledgerListProps: Record<string, ReadonlySet<string>>;
  listFolderIcon: ListProps["folderIcon"];
  listSort: ListProps["sort"];
  onListSort: ListProps["onSort"];
  newInFolder: ListProps["onNewHere"];
  createHere: ListProps["onNewNote"];
  tagFolders: ListProps["tagFolders"];
  folderFiles: { files: ListProps["files"]; total: ListProps["fileTotal"] };
  onPlayFile: ListProps["onPlayFile"];
  onOpenFile: ListProps["onOpenFile"];
  onRevealFile: ListProps["onRevealFile"];
}

/** The props the two note splits pass through untouched.
 *
 *  The database pane's side note and the main column's note are the same pane
 *  on a different note: of the ~50 props each takes, only the note itself, the
 *  three things keyed off its path, and the main split's extras (ghost
 *  adoption, the insert and title refs) differ. Spelled out twice, a prop
 *  added to one split silently missed the other; this is the one place both
 *  read from. Pure pass-through — every value is the one App handed the
 *  router, so `<NotePane>`'s memo still sees the references it saw before. */
function sharedNoteProps(p: PaneRouterProps) {
  return {
    schema: p.schema,
    usedValues: p.usedValues,
    vaultEpoch: p.vaultEpoch,
    numberLocale: p.numberLocale,
    changedPaths: p.changedPaths,
    onSaveSchema: p.saveSchemaProp,
    onPromoteOption: p.promoteSchemaOption,
    relationCandidates: p.relCandidates,
    onCreateEntry: p.createEntry,
    dbTypes: p.dbTypes,
    dbTypesRecent: p.dbTypesRecent,
    onFollowLink: p.followLink,
    noteTitles: p.noteTitles,
    vaultNotes: p.notes,
    linkedNoteBody: p.linkedNoteBody,
    sheetTitles: p.sheetTitles,
    onOpenTag: p.openTag,
    tagUniverse: p.tagCounts,
    onOpenNote: p.openNote,
    embedQuery: p.embedQuery,
    onOpenView: p.openEmbedView,
    onEmbedSetProp: p.embedSetProp,
    onEmbedCreate: p.embedCreateEntry,
    onEmbedCreateRelation: p.embedCreateRelation,
    onRenamed: p.onRenamed,
    onRenameUndone: p.onRenameApplied,
    onMutated: p.refresh,
    onTrash: p.trashNote,
    onMoveToFolder: p.startMoveToFolder,
    onDuplicate: p.duplicateNote,
    onShare: p.setShare,
    onTogglePick: p.togglePickToday,
    onTogglePin: p.setPinned,
    flushRef: p.flushOpenRef,
    onTyped: p.followTyped,
    onJournalDay: p.openJournal,
    editorFocusRef: p.editorFocusRef,
    savedViewPins: p.savedViewPins,
    dbPropNames: p.dbPropNames,
    onEscape: p.onNoteEscape,
    reveal: p.reveal,
    onRevealed: p.clearReveal,
    revealRow: p.sheetReveal,
    onRowRevealed: p.clearSheetReveal,
    onToast: p.showToast,
    readOnly: p.timePoint !== null,
    openHistoryFor: p.historyFor,
  } satisfies Partial<NoteProps>;
}

export default function PaneRouter(props: PaneRouterProps) {
  const {
    view,
    setView,
    selected,
    setSelected,
    setOverlay,
    showToast,
    notes,
    setNotes,
    vaultEpoch,
    refresh,
    mobile,
    mobilePane,
    setMobilePane,
    showMobileDetail,
    searchQuery,
    setSearchQuery,
    searchRestore,
    setSearchRestore,
    closeSearch,
    openSearchHit,
    mounts,
    activeMount,
    mountNotes,
    mountReveal,
    mountOpen,
    mountWriteProp,
    locateMount,
    openDatabase,
    showAppFiles,
    taskStaleChips,
    autoSync,
    setAutoSync,
    numberLocale,
    recallEnabled,
    openPastVersion,
    onRowMenu,
    databases,
    hiddenDbs,
    dbIcons,
    schema,
    dbManagerMenu,
    setDbDialog,
    dashMeta,
    savedViews,
    viewsConfig,
    pageStepRef,
    dashUndo,
    embedEdit,
    openNote,
    followLink,
    openEmbedView,
    createEntry,
    calNewSeq,
    trashNote,
    renameNote,
    openJournal,
    upcomingDock,
    dbPaneCtx,
    mountPrefChange,
    openMountRow,
    mountRowMenu,
    onTrashMountRows,
    viewNotes,
    dbPrefChange,
    onCellMenu,
    trashNotes,
    dbNote,
    setDbNote,
    dbNewSeq,
    activeSaved,
    savedNotes,
    savedPref,
    setSvPref,
    savedColumnsChange,
    openSavedsDb,
    dbNoteMeta,
    selectedMeta,
    pinnedPaths,
    ghostPath,
    adoptGhost,
    noteInsertRef,
    titleFocusRef,
    setReceipts,
    viewRows,
    listSort,
    onListSort,
    onListOpenDb,
    onListSelect,
    renaming,
    onListRenameCancel,
    onListBgMenu,
    onListActivate,
    ledgerListProps,
    listFolderIcon,
    newInFolder,
    createHere,
    tagFolders,
    folderFiles,
    onPlayFile,
    onOpenFile,
    onRevealFile,
  } = props;

  return (
    <>
      {view.kind === "search" ? (
        <div className="main">
          <SearchPane
            notes={notes}
            // a hit inside a mounted file names no note — its mount is what
            // makes it renderable
            mounts={mounts}
            excludeAppFiles={!showAppFiles}
            query={searchQuery}
            setQuery={setSearchQuery}
            onOpenMatch={openSearchHit}
            onClose={closeSearch}
            restoreSel={searchRestore}
            onRestoredSel={() => setSearchRestore(null)}
            onRowContextMenu={onRowMenu}
            recallEnabled={recallEnabled}
            onOpenPast={openPastVersion}
          />
        </div>
      ) : view.kind === "trash" ? (
        <div className="main">
          <TrashPane
            vaultEpoch={vaultEpoch}
            onRestored={(m) => {
              // seed the restored note into state before the async refresh so
              // the selection effect finds it and keeps it selected
              setNotes((ns) => [...ns.filter((n) => n.path !== m.path), m]);
              setView({ kind: "all" });
              setSelected(m.path);
              showMobileDetail();
              refresh();
            }}
            onRestoredFolder={(path) => {
              setView({ kind: "folder", path });
              setMobilePane("list");
              refresh();
            }}
          />
        </div>
      ) : view.kind === "vaultsync" ? (
        <div className="main">
          <Suspense fallback={null}>
            <VaultSyncPane autoSync={autoSync} onAutoSyncChange={setAutoSync} />
          </Suspense>
        </div>
      ) : view.kind === "changelog" ? (
        <div className="main">
          <ChangelogPane
          />
        </div>
      ) : view.kind === "cookbook" ? (
        <div className="main">
          <CookbookPane
            onOpenNote={(path) => {
              // the install just wrote it, so the index doesn't carry it yet.
              // Select only once the refreshed list holds it, or the
              // selection-guard snaps straight back to the old top row. "all"
              // is the one view guaranteed to contain it whatever folder it
              // went to.
              setView({ kind: "all" });
              refresh().then(() => {
                setSelected(path);
                showMobileDetail();
              });
            }}
          />
        </div>
      ) : view.kind === "assets" ? (
        <div className="main">
          <AssetsPane vaultEpoch={vaultEpoch} />
        </div>
      ) : view.kind === "files" ? (
        <div className="main">
          <Suspense fallback={null}>
            <FilesPane view={view} setView={setView} vaultEpoch={vaultEpoch} />
          </Suspense>
        </div>
      ) : view.kind === "shelf" || view.kind === "drive" ? (
        <div className="main">
          {/* One pane for both: a drive's catalog is the shelf zoomed in, and
              splitting them would double the staleness copy that is the whole
              point of the surface. */}
          <ShelfPane view={view} setView={setView} vaultEpoch={vaultEpoch} />
        </div>
      ) : view.kind === "doctor" ? (
        <div className="main">
          <DoctorPane
            vaultEpoch={vaultEpoch}
            onOpenNote={(path) => {
              // leave the report to show the note itself — "all" is the one
              // view guaranteed to contain it whatever folder it lives in
              setView({ kind: "all" });
              setSelected(path);
              showMobileDetail();
            }}
          />
        </div>
      ) : view.kind === "dbmanager" ? (
        <div className="main">
          <DbManagerPane
            databases={databases}
            hiddenDbs={hiddenDbs}
            icons={dbIcons}
            schema={schema}
            onOpen={openDatabase}
            onRowMenu={dbManagerMenu}
            onNewDatabase={() => setDbDialog({ kind: "create" })}
          />
        </div>
      ) : view.kind === "dashboard" && dashMeta ? (
        <div className="main">
          <DashboardPane
            meta={dashMeta}
            notes={notes}
            vaultEpoch={vaultEpoch}
            schema={schema}
            savedViews={savedViews}
            // the databases' display prefs, for a vault kind's `ctx.view`: the
            // pin is composed over the same pref the database pane composes it
            // over, so a kind's table sections where the pane's does
            viewPrefs={viewsConfig}
            onOpenSource={openNote}
            onMutated={refresh}
            onFollowLink={followLink}
            onOpenView={openEmbedView}
            onToast={showToast}
            onCreateEntry={createEntry}
            pageStepRef={pageStepRef}
            dashUndo={dashUndo}
            taskStaleChips={taskStaleChips}
            embedEdit={embedEdit}
          />
        </div>
      ) : view.kind === "today" ? (
        <div className="main">
          <TodayPane
            notes={notes}
            schema={schema}
            icons={dbIcons}
            onOpenNote={openNote}
            onOpenJournal={() => openJournal(todayIso())}
            onMutated={refresh}
            onToast={showToast}
            onRowContextMenu={onRowMenu}
          />
        </div>
      ) : view.kind === "calendar" ? (
        <div className="main">
          <Suspense fallback={null}>
          <CalendarPane
            notes={notes}
            schema={schema}
            newSignal={calNewSeq}
            onOpenNote={openNote}
            onMutated={refresh}
            onTrashNote={trashNote}
            onToast={showToast}
            onRenameNote={renameNote}
            onOpenJournal={openJournal}
            upcomingDock={upcomingDock}
          />
          </Suspense>
        </div>
      ) : view.kind === "mount" ? (
        <div className="main">
          {activeMount ? (
            // A mounted folder is a database whose rows are files.
            // Same pane, same layouts, same views — the only differences are
            // where the rows come from (the mount's index, not the note list),
            // where a cell write lands (`mount_annotate`), and the banner that
            // appears when the folder isn't reachable from this machine.
            <div className="db-mount">
              {mountStatus(activeMount) && (
                <div className="mount-banner">
                  <span>{mountStatus(activeMount)}</span>
                  <button className="mount-locate" onClick={() => locateMount(activeMount)}>
                    Locate folder…
                  </button>
                </div>
              )}
              <DbPaneStack
                key={view.id}
                ctx={dbPaneCtx}
                dbType={activeMount.name}
                notes={mountNotes}
                pref={byFoldedKey(viewsConfig, activeMount.name)}
                // the row a search hit arrived on — marked as the
                // open one, and revealed (scrolled to, focused) once the
                // board's rows are in
                openPath={
                  mountReveal?.path ??
                  (mountOpen?.id === activeMount.id ? mountOpen.path : null)
                }
                reveal={mountReveal}
                newSignal={0}
                onPrefChange={mountPrefChange}
                // a row IS a file: opening one opens the file, and its cell
                // writes go through the mount's own annotate path
                onOpenNote={openMountRow}
                onNoteMenu={mountRowMenu}
                writeProp={mountWriteProp}
                // rows are the folder's contents — nothing here trashes a file
                onTrashNotes={onTrashMountRows}
              />
            </div>
          ) : (
            <div className="db">
              {/* No verb here yet: remounting is the Databases pane's verb, not
                  one this pane can run — glyph + text until copy work lands. */}
              <EmptyState
                icon={<HeroMount />}
                title="Mounted folder not found"
                hint="It may have been unmounted in another window"
              />
            </div>
          )}
        </div>
      ) : view.kind === "db" || view.kind === "saved" ? (
        <div className={`main${mobile && dbNoteMeta ? " mobile-detail" : ""}`}>
          {view.kind === "db" ? (
            <DbPaneStack
              key={view.type}
              ctx={dbPaneCtx}
              dbType={view.type}
              notes={viewNotes}
              pref={byFoldedKey(viewsConfig, view.type)}
              openPath={dbNote}
              newSignal={dbNewSeq}
              numberLocale={numberLocale}
              onPrefChange={dbPrefChange}
              onOpenNote={openNote}
              onNoteMenu={onRowMenu}
              onCellMenu={onCellMenu}
              onTrashNotes={trashNotes}
              onRenameNote={renameNote}
            />
          ) : activeSaved ? (
            <DbPaneStack
              key={`sv:${activeSaved.id}`}
              ctx={dbPaneCtx}
              dbType={activeSaved.db}
              notes={savedNotes}
              // A pin's pref is composed in ONE place (`savedViewPref`), the
              // same call a headless reader of the same pin makes: the pin's
              // own layout, grouping and sort over the database's, the
              // presentation keys no pin captures (aggregations, widths,
              // wrap, grid) following the database, and the database's
              // curation — hidden sets, dragged column order — staying out.
              // Until it is re-saved, `svPref` holds the session's edits.
              pref={savedPref}
              openPath={dbNote}
              newSignal={dbNewSeq}
              numberLocale={numberLocale}
              onPrefChange={setSvPref}
              onOpenNote={openNote}
              onNoteMenu={onRowMenu}
              onCellMenu={onCellMenu}
              onTrashNotes={trashNotes}
              onRenameNote={renameNote}
              initialQuery={activeSaved.query}
              initialColumns={activeSaved.columns}
              onColumnsChange={savedColumnsChange}
              saveViewSeed={activeSaved.name}
              activeViewId={activeSaved.id}
              onOpenDb={openSavedsDb}
            />
          ) : (
            <div className="db">
              {/* No verb here yet: the pin is gone, and re-pinning happens on
                  the view it came from, so there is none to offer here. */}
              <EmptyState
                icon={<HeroPin />}
                title="Saved view not found"
                hint="The pin may have been removed outside the app"
              />
            </div>
          )}
          {dbNoteMeta && (
            <div className="db-note">
              <button className="db-note-x" onClick={() => setDbNote(null)} title="Close (Esc)">
                <XIcon />
              </button>
              <NotePane
                meta={dbNoteMeta}
                {...sharedNoteProps(props)}
                pinned={pinnedPaths.includes(dbNoteMeta.path)}
                onReceipts={(key, anchor) => setReceipts({ path: dbNoteMeta.path, key, anchor })}
              />
            </div>
          )}
        </div>
      ) : (
      <div className="main">
        {(!mobile || mobilePane === "list") && (
        <ListPane
          notes={viewRows.loose}
          blocks={viewRows.blocks}
          icons={dbIcons}
          onOpenDb={onListOpenDb}
          view={view}
          selected={selected}
          onSelect={onListSelect}
          renaming={renaming}
          onRenameNote={renameNote}
          onRenameCancel={onListRenameCancel}
          onRowContextMenu={onRowMenu}
          onBackgroundContextMenu={onListBgMenu}
          onActivate={onListActivate}
          {...ledgerListProps}
          folderIcon={listFolderIcon}
          sort={listSort}
          onSort={onListSort}
          onNewHere={newInFolder}
          onNewNote={createHere}
          tagFolders={tagFolders}
          mobile={mobile}
          files={folderFiles.files}
          fileTotal={folderFiles.total}
          onPlayFile={onPlayFile}
          onOpenFile={onOpenFile}
          onRevealFile={onRevealFile}
        />
        )}
        {(!mobile || mobilePane === "detail") && (selectedMeta ? (
          <NotePane
            meta={selectedMeta}
            {...sharedNoteProps(props)}
            pinned={pinnedPaths.includes(selectedMeta.path)}
            onReceipts={(key, anchor) => setReceipts({ path: selectedMeta.path, key, anchor })}
            ghost={selectedMeta.path === ghostPath}
            onGhostCreated={adoptGhost}
            editorInsertRef={noteInsertRef}
            titleFocusRef={titleFocusRef}
          />
        ) : (
          <div className="note">
            <EmptyState
              icon={<HeroNote />}
              title="No note selected"
              hint="⌘K to find something, ⌘N to capture"
              /* the ⌘K half of the hint, made clickable — same overlay the
                 shortcut opens, under the shortcut registry's own label */
              action={{ label: "Command palette", onClick: () => setOverlay("palette") }}
            />
          </div>
        ))}
      </div>
      )}
    </>
  );
}
