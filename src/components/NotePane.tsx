import type { NumberLocale } from "../lib/numberLocale";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { NoteMeta, FmState, NumberFormat, PropKind, PropSchema, PropValue, RelatedEntry, RollupConfig, SchemaConfig, SelectOption, TagCount } from "../lib/types";
import { foldedPropKey, foldedPropStr, propStr } from "../lib/types";
import type { PendingProps, PendingWrite } from "../lib/pendingprops";
import { NO_PENDING, addPending, applyPendingTo, dropPending, prunePending, settlePending } from "../lib/pendingprops";
import type { EmbedResult, ViewSpecResult } from "../lib/embeds";
import {
  fileOpen,
  onHistoryLeave,
  pathExists,
  sheetSetColumnNotify,
  vaultBacklinks,
  vaultCreate,
  vaultFmRaw,
  vaultLockSealedNote,
  vaultRead,
  vaultRelated,
  vaultResolve,
  vaultRoot,
  vaultWriteBody,
} from "../lib/ipc";
import { setPropUndoable } from "../lib/undoprops";
import { isPickedToday } from "../lib/today";
import { useTodayIso } from "./useTodayIso";
import { renameUndoable, recordCreate } from "../lib/undostruct";
import { onRenameAnnounce } from "../lib/renamebus";
import { useUndo } from "../lib/undoContext";
import { isTauri } from "../lib/tauri";
import { makeFxResolver } from "../lib/fx";
import { hasExecutableCalcLine } from "../lib/calc";
import { liveExprMatches } from "../lib/livevalues";
import { ensureFxRates, useFxRates } from "./useFx";
import { useLiveValues } from "./useLiveValues";
import { exportNoteMarkdown, exportNoteOneSheet, exportNotePdf } from "../lib/export";
import { buildNoteActions } from "../lib/noteactions";
import { formatDateHuman, shiftDate } from "../lib/dates";
import { formatNumber, formatDateTimeHuman } from "../lib/display";
import { normalizeNumberInput } from "../lib/aggregate";
import { basename } from "../lib/files";
import { contactHref, urlDisplayTitle } from "../lib/url";
import { dailyDateOf, humanDate, JOURNAL_DIR } from "../lib/journal";
import { entriesForNote } from "../lib/calendar";
import { iconForType, iconsByType, resolveIcon } from "../lib/dbicons";
import { orderedPropKeys } from "../lib/proporder";
import { byFoldedKey, typeSchemaFor } from "../lib/schemalookup";
import { templateTypeOf } from "../lib/templates";
import {
  chipCommitValue,
  propList,
  propListValue,
  relatedGroups,
  toggleValue,
  type RelationCandidate,
} from "../lib/relation";
import Editor from "./Editor";
import HistoryPanel from "./HistoryPanel";
import FmRepairDialog from "./FmRepairDialog";
import SealedNoteDialog, { type SealedNoteMode } from "./SealedNoteDialog";
import TypeIcon from "./TypeIcon";
import SheetGrid from "./SheetGrid";
import { parseColumnNotify } from "../lib/sheetnotify";
import type { SheetRowTarget } from "../hooks/useVaultEvents";
import DateMenu from "./DateMenu";
import FileMenu from "./FileMenu";
import RelationMenu from "./RelationMenu";
import SelectMenu, { anchorFrom, MultiValues, optionColor, OptionPill, type AnchorRect } from "./SelectMenu";
import { ChipReceiptLine } from "./ReceiptsPeek";
import { prefetchFact } from "./useHistory";
import DotsMenu from "./DotsMenu";
import { BacklinkIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, FileIcon, LockIcon, NoteActionGlyph, XIcon } from "./Icons";
import EmptyState from "./EmptyState";

/** url/email/phone-kind chips open outside the app — the OS handler (browser,
    mail, phone) in Tauri, a new tab in the browser/mock lane (Editor's
    lane split). */
function openExternalLink(url: string) {
  if (isTauri) openUrl(url).catch(console.error);
  else window.open(url, "_blank");
}

/** "3 releases point here" — naive plural, good enough for database names. */
function pluralType(dbType: string, count: number): string {
  if (count === 1) return dbType;
  return dbType.endsWith("y") ? `${dbType.slice(0, -1)}ies` : `${dbType}s`;
}

/** Property rows in table order (lib/proporder.ts): Database first, then
    schema order, unschema'd alphabetical, created/updated pinned last. */
function chipEntries(
  props: Record<string, unknown>,
  typeSchema?: Record<string, PropSchema>
): [string, string][] {
  return orderedPropKeys(props, typeSchema).map((k) => [k, propStr(props, k) ?? ""]);
}

// the typed engine errors of write_body, matched by prefix —
// the mock backend throws the same strings (src/lib/tauri.ts)
const isConflictErr = (e: unknown) =>
  String(e instanceof Error ? e.message : e).startsWith("conflict:");
const isGoneErr = (e: unknown) =>
  String(e instanceof Error ? e.message : e).startsWith("note no longer exists");
// The note's identity is no longer authorized in this session — the
// only save failure a user can fix themselves, by unlocking again.
const isSealedLockedErr = (e: unknown) =>
  String(e instanceof Error ? e.message : e).startsWith("sealed: locked");

/* Unsaved text whose write failed for a note that is no longer open,
   by path. The pane holds exactly one `pending` buffer and the next keystroke
   overwrites it, so text belonging to a note the user has left has nowhere to
   live — it used to be dropped silently. Reopening the note takes it back
   (the load effect), and the toast the failure raises offers the same trip.
   Module scope, not a ref: App remounts NotePane on some navigations, and a
   buffer surviving the pane is the entire point. */
const orphanedEdits = new Map<string, string>();

/** Drop every orphaned buffer. Called when the app leaves the past —
    text captured while a historical projection was on screen belongs to a
    body that no longer exists, and reopening the note in the present would
    otherwise adopt the past text and save it over the live file. Losing a
    genuinely-live orphan here is the safe trade: leaving the past already
    reloads every pane from disk. */
export function dropOrphanedEdits() {
  orphanedEdits.clear();
}
onHistoryLeave(dropOrphanedEdits);

/** the note's own name, for a message about a note that isn't on screen */
const titleOf = (path: string) => path.replace(/^.*\//, "").replace(/\.md$/, "");

interface NotePaneProps {
  meta: NoteMeta;
  schema: SchemaConfig;
  usedValues: (dbType: string, key: string) => string[];
  vaultEpoch: number;
  /** `number-locale`: the dialect the body editor's calc lines
      write numbers in — the app-wide one, read from Settings.md by App. */
  numberLocale?: NumberLocale;
  /** The paths behind the current `vaultEpoch` bump, or null for
      "unknown — could be anything". */
  changedPaths?: string[] | null;
  onSaveSchema: (
    dbType: string,
    prop: string,
    options: SelectOption[],
    kind: PropKind | null,
    notify?: boolean,
    notifyBefore?: number,
    target?: string,
    format?: NumberFormat,
    description?: string,
    rollup?: RollupConfig | null
  ) => void;
  /** entries of a relation's target database (picker source) */
  relationCandidates: (dbType: string) => RelationCandidate[];
  /** create a new entry of a database inline from the relation picker */
  onCreateEntry: (dbType: string, title: string) => Promise<NoteMeta>;
  /** all database types — the schema editor's relation target picker */
  dbTypes: string[];
  /** the same types ranked most-recently-filed first — the "which database
      does this note belong to" pickers only; other lists keep `dbTypes` */
  dbTypesRecent?: string[];
  onFollowLink: (name: string) => void;
  /** all note titles — [[ wikilink completion in the body editor */
  noteTitles: string[];
  /** An inline `#tag` was clicked — open its collection */
  onOpenTag?: (tag: string) => void;
  /** The vault's tags with counts — `#` completion in the editor */
  tagUniverse?: TagCount[];
  onOpenNote: (path: string) => void;
  /** ```view embeds: resolve a fence spec to its table model */
  embedQuery?: (spec: ViewSpecResult) => EmbedResult;
  /** ```view embeds: header click opens the database */
  onOpenView?: (dbType: string, savedId?: string) => void;
  /** ```view embeds: commit one cell through the app's undoable write */
  onEmbedSetProp?: (path: string, key: string, value: PropValue) => void;
  /** ```view embeds: the fence's "+ New" row */
  onEmbedCreate?: (dbType: string, seedProps: [string, string][], query: string) => void;
  /** ```view embeds: a relation cell's create-and-link */
  onEmbedCreateRelation?: (
    path: string,
    key: string,
    targetType: string,
    title: string
  ) => void;
  onRenamed: (oldPath: string, meta: NoteMeta) => void;
  /** Repair lane for an UNDONE/REDONE rename — App announces the
      move to mounted panes (no-remount relabel) and follows the note only
      when it was selected, unlike onRenamed's unconditional select. */
  onRenameUndone?: (oldPath: string, meta: NoteMeta) => void;
  onMutated: () => void;
  /** Trash this note — App's single trash path (flush + delete +
      toast with Undo); the pane flushes its own pending save first */
  onTrash?: (path: string) => void;
  /** Open the palette's folder picker for this note */
  onMoveToFolder?: (note: NoteMeta) => void;
  /** Duplicate this note in place — App creates the copy, opens it
      and toasts "Duplicated" */
  onDuplicate?: (note: NoteMeta) => void;
  /** Open the Send-as-link dialog for this note */
  onSendAsLink?: (note: NoteMeta) => void;
  /** Pick this note for today (or unpick it) from the ⋯ menu —
      the Today surface's verb reaching the note that is open. The pane reads
      the picked state off the note itself, so it needs no second prop. */
  onTogglePick?: (path: string, pick: boolean) => void;
  /** Put this note in (or take it out of) the sidebar's Pinned
      section; `pinned` flips the ⋯ menu's label */
  onTogglePin?: (path: string, pinned: boolean) => void;
  pinned?: boolean;
  /** The pane registers its flush-and-settle here: App-level actions
      (Duplicate/trash) and the scratch-abandon lane await it
      before touching the file — pending buffer flushed, every in-flight
      write landed */
  flushRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  /** A ghost daily — the dated surface exists on screen but not on
      disk; the first keystroke creates the file (never mere navigation) */
  ghost?: boolean;
  /** the ghost's file just got created from typed text — adopt the meta */
  onGhostCreated?: (meta: NoteMeta) => void;
  /** a `type` commit re-homed the note into a database — follow it */
  onTyped?: (meta: NoteMeta) => void;
  /** open (creating if needed) the daily note for a YYYY-MM-DD date */
  onJournalDay?: (date: string) => void;
  editorFocusRef: React.MutableRefObject<(() => void) | null>;
  /** registered as focus+select on the title input (⌘N instant scratch note) */
  titleFocusRef?: React.MutableRefObject<(() => void) | null>;
  /** Esc in the note's own surfaces (title input, editor) — App's
      scratch-abandon and search-return lanes */
  onEscape?: (path: string) => void;
  /** scroll-to + flash a body line after opening from search */
  reveal?: { path: string; line: number; nonce: number } | null;
  onRevealed?: () => void;
  /** the row a sheet notification's click named — same shape of
      target as `reveal`, but a grid cell rather than a body line */
  revealRow?: (SheetRowTarget & { nonce: number }) | null;
  onRowRevealed?: () => void;
  /** transient user-facing errors (e.g. oversized paste) ride the app toast.
      The action form is also used for a save that failed on a note the
      user has already left — the only surface left for it */
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
  /** The note on screen is a historical projection — the body
      editor is read-only for the duration (the app-root input guard misses
      CodeMirror's own keymap commands). */
  readOnly?: boolean;
  /** Receipts (spec §6): a chip asked who changed this fact — App owns
      the peek, because a row in it scrubs the whole vault. Absent means the
      surface offers no receipts (the glyph and the editor line stay away). */
  onReceipts?: (key: string, anchor: AnchorRect) => void;
  /** The receipts peek's "Open note history" landed on this note — App
      bumps the nonce, the pane opens its own history panel. */
  openHistoryFor?: { path: string; nonce: number } | null;
}

function NotePane({
  meta,
  schema,
  usedValues,
  vaultEpoch,
  numberLocale,
  changedPaths = null,
  onSaveSchema,
  relationCandidates,
  onCreateEntry,
  dbTypes,
  dbTypesRecent,
  onFollowLink,
  noteTitles,
  onOpenTag,
  tagUniverse,
  onOpenNote,
  embedQuery,
  onOpenView,
  onEmbedSetProp,
  onEmbedCreate,
  onEmbedCreateRelation,
  onRenamed,
  onRenameUndone,
  onMutated,
  onTrash,
  onMoveToFolder,
  onDuplicate,
  onSendAsLink,
  onTogglePick,
  onTogglePin,
  pinned = false,
  flushRef,
  ghost = false,
  onGhostCreated,
  onTyped,
  onJournalDay,
  editorFocusRef,
  titleFocusRef,
  onEscape,
  reveal,
  onRevealed,
  revealRow,
  onRowRevealed,
  onToast,
  readOnly = false,
  onReceipts,
  openHistoryFor = null,
}: NotePaneProps) {
  const undo = useUndo();
  const todayIso = useTodayIso();
  // docPath is the identity the mounted editor is keyed under (docKey). It
  // tracks path except across the pane's own title rename, where it keeps the
  // pre-rename value so the editor does NOT remount: the body didn't
  // change, only the path label, and the remount's async gap (teardown →
  // vaultRead → mount → focus restore) drops keystrokes typed into it.
  const [loaded, setLoaded] = useState<{ path: string; docPath: string; body: string } | null>(
    null
  );
  const liveBody = loaded?.path === meta.path ? loaded.body : null;
  // A live value may convert currency too, so an inline `= expr`
  // span earns the rate table on the same terms a calc line does. Memoised
  // because the match now parses each candidate: it is a body-sized scan, not
  // a render-sized one.
  const hasLiveExpr = useMemo(
    () => liveBody !== null && liveExprMatches(liveBody).length > 0,
    [liveBody]
  );
  const calcNeeded =
    (loaded?.path === meta.path && hasExecutableCalcLine(loaded.body)) || hasLiveExpr;
  // calc lines: live rates for `= 25 USD in EUR`; the resolver is
  // null-safe (no table yet → the quiet per-line dash, never a wrong number).
  // Ordinary prose keeps this disabled, so opening a note cannot phone out:
  // both triggers require executable syntax the writer opted into — a calc
  // line, or a `` `= expr` `` span in the one documented form that also
  // parses as a formula. Prose that merely mentions a spreadsheet
  // (`` `=SUM(A1:A2)` ``) is not a match and fetches no rates.
  const { fx: fxRatesState } = useFxRates(calcNeeded);
  const calcFx = useMemo(() => makeFxResolver(fxRatesState), [fxRatesState]);
  // the sheets this note's inline `= expr` spans read — same loader
  // and same vault-epoch invalidation the dashboard bindings use
  const liveSheets = useLiveValues(liveBody, vaultEpoch, meta.path, fxRatesState);
  const [diskProps, setDiskProps] = useState<Record<string, unknown>>({});
  // Property writes in flight, laid over disk truth so a committed
  // chip paints the frame it closes instead of a beat later, when the write
  // resolves. Same overlay the database pane got (lib/pendingprops)
  // — `pending` above is the body-save buffer, an unrelated thing.
  const [pendingProps, setPendingProps] = useState<PendingProps>(NO_PENDING);
  const props = useMemo(
    () => applyPendingTo(meta.path, diskProps, pendingProps),
    [meta.path, diskProps, pendingProps]
  );
  // the note the overlay belongs to. Only this pane's own re-reads can retire
  // an entry, and they carry the OPEN note alone — so switching notes has to
  // abandon what's left rather than pin it over the next note's props.
  const pendingPropsPath = useRef(meta.path);
  useEffect(() => {
    if (pendingPropsPath.current !== meta.path) {
      pendingPropsPath.current = meta.path;
      setPendingProps(NO_PENDING);
      return;
    }
    setPendingProps((cur) => prunePending(cur, [{ path: meta.path, props: diskProps }]));
  }, [meta.path, diskProps]);
  const [backlinks, setBacklinks] = useState<NoteMeta[]>([]);
  const [related, setRelated] = useState<RelatedEntry[]>([]);
  const [editingChip, setEditingChip] = useState<string | null>(null);
  // chip whose kind/options editor was opened from a date/file menu
  const [schemaEditChip, setSchemaEditChip] = useState<string | null>(null);
  const [chipAnchor, setChipAnchor] = useState<AnchorRect | null>(null);
  // file-kind chip targets: value → does it exist on disk (broken-link state)
  const [fileOk, setFileOk] = useState<Record<string, boolean>>({});
  const [chipDraft, setChipDraft] = useState("");
  const [addingChip, setAddingChip] = useState(false);
  // + property committed a bare `type` — the database picker is open
  const [typePick, setTypePick] = useState(false);
  const [titleDraft, setTitleDraft] = useState(meta.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  // Last body-write failure — shown inline until a write succeeds
  const [saveError, setSaveError] = useState<string | null>(null);
  // Last prop-write failure — same inline pill as body saves; the
  // attempted write is held (failedProp) so the pill's click retries it
  const [propError, setPropError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  // The file vanished with unsaved text in the buffer — the pane
  // stays up (text recoverable) under a gone banner, not the empty state
  const [fileGone, setFileGone] = useState(false);
  // A flush hit an external change — the banner offers reload/overwrite
  const [conflict, setConflict] = useState(false);
  // The open note's raw frontmatter block + health. error != null
  // shows the repair banner — read() strips the block, so this is the only
  // in-app sight of a malformed one
  const [fmState, setFmState] = useState<FmState | null>(null);
  const [fmRepair, setFmRepair] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // the receipts peek's footer door: App names the note and bumps a nonce,
  // and the pane opens the same history panel its clock button does
  const historyNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!openHistoryFor || openHistoryFor.path !== meta.path) return;
    if (historyNonce.current === openHistoryFor.nonce) return;
    historyNonce.current = openHistoryFor.nonce;
    setShowHistory(true);
  }, [openHistoryFor, meta.path]);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [sealedUnlocked, setSealedUnlocked] = useState(false);
  const [sealedOverride, setSealedOverride] = useState<boolean | null>(null);
  const [sealedDialog, setSealedDialog] = useState<SealedNoteMode | null>(null);
  const isSealed = sealedOverride ?? !!meta.sealed;
  // Does THIS pane hold the engine's authorization for this note? The engine
  // counts holders, so a pane must release exactly what it took: a
  // pane that never unlocked — a plaintext note, or a second surface that only
  // read — releasing on teardown would revoke the identity another open pane
  // is still editing with.
  const sealedHeld = useRef(false);

  const pending = useRef<{ path: string; body: string } | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  // the prop write that failed — the error pill IS its retry
  const failedProp = useRef<{ key: string; value: string | string[] | boolean | null } | null>(null);
  // same, for the sheet column's notification write — a different
  // shape of write, so the pill needs to know which one to replay
  const failedColumn = useRef<{ column: string; notify: boolean; notifyBefore: number | null } | null>(null);
  // disk-known body of the open note — the expected-body the flush guard passes
  const baseRef = useRef<{ path: string; body: string } | null>(null);
  // in-flight writes count as dirty for the external-reload lane
  const saving = useRef(0);
  // Resolvers parked until the last in-flight write lands — the
  // flushRef settle awaits them before the abandon lane reads disk state
  const settleWaiters = useRef<(() => void)[]>([]);
  // state mirrors for timers/promises, where setters alone would read stale
  const missingRef = useRef(false);
  const fileGoneRef = useRef(false);
  const conflictRef = useRef(false);
  // the note this pane currently shows — async failures from a previous note
  // must not set flags on the new one
  const pathRef = useRef(meta.path);
  pathRef.current = meta.path;
  // Paths open(ed) as ghosts — keyed by path, not a boolean, so the
  // cleanup-flush of a just-left ghost (its text still pending) routes to
  // create even though the pane already shows the next note
  const ghostPaths = useRef<Set<string>>(new Set());
  // only the CURRENT path is (un)marked — a just-left ghost stays in the set
  // so its cleanup flush still routes to create; a path re-opened as a real
  // file sheds any stale mark
  if (ghost) ghostPaths.current.add(meta.path);
  else ghostPaths.current.delete(meta.path);
  // a ghost's create is in flight — later flushes wait instead of duplicating
  const ghostCreating = useRef(false);
  // callback mirror so flush's identity stays pinned to onMutated alone
  const onGhostCreatedRef = useRef(onGhostCreated);
  onGhostCreatedRef.current = onGhostCreated;
  // same reason — the orphan toast reaches App from inside flush
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const onOpenNoteRef = useRef(onOpenNote);
  onOpenNoteRef.current = onOpenNote;
  // set while the editor doc is replaced programmatically (not a user edit)
  const applyingExternal = useRef(false);
  const docReplaceRef = useRef<((body: string) => void) | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  // Where this pane's own title rename moved the open note,
  // written by commitTitle the moment the rename resolves. The load effect
  // consumes it to RELABEL the live state in place instead of tearing down
  // and re-reading: the note's body didn't change, only its path did, so the
  // editor keeps running under its old docKey (loaded.docPath) and no
  // remount happens at all. The first fix let the remount happen and
  // handed focus + the pending buffer across the gap; the CI runs
  // trace) showed the gap itself is the bug — between the old editor's
  // unmount and the deferred focus restore, keystrokes land on <body> and
  // are dropped, and on a loaded machine that window is wide enough to eat
  // real typing. No unmount, no window.
  const renamedTo = useRef<{ from: string; to: string } | null>(null);
  // every from->to this pane's own renames performed, consulted by flush's
  // failure paths: a write launched against the old path that fails AFTER
  // the mv must park/report under the note's live name, or the held text
  // lands behind a key nothing can ever reopen
  const renameAliases = useRef(new Map<string, string>());
  const liveAlias = useCallback((path: string): string => {
    const seen = new Set<string>();
    let p = path;
    while (renameAliases.current.has(p) && !seen.has(p)) {
      seen.add(p);
      p = renameAliases.current.get(p)!;
    }
    return p;
  }, []);
  // a title rename is in flight: the debounce must not flush the body to a
  // path the engine is about to move (the write lands after the mv and dies
  // silently, the failure). commitTitle re-arms the timer on settle,
  // with the buffer re-keyed to wherever the note now lives.
  const renameInFlight = useRef(0);

  // the title analogue of editorFocusRef: focus the title with its text
  // selected, so typing replaces it (fresh scratch notes start "Untitled")
  useEffect(() => {
    if (!titleFocusRef) return;
    titleFocusRef.current = () => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    };
    return () => {
      titleFocusRef.current = null;
    };
  }, [titleFocusRef]);

  // Guarded save: writes carry the disk-known body as the
  // expected-body, so an external change rejects instead of being clobbered.
  // Kept deliberately small — the error-surfacing lane shares this catch path.
  // Resolves after the write has landed (errors are surfaced, not thrown) —
  // teardown paths like Move to Trash await it before destroying the file
  // fire-and-forget callers ignore it.
  const flush = useCallback(
    (force = false): Promise<void> => {
      window.clearTimeout(saveTimer.current);
      const p = pending.current;
      if (!p) return Promise.resolve();
      // an unresolved conflict waits for the user's reload/overwrite pick
      if (conflictRef.current && !force) return Promise.resolve();
      // a gone file is never written again — the buffer stays put
      if (missingRef.current || fileGoneRef.current) return Promise.resolve();
      // A ghost daily has no file — the first flush creates it with
      // the typed text; App adopts the meta and the pane leaves ghost mode
      if (ghostPaths.current.has(p.path)) {
        if (ghostCreating.current) return Promise.resolve(); // create in flight — text is in it
        const date = dailyDateOf(p.path);
        if (!date) return Promise.resolve();
        if (!p.body.trim()) return Promise.resolve(); // whitespace alone doesn't make a file
        ghostCreating.current = true;
        pending.current = null;
        return vaultCreate(date, JOURNAL_DIR, undefined, undefined, p.body)
          .then((m) => {
            ghostPaths.current.delete(p.path);
            if (pathRef.current === p.path) {
              baseRef.current = { path: m.path, body: p.body };
              setDiskProps(m.props);
              // The write path clears this on success and the create
              // path never did — a retried create left the pill armed forever
              setSaveError(null);
            }
            onGhostCreatedRef.current?.(m);
            onMutated();
            ghostCreating.current = false;
            // text typed while the create was in flight goes through the now
            //-normal write path
            if (pending.current?.path === p.path) flush();
          })
          .catch((err) => {
            ghostCreating.current = false;
            if (pathRef.current !== p.path) {
              // The ghost half: same reasoning as the write
              // catch below — the pane has moved on, `pending` belongs to the
              // note on screen, and the next keystroke there would overwrite
              // the text. Park it by path and toast; the load effect's ghost
              // branch takes it back on reopen.
              orphanedEdits.set(p.path, p.body);
              onToastRef.current?.(`Couldn’t save ${titleOf(p.path)} — your text is held`, {
                label: "Reopen",
                run: () => onOpenNoteRef.current(p.path),
              });
              return;
            }
            pending.current = p;
            setSaveError(err instanceof Error ? err.message : String(err));
          });
      }
      pending.current = null;
      saving.current += 1;
      // A keystroke's closure can re-key pending back to a path this
      // pane's own rename already moved — the load effect's fix-up runs after
      // the cleanup flush that grabs the buffer (rig captures: the write goes
      // to the dead path, fails "gone", and its catch used to revert newer
      // text). Write where the note lives NOW.
      const livePath = liveAlias(p.path);
      // guard vs p.path deliberately (not livePath): during a pane-own rename
      // baseRef is already re-keyed to the destination while p.path is the
      // stale closure's key, and the old code shipped that write with NO
      // expected-body — guarding it against the pre-rename baseRef body would
      // newly raise the conflict banner when the rename's link sweep rewrote
      // this note's own body under a dirty buffer
      const expected =
        force || baseRef.current?.path !== p.path ? null : baseRef.current?.body;
      // A failed write must never be silent — surfaced inline and the
      // body stays armed so a click on the error pill (or the next debounced
      // edit) retries the same write. Cleared on the next success.
      return vaultWriteBody(livePath, p.body, expected)
        .then(() => {
          // a write that lands after a note switch must not clobber the new
          // note's base — its disk-known body comes from the load effect.
          // Judged via the rename alias: a write that landed just
          // before this pane's own mv still owns the note's base, under the
          // note's live name — leaving it stale makes the next guarded write
          // conflict against a body the user themselves saved.
          const wrote = liveAlias(p.path);
          if (pathRef.current === wrote) {
            baseRef.current = { path: wrote, body: p.body };
            conflictRef.current = false;
            setConflict(false);
            setSaveError(null);
          }
          onMutated();
        })
        .catch((err) => {
          // a rename that landed while this write was in flight moved the
          // note; judge "has the pane moved on" and park/report under the
          // note's LIVE name, or the text hides behind a dead key
          const wrotePath = liveAlias(p.path);
          if (pathRef.current !== wrotePath) {
            // The pane has moved on, so none of the surfaces below
            // can show this. `pending` must not take the text back either —
            // it is a single slot that now belongs to the note on screen, and
            // the next keystroke there would overwrite it regardless. Park it
            // by path instead and say so on the app toast, the only surface
            // that outlives the note; reopening takes it back (load effect).
            orphanedEdits.set(wrotePath, p.body);
            onToastRef.current?.(`Couldn’t save ${titleOf(wrotePath)} — your text is held`, {
              label: "Reopen",
              run: () => onOpenNoteRef.current(wrotePath),
            });
            return;
          }

          // the buffer goes back to pending — dropping unsaved text silently
          // is worse than holding it (re-keyed to the live name if a rename
          // landed mid-write, so the retry writes where the note now is).
          // Unless a NEWER buffer exists — keystrokes typed while
          // this write was in flight built a doc that already contains this
          // one's text, and restoring the stale snapshot over it is exactly
          // the silent loss (rig captures: disk froze at the rename-moment
          // body, everything typed after was clobbered here).
          if (!pending.current) pending.current = { path: wrotePath, body: p.body };
          if (isSealedLockedErr(err)) {
            // The session lost this note's authorization mid-edit —
            // another surface locked it, or the app was told to forget it. A
            // save-error pill would be a dead end here (every retry fails the
            // same way), so recover to the lock screen: park the text the way
            // the failed-write path does and let unlocking reload it, retry armed.
            //
            // Park the NEWER buffer, never this write's stale snapshot: the
            // restore just above may hold keystrokes typed while this write
            // was in flight, and parking `p.body` over them is the same
            // silent loss the stale-overwrite guard exists to prevent.
            const newer =
              pending.current?.path === wrotePath ? pending.current.body : p.body;
            orphanedEdits.set(wrotePath, newer);
            pending.current = null;
            sealedHeld.current = false;
            setSaveError(null);
            setSealedUnlocked(false);
            onToastRef.current?.("This note locked again — unlock to save your changes");
            return;
          }
          if (isConflictErr(err)) {
            // The file changed under a dirty buffer — user decides
            conflictRef.current = true;
            setConflict(true);
          } else if (isGoneErr(err)) {
            // The file vanished — the pane shows it, the text stays
            fileGoneRef.current = true;
            setFileGone(true);
          } else {
            setSaveError(err instanceof Error ? err.message : String(err));
          }
        })
        .finally(() => {
          saving.current -= 1;
          if (saving.current === 0 && settleWaiters.current.length > 0) {
            const waiters = settleWaiters.current;
            settleWaiters.current = [];
            for (const resolve of waiters) resolve();
          }
        });
    },
    [onMutated]
  );

  // Authorization is scoped to the open note and this mounted pane. Leaving
  // it flushes encrypted edits first, then drops the in-memory identity.
  useEffect(() => {
    setSealedUnlocked(false);
    setSealedDialog(null);
    sealedHeld.current = false;
    return () => {
      // the lock must land even when the final flush rejects — otherwise the
      // engine keeps the identity while every surface shows "locked". Only
      // this pane's own hold is released.
      //
      // The hold is read HERE, synchronously: React runs this cleanup and
      // then the next setup body, which zeroes the ref — and that lands long
      // before the flush's microtask. Reading the ref inside the callback
      // therefore saw `false` on every note-to-note navigation (the pane is
      // un-keyed), so the note stayed authorized in the engine forever.
      const held = sealedHeld.current;
      sealedHeld.current = false;
      const lockPath = meta.path;
      void flush().finally(() => {
        if (!held) return;
        vaultLockSealedNote(lockPath);
      });
    };
  }, [meta.path, flush]);

  useEffect(() => {
    setSealedOverride(null);
  }, [meta.sealed]);

  useEffect(() => {
    // When this meta.path change is the pane's own title
    // rename landing — commitTitle already relabeled loaded/pending/baseRef
    // in the same commit, the mounted editor is still keyed to
    // loaded.docPath, and the note's content is untouched by a rename — skip
    // the teardown+reload entirely (the remount gap is where typed
    // keystrokes died, per the CI trace); only the path-derived sidecars need
    // a refresh. The marker is consumed either way: a meta.path that is NOT
    // the announced destination is a real navigation that voids it.
    const mv = renamedTo.current;
    // consume on match; KEEP while meta.path still names the from side (this
    // run is a reloadNonce bump racing the rename's prop change — voiding
    // here would remount the very rename the marker announces); void on any
    // third path, which is a real navigation.
    if (mv && mv.from !== meta.path) renamedTo.current = null;
    if (mv?.to === meta.path && baseRef.current?.path === meta.path) {
      let gone = false;
      const path = meta.path;
      // the engine may have sanitized the typed title — mirror what it kept
      setTitleDraft(meta.title);
      // the rename succeeding IS proof the note lives at this path. Without
      // the teardown these flags no longer reset here, and one race needs
      // them to: an epoch re-read of the OLD path, in flight when the mv
      // landed, rejects and paints the missing state over a healthy pane.
      missingRef.current = false;
      setMissing(false);
      fileGoneRef.current = false;
      setFileGone(false);
      // ...and an open conflict banner must not survive into the new path:
      // its reload/overwrite buttons would operate on a file that never had
      // the conflicting state, and a truthy conflictRef both suppresses the
      // re-read below and makes flush() refuse the re-keyed buffer forever.
      // A rename is not a navigation, so the buffer is NOT abandoned (the
      // teardown's choice). The dirty buffer keeps the re-read below off
      // baseRef (line-of-guard: pending short-circuits it), so the retry
      // goes out guarded against the PRE-conflict base — a still-divergent
      // disk refuses it and the banner comes back for the same dispute,
      // now under the note's live name. Honest, at the cost of the banner
      // blinking down for the retry round-trip.
      conflictRef.current = false;
      setConflict(false);
      // a keystroke that fired between commitTitle's relabel and this render
      // went through an onBodyChange closure still naming the old path
      if (pending.current?.path === mv.from) {
        pending.current = { ...pending.current, path };
      }
      // any buffer held for this note gets its debounce revived here,
      // unconditionally: React ran the PREVIOUS load effect's cleanup right
      // before this body, and that cleanup's flush() clears the timer on
      // entry — with the conflict lane still set at that instant it exits
      // without writing, so settleRename's re-arm dies silently and the
      // text would sit unsaved until the next keystroke (found by the
      // conflict-rename spec: the honest banner re-raise never came).
      if (pending.current?.path === path) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(flush, 500);
      }
      // the rename's link sweep can rewrite this note's own body too (a
      // self-link) — re-read; a clean buffer adopts the
      // rewrite in place WITHOUT touching docPath (a docKey change here
      // would remount, the exact gap this branch exists to avoid); a dirty
      // buffer keeps the guard path like any external change while typing.
      vaultRead(path).then(
        (c) => {
          if (gone) return;
          setDiskProps(c.props);
          if (pending.current || saving.current > 0 || conflictRef.current) return;
          if (baseRef.current?.path === path && baseRef.current.body === c.body) return;
          baseRef.current = { path, body: c.body };
          setLoaded((l) => (l ? { ...l, body: c.body } : l));
          if (docReplaceRef.current) {
            applyingExternal.current = true;
            docReplaceRef.current(c.body);
            applyingExternal.current = false;
          }
        },
        () => {}
      );
      vaultFmRaw(path)
        .then((fm) => {
          if (!gone) setFmState(fm);
        })
        .catch(() => {});
      vaultBacklinks(path)
        .then((b) => {
          if (!gone) setBacklinks(b);
        })
        .catch(() => {});
      vaultRelated(path)
        .then((r) => {
          if (!gone) setRelated(r);
        })
        .catch(() => {});
      return () => {
        gone = true;
        flush();
      };
    }
    // an unresolved conflict does not follow the user to the next note — the
    // guarded write was refused, so navigating away abandons the buffer
    if (conflictRef.current) pending.current = null;
    conflictRef.current = false;
    missingRef.current = false;
    fileGoneRef.current = false;
    flush();
    setLoaded(null);
    setEditingChip(null);
    setSchemaEditChip(null);
    setAddingChip(false);
    setTitleDraft(meta.title);
    setTitleError(null);
    setMissing(false);
    setFileGone(false);
    setConflict(false);
    setSaveError(null);
    setPropError(null);
    setFmState(null);
    setFmRepair(false);
    failedProp.current = null;
    failedColumn.current = null;
    baseRef.current = null;
    let gone = false;
    const path = meta.path;
    // Review (HIGH): a pane-own rename's alias dies the moment this
    // pane opens the vacated path again — a NEW note can live there now
    // (⌘N reuses freed names), and a surviving alias would silently redirect
    // its saves into the rename's destination: two-note loss. The alias only
    // exists to route stale closures / in-flight failures of the RENAMED
    // note, and those flushed above.
    renameAliases.current.delete(path);
    if (isSealed && !sealedUnlocked) {
      setDiskProps({});
      setBacklinks([]);
      setRelated([]);
      return () => {
        gone = true;
        flush();
      };
    }
    // A ghost daily has nothing to read — seed an empty buffer so
    // the editor renders; the first keystroke's flush creates the file
    if (ghost && ghostPaths.current.has(path)) {
      // This day was left with a failed create and its text parked
      // (the catch in flush). Take it back — a ghost has no disk body, so
      // there's no baseRef to guard against and no conflict lane: the held
      // text simply becomes the buffer, armed under the retry pill, and the
      // next flush routes to create again.
      const held = orphanedEdits.get(path);
      if (held !== undefined) {
        orphanedEdits.delete(path);
        pending.current = { path, body: held };
        setSaveError("this note's last save failed — the text below is unsaved");
      }
      setLoaded({ path, docPath: path, body: held ?? "" });
      setDiskProps({});
      setBacklinks([]);
      setRelated([]);
      return () => {
        gone = true;
        flush();
      };
    }
    vaultRead(path).then(
      (c) => {
        if (gone) return;
        setDiskProps(c.props);
        // This note was left with a failed write, and its text was
        // parked instead of dropped. Take it back: the editor opens on the
        // held text rather than the stale disk body, the retry pill is armed,
        // and baseRef keeps the disk body so the retry writes guarded (an
        // external change since then still surfaces as a conflict). Text that
        // did land after all — the write succeeded on a later attempt — just
        // gets dropped, there is nothing to recover.
        const held = orphanedEdits.get(path);
        if (held !== undefined) {
          orphanedEdits.delete(path);
          if (held !== c.body) {
            baseRef.current = { path, body: c.body };
            pending.current = { path, body: held };
            setLoaded({ path, docPath: path, body: held });
            setSaveError("this note's last save failed — the text below is unsaved");
            return;
          }
        }
        // A reloadNonce remount (history restore) mounts the editor
        // with the pre-read body before this read resolves. When this read
        // wins the race with the vaultEpoch lane, that lane skips its adopt
        // as a false own-echo — the stale doc would stick, and the next save
        // would silently revert the restore (expected body matches disk, no
        // conflict). So a mounted editor on a still-clean buffer adopts in
        // place here — the docReplace itself no-ops when the doc already
        // matches; a dirty or saving buffer keeps
        // the guard path.
        if (
          docReplaceRef.current &&
          !conflictRef.current &&
          !pending.current &&
          saving.current === 0
        ) {
          adoptDiskBody(path, c.body);
          return;
        }
        baseRef.current = { path, body: c.body };
        setLoaded({ path, docPath: path, body: c.body });
      },
      // Two-arg form on purpose. A trailing .catch also catches
      // anything the success handler throws, so an internal React error
      // (a stray update-depth blowup upstream) used to paint the
      // vanished-file empty state and read as data loss. Narrowing by
      // message can't work either — vault.rs read() returns raw io errors,
      // not the "note no longer exists" prefix. Only a rejected read is
      // "gone"; a thrown render error is left to surface as itself.
      () => {
        if (!gone) {
          missingRef.current = true;
          setMissing(true);
        }
      }
    );
    // Frontmatter health rides the note load — quiet like
    // backlinks; a vanished note simply has no banner
    vaultFmRaw(path)
      .then((f) => {
        if (!gone) setFmState(f);
      })
      .catch(() => {
        if (!gone) setFmState(null);
      });
    vaultBacklinks(meta.path)
      .then((b) => {
        if (!gone) setBacklinks(b);
      })
      // quiet but handled: a note that vanished mid-load has no
      // backlinks — clear rather than keep the previous note's, never throw
      .catch(() => {
        if (!gone) setBacklinks([]);
      });
    vaultRelated(meta.path)
      .then((r) => {
        if (!gone) setRelated(r);
      })
      .catch(() => {
        if (!gone) setRelated([]);
      });
    return () => {
      gone = true;
      flush();
    };
  }, [meta.path, reloadNonce, isSealed, sealedUnlocked]);

  // One flush registration serves both App-level consumers: the
  // Duplicate/trash actions and the scratch-abandon lane. Both must
  // observe real quiescence before reading disk state — pending buffer
  // flushed AND every in-flight write landed. The registration intentionally
  // outlives the pane (no cleanup): a just-unmounted pane's final flush must
  // still be awaitable.
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = async () => {
      await flush();
      if (saving.current > 0)
        await new Promise<void>((resolve) => settleWaiters.current.push(resolve));
    };
  }, [flushRef, flush]);

  // The 500ms debounce is a loss window against anything that ends
  // the session without unmounting the pane — quitting, closing the window,
  // the OS terminating us. The quit path is synchronous in Rust (RunEvent::Exit
  // can't await a webview round trip), so the buffer has to already be on its
  // way out by then. Every page-lifecycle signal the webview gets — losing
  // focus, being hidden, being torn down — flushes immediately, which shrinks
  // the window to zero for every gesture that deactivates the app first.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const onAway = () => void flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("blur", onAway);
    window.addEventListener("pagehide", onAway);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("blur", onAway);
      window.removeEventListener("pagehide", onAway);
    };
  }, [flush]);

  const onBodyChange = useCallback(
    (b: string) => {
      // a programmatic doc swap (external reload) is not an edit
      if (applyingExternal.current) return;
      if (hasExecutableCalcLine(b) || liveExprMatches(b).length > 0) ensureFxRates();
      pending.current = { path: meta.path, body: b };
      // the file is gone: keep the text, never schedule a write
      if (missingRef.current || fileGoneRef.current) return;
      // a title rename is moving the file: hold the text, park the
      // debounce — the write would race the mv and land on the dead path.
      // commitTitle re-keys the buffer and re-arms the timer when it settles.
      if (renameInFlight.current) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flush, 500);
    },
    [meta.path, flush]
  );

  // adopt a body read from disk (external change or conflict-reload): editor
  // surfaces swap in place via docReplaceRef — the plain editor, and the sheet
  // grid too (keeps an open cell draft); anything else remounts
  const adoptDiskBody = useCallback((path: string, body: string) => {
    baseRef.current = { path, body };
    // keep the mounted editor's identity when the pane already shows this
    // path — after a rename docPath lags path on purpose, and
    // resetting it here would turn an in-place adopt into a remount
    setLoaded((l) => (l && l.path === path ? { ...l, body } : { path, docPath: path, body }));
    if (docReplaceRef.current) {
      applyingExternal.current = true;
      docReplaceRef.current(body);
      applyingExternal.current = false;
    } else {
      setReloadNonce((n) => n + 1);
    }
  }, []);

  // A bump re-reads the open note and adopts genuine divergence — but
  // only while clean. A dirty or saving buffer goes through the flush guard
  // instead (conflict banner).
  // A bump that names its paths and doesn't name ours is somebody
  // else's note changing; re-reading would be a pointless round trip through
  // the same bytes. An unnamed bump (null) still re-reads: that's the engine
  // saying it rescanned, or one of our own writes landing, and the re-read is
  // the safety net for both.
  useEffect(() => {
    if (!loaded || loaded.path !== meta.path) return;
    if (changedPaths && !changedPaths.includes(meta.path)) return;
    // a ghost has no file to re-read — nothing external can diverge
    if (ghost) return;
    if (missingRef.current || fileGoneRef.current) return;
    if (conflictRef.current || pending.current || saving.current > 0) return;
    let gone = false;
    const path = meta.path;
    vaultRead(path).then(
      (c) => {
        if (gone || pathRef.current !== path) return;
        // still clean? a keystroke may have landed while we re-read
        if (conflictRef.current || pending.current || saving.current > 0) return;
        setDiskProps((cur) => (JSON.stringify(cur) === JSON.stringify(c.props) ? cur : c.props));
        const base = baseRef.current;
        if (base?.path === path && base.body === c.body) return; // our own echo
        adoptDiskBody(path, c.body);
      },
      // two-arg form, same reason as the mount load above
      () => {
        // the open note vanished underneath a clean buffer
        if (gone || pathRef.current !== path) return;
        if (pending.current || saving.current > 0) return;
        missingRef.current = true;
        setMissing(true);
      }
    );
    // The same bump may be an external editor fixing/breaking the
    // frontmatter block — re-check its health with the content refetch
    vaultFmRaw(path)
      .then((f) => {
        if (gone || pathRef.current !== path) return;
        setFmState(f);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultEpoch]);

  // conflict banner actions: take the disk version, or win over it
  const reloadFromDisk = () => {
    window.clearTimeout(saveTimer.current);
    pending.current = null;
    conflictRef.current = false;
    setConflict(false);
    const path = meta.path;
    vaultRead(path).then(
      (c) => {
        if (pathRef.current !== path) return;
        setDiskProps(c.props);
        adoptDiskBody(path, c.body);
      },
      // Two-arg form for the reason — a trailing .catch would
      // also swallow anything the success handler throws. The old isGoneErr
      // guard was unsatisfiable (vault.rs read() returns raw io errors, not the
      // "note no longer exists" prefix), so a genuinely vanished file left the
      // stale buffer on screen looking live.
      () => {
        if (pathRef.current !== path) return;
        // fileGone, not missing: the user's unsaved text is the whole reason
        // they were offered this choice — the banner keeps it reachable where
        // the full-pane empty state would wipe it. Same pick as flush()'s
        // vanish path above.
        fileGoneRef.current = true;
        setFileGone(true);
      }
    );
  };

  const overwriteDisk = () => {
    conflictRef.current = false;
    setConflict(false);
    flush(true); // force: no expected-body — the user chose to win
  };

  // The note moved under a live editor. Relabel every
  // path-keyed piece of live state BEFORE onRenamed swaps meta.path, and
  // leave a marker so the load effect treats the prop change as a rename
  // landing, not a navigation — the editor keeps running (docKey is
  // loaded.docPath, unchanged), no teardown, no remount, and text typed at
  // any point during the rename stays exactly where the user sees it. The
  // first fix let the remount happen and ferried focus + buffer
  // across its async gap; on slow machines keystrokes fell into the gap
  // itself, so now there is no gap. Shared by commitTitle
  // and the undo/redo lane, which applies the same move from
  // outside the pane.
  const relabelForRename = useCallback((from: string, to: string) => {
    renamedTo.current = { from, to };
    renameAliases.current.set(from, to);
    // an in-flight write's park under the old key (rare: it launched
    // pre-relabel and failed in this same gap) moves with the note
    const held = orphanedEdits.get(from);
    if (held !== undefined) {
      orphanedEdits.delete(from);
      orphanedEdits.set(to, held);
    }
    setLoaded((l) => (l && l.path === from ? { ...l, path: to } : l));
    if (baseRef.current?.path === from) baseRef.current = { ...baseRef.current, path: to };
    if (pending.current?.path === from) pending.current = { ...pending.current, path: to };
  }, []);

  // ⌘Z/⇧⌘Z of a rename runs vaultRename outside any pane. When the
  // note it moves is THIS pane's open note, the same no-remount relabel must
  // fire before the refresh swaps meta.path — the rename bus routes the
  // announce to whichever mounted pane holds the note.
  useEffect(
    () =>
      onRenameAnnounce((from, to) => {
        if (pathRef.current !== from) return false;
        relabelForRename(from, to);
        return true;
      }),
    [relabelForRename]
  );

  const commitTitle = () => {
    const t = titleDraft.trim();
    if (!t || t === meta.title) {
      setTitleDraft(meta.title);
      return;
    }
    // the pending body save must land before the rename — a late flush would
    // write to the old path after it and die silently. flush
    // resolves after the write settles (errors are surfaced, not thrown).
    // Between here and the rename settling, the debounce stays parked
    // (renameInFlight): a keystroke's 500ms timer could otherwise fire into
    // the mv window and hit the same dead path.
    const from = meta.path;
    // a counter, not a boolean: a second rename committed before the first
    // settles must not un-park the debounce while the later mv is still in
    // its window (review finding)
    renameInFlight.current += 1;
    const settleRename = () => {
      renameInFlight.current = Math.max(0, renameInFlight.current - 1);
      if (renameInFlight.current === 0 && pending.current) {
        // a keystroke may be parked from the rename window — resume it
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(flush, 500);
      }
    };
    flush().then(() =>
      // The pane's own title field is a rename like any other — it
      // goes on the undo stack, and its entry names every note the link
      // sweep rewrote, not just this one. onApplied: its ⌘Z runs
      // outside the pane, so the inverse rename routes through App's
      // undo-repair lane (announce → in-place relabel, conditional
      // selection follow) instead of arriving as a bare prop change.
      renameUndoable({
        path: from,
        title: t,
        priorTitle: meta.title,
        record: undo.record,
        onApplied: onRenameUndone,
      })
        .then((m) => {
          setTitleError(null);
          if (m.path !== from) relabelForRename(from, m.path);
          settleRename();
          onRenamed(from, m);
        })
        .catch((err) => {
          settleRename();
          setTitleError(err instanceof Error ? err.message : String(err));
          setTitleDraft(meta.title);
        })
    ).catch(() => {
      // flush is documented never to reject, but a stuck counter here means
      // "typing silently never saves again" — too severe to leave to that
      // contract holding forever (review finding)
      settleRename();
    });
  };

  // One funnel for property writes — a failure used to vanish with
  // the closed editor and an unhandled rejection; now it lands on the same
  // inline pill as body saves, the attempted write is held so the
  // pill's click retries it, and success clears a previous failure. Per-note
  // state sets guard on the note still being current (a reply can lag a
  // switch); App-level follow-ups keep their old unconditional behavior.
  const writeProp = (key: string, value: string | string[] | boolean | null) => {
    const path = meta.path;
    // The note's own spelling comes off DISK, never off the
    // optimistic composite — a pending clear deletes the key there, and the
    // fallback would write the caller's spelling back as a second, differently
    // cased key in the same file.
    const actualKey = foldedPropKey(diskProps, key);
    // Paint it now; the write and its re-scan reconcile behind it
    const optimistic: PendingWrite[] = [{ path, key: actualKey, value }];
    setPendingProps((cur) => addPending(cur, optimistic));
    // Undoable like every other property edit
    setPropUndoable({ path, key: actualKey, value, record: undo.record })
      .then((m) => {
        setPendingProps((cur) => settlePending(cur, optimistic));
        if (pathRef.current === path) {
          failedProp.current = null;
          failedColumn.current = null;
          setPropError(null);
          setDiskProps(m.props);
        }
        if (actualKey.toLowerCase() === "type") onTyped?.(m);
        onMutated();
      })
      .catch((err) => {
        // The refused value rolls back on screen this frame — the
        // pill below says why and IS the retry. Unconditional, like the
        // settle: an entry for a note we've left is already gone.
        setPendingProps((cur) => dropPending(cur, optimistic));
        if (pathRef.current !== path) return;
        failedProp.current = { key: actualKey, value };
        failedColumn.current = null;
        setPropError(err instanceof Error ? err.message : String(err));
        // re-sync so nothing implies the write landed
        onMutated();
      });
  };

  /** A sheet column's notification setting. Not `writeProp` — the
      value is a nested map, which `vault_set_prop` refuses — but it lands on
      the same inline pill when it fails, and the same local-props refresh when
      it lands, so the menu reads its own write back. Not undoable either: the
      command rewrites one nested entry, and the undo stack's property inverse
      only knows how to restore a scalar. */
  const setColumnNotify = (column: string, notify: boolean, notifyBefore: number | null) => {
    const path = meta.path;
    sheetSetColumnNotify(path, column, notify, notifyBefore)
      .then((m) => {
        if (pathRef.current === path) {
          failedProp.current = null;
          failedColumn.current = null;
          setPropError(null);
          setDiskProps(m.props);
        }
        onMutated();
      })
      .catch((err) => {
        if (pathRef.current !== path) return;
        // hold this write, not a scalar one — the pill retries whichever
        // property write actually failed last
        failedProp.current = null;
        failedColumn.current = { column, notify, notifyBefore };
        setPropError(err instanceof Error ? err.message : String(err));
        onMutated();
      });
  };

  const commitChip = (key: string, value: string) => {
    // The note's property chips are the same free-text editor over
    // the same schema as the table's cells — a number-kind prop typed in the
    // app's own de-DE dialect lands canonical here too (noteType/schema read
    // at call time, both initialized below before any handler can fire)
    const kind = noteType && key.toLowerCase() !== "type"
      ? byFoldedKey(noteTypeSchema, key)?.kind
      : undefined;
    const v = kind === "number" ? normalizeNumberInput(value) : value.trim();
    setEditingChip(null);
    setAddingChip(false);
    if (!v) return;
    // an untyped note has no picker, so a list-valued prop edits as the
    // comma-joined text propStr renders — chipCommitValue keeps that round
    // trip a list instead of collapsing it to one scalar string
    writeProp(key, chipCommitValue(props[foldedPropKey(props, key)], v));
  };

  const removeChip = (key: string) => {
    writeProp(key, null);
  };

  // per-note calendar opt-out: hide writes a real YAML bool, show
  // removes the prop — same refresh discipline as the chip writes above
  const toggleCalendar = (hidden: boolean) => {
    writeProp("calendar", hidden ? null : false);
  };

  // checkbox kind: clicking the chip toggles and saves immediately —
  // checked stores the YAML scalar `true`, unchecked REMOVES the prop (never
  // writes `false`); a stored `false` reads as unchecked
  const toggleCheckboxChip = (key: string) => {
    writeProp(key, props[foldedPropKey(props, key)] === true ? null : true);
  };

  // list-valued props (relation, multi) commit live as the picker
  // toggles (menu stays open): one value stores as a scalar, several as a
  // YAML list, none removes
  const commitList = (key: string, values: string[]) => {
    writeProp(key, propListValue(values));
  };

  const createRelationTarget = (key: string, dbType: string, title: string) => {
    onCreateEntry(dbType, title)
      .then((m) => commitList(key, toggleValue(propList(props, key), m.title)))
      .catch(console.error);
  };

  // The selection menu's extract — the chunk becomes an untyped
  // note beside this one, and the editor replaces the selection with a
  // wikilink to it. Undoable like every create; the list refresh rides
  // onMutated like the pane's own writes.
  const extractToNote = useCallback(
    (title: string, body: string) =>
      vaultCreate(title, meta.folder, undefined, undefined, body).then((m) => {
        recordCreate({ meta: m, record: undo.record });
        onMutated();
        return m;
      }),
    [meta.folder, onMutated, undo]
  );

  // a picked relation value navigates to its note; a dangling one falls
  // through to the picker (target deleted or renamed outside the app)
  const openRelationValue = (key: string, value: string, el: Element) => {
    vaultResolve(value)
      .then((m) => {
        if (m) onOpenNote(m.path);
        else {
          setChipAnchor(anchorFrom(el));
          setEditingChip(key);
        }
      })
      .catch(console.error);
  };

  // Receipts address a fact by its REAL frontmatter key — the chip may be
  // showing a schema row whose key differs in case from the one on disk
  // (receipts spec §1: the lane is keyed on (path, key)).
  const factKeyOf = (k: string) => foldedPropKey(props, k);
  const chipReceiptFooter = (k: string) =>
    onReceipts ? (
      <ChipReceiptLine
        path={meta.path}
        factKey={factKeyOf(k)}
        vaultEpoch={vaultEpoch}
        onOpen={(a) => {
          setEditingChip(null);
          onReceipts(factKeyOf(k), a);
        }}
      />
    ) : undefined;

  const commitAdd = (el?: Element) => {
    const idx = chipDraft.indexOf(":");
    const key = idx < 1 ? chipDraft.trim() : chipDraft.slice(0, idx).trim();
    const value = idx < 1 ? "" : chipDraft.slice(idx + 1).trim();
    // bare `type` (or `type:`) opens the database picker instead of free text
    if (key.toLowerCase() === "type" && !value && el) {
      setChipDraft("");
      setAddingChip(false);
      setChipAnchor(anchorFrom(el));
      setTypePick(true);
      return;
    }
    setChipDraft("");
    if (key && value) commitChip(key, value);
    else setAddingChip(false);
  };

  const isSheet = foldedPropStr(isSealed ? props : meta.props, "type")?.toLowerCase() === "sheet";
  /* The sheet's per-column notification settings, read from the
     pane's own props copy so the menu sees its own write land. */
  const columnNotify = useMemo(
    () => parseColumnNotify(props[foldedPropKey(props, "columns")]),
    [props]
  );
  /* stable identity per notification click — the grid's reveal effect keys on
     it, and a new object every render would re-scroll on every keystroke */
  const sheetReveal = useMemo(
    () =>
      revealRow && revealRow.path === meta.path
        ? { column: revealRow.column, row: revealRow.row }
        : null,
    [revealRow, meta.path]
  );
  const noteType = foldedPropStr(props, "type");
  const noteTypeSchema = noteType ? typeSchemaFor(schema, noteType) : undefined;
  // the rollup schema editor's pickers: the note's type's relation
  // props a rollup can follow, and the (non-rollup) props of the picked
  // relation's target database
  const rollupRelations = useMemo(
    () =>
      Object.entries(noteTypeSchema ?? {})
        .filter(([, ps]) => ps?.kind === "relation")
        .map(([k]) => k),
    [noteTypeSchema]
  );
  const rollupPropsFor = useCallback(
    (relation: string): string[] => {
      const target = byFoldedKey(noteTypeSchema, relation)?.type;
      if (!target) return [];
      return Object.entries(typeSchemaFor(schema, target) ?? {})
        .filter(([k, ps]) => k !== "icon" && k !== "home" && ps?.kind !== "rollup")
        .map(([k]) => k);
    },
    [schema, noteTypeSchema]
  );
  // calendar opt-out: the menu item shows only when the note lands
  // on the calendar or already carries the flag — plain undated notes skip it
  const calendarValue = props[foldedPropKey(props, "calendar")];
  const calHidden = calendarValue === false || calendarValue === "false";
  const calToggleable = calHidden || entriesForNote({ ...meta, props }, schema).length > 0;
  // read the pick off the live props, not off `meta` — the ⋯ menu's
  // label must flip the moment the write lands, before the vault re-scan
  // refreshes meta
  const pickedToday = isPickedToday({ ...meta, props }, todayIso);
  // database identity icons for the type chip + type picker
  const dbIcons = useMemo(() => iconsByType(schema), [schema]);
  // a template shows its type as a fixed header — the filename is
  // the schema key, never user-renamable
  const templateType = templateTypeOf(meta.path);
  // a daily note's date is its identity — the title shows a human date and
  // stays fixed, with day-stepping chevrons alongside
  const daily = onJournalDay ? dailyDateOf(meta.path) : null;

  useEffect(() => {
    if (!noteType) return;
    const vals = Object.keys(props)
      .filter((k) => byFoldedKey(noteTypeSchema, k)?.kind === "file")
      .map((k) => propStr(props, k) ?? "")
      .filter(Boolean);
    if (vals.length === 0) return;
    let gone = false;
    Promise.all(vals.map((v) => pathExists(v).then((ok) => [v, ok] as const)))
      .then((pairs) => {
        if (!gone) setFileOk(Object.fromEntries(pairs));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [props, noteType, noteTypeSchema]);

  // hooks above must run unconditionally — keep this early return below them
  if (isSealed && !sealedUnlocked) {
    return (
      <div className="note sealed-note">
        <div className="sealed-locked">
          <div className="sealed-lock-mark"><LockIcon /></div>
          <div className="sealed-lock-title">{meta.title}</div>
          <div className="sealed-lock-copy">
            Encrypted on disk. Its body and properties are unavailable to search,
            dashboards, sheets, scripts, and local agents.
          </div>
          <button className="selmenu-btn selmenu-btn-primary" onClick={() => setSealedDialog("unlock")}>
            Unlock to peek
          </button>
          <div className="sealed-lock-hint">The filename remains visible.</div>
        </div>
        {sealedDialog && (
          <SealedNoteDialog
            meta={meta}
            mode={sealedDialog}
            onClose={() => setSealedDialog(null)}
            onDone={() => {
              setSealedDialog(null);
              sealedHeld.current = true;
              setSealedUnlocked(true);
            }}
          />
        )}
      </div>
    );
  }

  if (missing) {
    return (
      <div className="note">
        {/* No verb here yet: nothing in this state is recoverable from the app,
            so there is no existing command to offer — glyph + text. */}
        <EmptyState
          icon={<FileIcon />}
          title="This note’s file is gone"
          hint="It was moved, deleted, or made unreadable outside Substrate"
        />
      </div>
    );
  }

  // the same absolute-path helpers the row menu uses (App side)
  const copyAbsPath = (rel: string) => {
    vaultRoot()
      .then((root) => navigator.clipboard.writeText(`${root}/${rel}`))
      .catch(console.error);
  };
  const revealRel = (rel: string) => {
    vaultRoot()
      .then((root) => revealItemInDir(`${root}/${rel}`))
      .catch((e) => console.warn("reveal in Finder unavailable:", e));
  };

  // The ⋯ menu renders the canonical note actions — the same
  // descriptors as the row menu and the palette actions stage. Open is
  // row-only, Set property palette-only, the calendar toggle exists only
  // here; Rename needs the title input, which dailies and
  // templates don't have (their titles are fixed)
  const noteActions = buildNoteActions({
    moveToFolder: onMoveToFolder ? () => onMoveToFolder(meta) : undefined,
    rename:
      !daily && !templateType
        ? () => {
            titleInputRef.current?.focus();
            titleInputRef.current?.select();
          }
        : undefined,
    duplicate: onDuplicate
      ? () => {
          // flush first — the copy reads the file, pending text must be in it
          flush().then(() => onDuplicate(meta));
        }
      : undefined,
    copyPath: () => copyAbsPath(meta.path),
    reveal: () => revealRel(meta.path),
    exportMarkdown: () => {
      flush();
      exportNoteMarkdown(meta).catch(console.error);
    },
    exportPdf: () => {
      flush();
      exportNotePdf(meta).catch(console.error);
    },
    exportOneSheet: () => {
      flush();
      exportNoteOneSheet(meta).catch(console.error);
    },
    sealed: isSealed,
    sendAsLink: onSendAsLink
      ? () => {
          // flush first — the handoff renders from the file, pending text
          // must be in it
          flush().then(() => onSendAsLink(meta));
        }
      : undefined,
    seal: !isSealed
      ? () => {
          flush().then(() => setSealedDialog("seal"));
        }
      : undefined,
    lockNow: isSealed
      ? () => {
          // .finally on both legs: a rejected flush must still drop the
          // engine identity, or "Lock now" shows locked while plaintext
          // stays readable through every IPC path
          flush()
            .finally(() => {
              if (!sealedHeld.current) return;
              sealedHeld.current = false;
              vaultLockSealedNote(meta.path);
            })
            .finally(() => setSealedUnlocked(false));
        }
      : undefined,
    unseal: isSealed ? () => setSealedDialog("unseal") : undefined,
    togglePick: onTogglePick ? () => onTogglePick(meta.path, !pickedToday) : undefined,
    picked: pickedToday,
    toggleCalendar: calToggleable ? () => toggleCalendar(calHidden) : undefined,
    calendarHidden: calHidden,
    togglePin: onTogglePin ? () => onTogglePin(meta.path, !pinned) : undefined,
    pinned,
    trash: onTrash
      ? () => {
          // A pending debounced save must land BEFORE the delete —
          // trashing inside the 500ms window ate the edit
          flush().then(() => onTrash(meta.path));
        }
      : undefined,
  });

  return (
    <div className={isSheet ? "note note-sheet" : "note"}>
      {/* a ghost daily has no file yet — history, exports and trash
          would all hit "not found", so the tools appear with the file */}
      {!ghost && (
      <div className="note-tools">
        {!isSealed && <button
          className="note-tool"
          title="History"
          aria-label="History"
          onClick={() => {
            flush();
            setShowHistory(true);
          }}
        >
          <ClockIcon />
        </button>}
        <DotsMenu
          title="Note actions"
          buttonClass="note-tool"
          items={noteActions.map((a) => ({
            label: a.label,
            icon: <NoteActionGlyph name={a.icon} />,
            hint: a.hint,
            danger: a.destructive,
            separatorAbove: a.separatorAbove,
            run: a.run,
          }))}
        />
      </div>
      )}
      <div className={isSheet ? "note-inner note-inner-sheet" : "note-inner"}>
        {templateType ? (
          <div className="note-title note-title-template">
            {templateType}
            <span className="note-title-tag">template</span>
          </div>
        ) : daily ? (
          <div className="note-daily">
            <button
              className="note-tool daily-nav"
              title="Yesterday (⌘⇧←)"
              aria-label="Yesterday"
              onClick={() => onJournalDay?.(shiftDate(daily, -1))}
            >
              <ChevronLeftIcon />
            </button>
            <div className="note-title note-title-daily">{humanDate(daily)}</div>
            <button
              className="note-tool daily-nav"
              title="Tomorrow (⌘⇧→)"
              aria-label="Tomorrow"
              onClick={() => onJournalDay?.(shiftDate(daily, 1))}
            >
              <ChevronRightIcon />
            </button>
          </div>
        ) : (
        <input
          className="note-title"
          aria-label="Note title"
          ref={titleInputRef}
          value={titleDraft}
          placeholder="Untitled"
          onChange={(e) => {
            setTitleDraft(e.target.value);
            setTitleError(null);
          }}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // The editor survives the rename now (no
              // docKey change), so a plain focus call sticks — no
              // post-remount restore flag needed on either commit path
              (e.target as HTMLInputElement).blur();
              editorFocusRef.current?.();
            }
            if (e.key === "Escape") {
              setTitleDraft(meta.title);
              (e.target as HTMLInputElement).blur();
              // Esc on a fresh ⌘N note abandons it (App decides —
              // only pristine session-created scratch notes are deleted)
              onEscape?.(meta.path);
            }
          }}
        />
        )}
        {titleError && (
          <div style={{ color: "var(--danger)", fontSize: "12px", margin: "-4px 0 8px" }}>
            {titleError}
          </div>
        )}
        {(saveError || propError || conflict || fileGone) && (
          <div className="note-feedback">
            {saveError && (
              <button
                type="button"
                className="save-error"
                title={saveError}
                onClick={() => flush()}
              >
                <span className="err-dot" />
                save failed — click to retry
              </button>
            )}
            {propError && (
              <button
                type="button"
                className="save-error"
                title={propError}
                onClick={() => {
                  const f = failedProp.current;
                  if (f) writeProp(f.key, f.value);
                  const c = failedColumn.current;
                  if (c) setColumnNotify(c.column, c.notify, c.notifyBefore);
                }}
              >
                <span className="err-dot" />
                save failed — click to retry
              </button>
            )}
            {conflict && (
              <div className="note-banner" role="alert">
                <span>File changed on disk — your edits are unsaved and conflict with it.</span>
                <button type="button" onClick={reloadFromDisk}>
                  Reload
                </button>
                <button type="button" onClick={overwriteDisk}>
                  Overwrite
                </button>
              </div>
            )}
            {fileGone && (
              <div className="note-banner" role="alert">
                <span>
                  This note’s file is gone — moved or deleted outside Substrate. Unsaved text
                  below lives only here; copy it somewhere safe.
                </span>
              </div>
            )}
          </div>
        )}
        <div className="prop-rows">
          {!noteType && !templateType && !daily && (
            <button
              type="button"
              className="prop-row chip chip-plain"
              aria-label="Add note to a database"
              title="Plain note — click to add it to a database"
              onClick={(e) => {
                setChipAnchor(anchorFrom(e.currentTarget));
                setTypePick(true);
              }}
            >
              <span className="prop-key chip-key">Database</span>
              <span className="prop-val chip-val chip-plain-val">note</span>
            </button>
          )}
          {chipEntries(props, noteTypeSchema).map(([k, v]) => {
            const foldedKey = k.toLowerCase();
            const isType = foldedKey === "type";
            const pschema = noteType && !isType ? byFoldedKey(noteTypeSchema, k) : undefined;
            const opts = pschema?.options ?? [];
            const kind = pschema?.kind;
            const relTarget = kind === "relation" ? pschema?.type : undefined;
            const relVals = kind === "relation" ? propList(props, k) : [];
            const multiVals = kind === "multi" ? propList(props, k) : [];
            const broken = kind === "file" && !!v && fileOk[v] === false;
            // created/updated carry ISO dates but plain notes have no schema
            // kind — format by key, not just by kind. Date-kind props render
            // an optional time-of-day too; created/updated keep
            // their day-only humanizing exactly as before.
            const display =
              kind === "date"
                ? formatDateTimeHuman(v)
                : foldedKey === "created" || foldedKey === "updated"
                  ? formatDateHuman(v)
                  : kind === "file"
                  ? basename(v)
                  : kind === "url"
                    ? urlDisplayTitle(v)
                    : kind === "number"
                      ? formatNumber(v, pschema?.format, undefined, numberLocale)
                      : v;
            // typed notes edit via the picker; untyped notes keep plain text —
            // except `type` itself, which always offers the known databases
            if (editingChip === k && chipAnchor && (noteType || isType)) {
              const editor = isType || !noteType ? (
                <SelectMenu
                  anchor={chipAnchor}
                  value={v}
                  options={[]}
                  used={isType ? (dbTypesRecent ?? dbTypes) : dbTypes}
                  canEditSchema={false}
                  label={isType ? "Pick a database" : `Pick ${k}`}
                  listHeading={isType ? "Databases" : undefined}
                  valueIcons={isType ? dbIcons : undefined}
                  onCommit={(nv) => commitChip(k, nv)}
                  onClear={() => {
                    setEditingChip(null);
                    removeChip(k);
                  }}
                  onSaveSchema={() => {}}
                  footer={chipReceiptFooter(k)}
                  onClose={() => setEditingChip(null)}
                />
              ) : schemaEditChip === k ? (
                <SelectMenu
                  anchor={chipAnchor}
                  value={v}
                  options={opts}
                  used={usedValues(noteType, k)}
                  canEditSchema
                  kind={kind}
                  notify={pschema?.notify}
                  notifyBefore={pschema?.notifyBefore}
                  target={pschema?.type}
                  format={pschema?.format}
                  description={pschema?.description}
                  databases={dbTypes}
                  rollupRelations={rollupRelations}
                  rollupPropsFor={rollupPropsFor}
                  rollup={
                    kind === "rollup" && pschema?.relation && pschema?.prop && pschema?.agg
                      ? { relation: pschema.relation, prop: pschema.prop, agg: pschema.agg }
                      : undefined
                  }
                  startEditing
                  onCommit={(nv) => commitChip(k, nv)}
                  onSaveSchema={(o, nk, nf, nb, t, f, d, r) => onSaveSchema(noteType, k, o, nk, nf, nb, t, f, d, r)}
                  onClose={() => {
                    setEditingChip(null);
                    setSchemaEditChip(null);
                  }}
                />
              ) : kind === "relation" && relTarget ? (
                <RelationMenu
                  anchor={chipAnchor}
                  values={relVals}
                  candidates={relationCandidates(relTarget)}
                  targetType={relTarget}
                  onCommit={(vals) => commitList(k, vals)}
                  onCreate={(t) => createRelationTarget(k, relTarget, t)}
                  onClear={() => {
                    setEditingChip(null);
                    removeChip(k);
                  }}
                  onEditSchema={() => setSchemaEditChip(k)}
                  footer={chipReceiptFooter(k)}
                  onClose={() => setEditingChip(null)}
                />
              ) : kind === "date" ? (
                <DateMenu
                  anchor={chipAnchor}
                  value={v}
                  onCommit={(nv) => commitChip(k, nv)}
                  onClear={() => {
                    setEditingChip(null);
                    removeChip(k);
                  }}
                  onEditSchema={() => setSchemaEditChip(k)}
                  footer={chipReceiptFooter(k)}
                  onClose={() => setEditingChip(null)}
                />
              ) : kind === "file" ? (
                <FileMenu
                  anchor={chipAnchor}
                  value={v}
                  exists={v ? fileOk[v] ?? null : null}
                  onCommit={(nv) => commitChip(k, nv)}
                  onClear={() => {
                    setEditingChip(null);
                    removeChip(k);
                  }}
                  onEditSchema={() => setSchemaEditChip(k)}
                  footer={chipReceiptFooter(k)}
                  onClose={() => setEditingChip(null)}
                />
              ) : (
                <SelectMenu
                  anchor={chipAnchor}
                  value={v}
                  options={opts}
                  used={usedValues(noteType, k)}
                  canEditSchema={!isType}
                  kind={kind}
                  notify={pschema?.notify}
                  notifyBefore={pschema?.notifyBefore}
                  target={pschema?.type}
                  format={pschema?.format}
                  description={pschema?.description}
                  databases={dbTypes}
                  rollupRelations={rollupRelations}
                  rollupPropsFor={rollupPropsFor}
                  label={`Pick ${k}`}
                  values={kind === "multi" ? multiVals : undefined}
                  onToggle={
                    kind === "multi"
                      ? (nv) => commitList(k, toggleValue(propList(props, k), nv))
                      : undefined
                  }
                  onCommit={(nv) => commitChip(k, nv)}
                  onClear={() => {
                    setEditingChip(null);
                    removeChip(k);
                  }}
                  onSaveSchema={(o, nk, nf, nb, t, f, d, r) => onSaveSchema(noteType, k, o, nk, nf, nb, t, f, d, r)}
                  footer={chipReceiptFooter(k)}
                  onClose={() => setEditingChip(null)}
                />
              );
              return (
                <span key={k} className="prop-row chip chip-editing">
                  <span className="prop-key chip-key">{isType ? "Database" : k}</span>
                  <span className={`prop-val chip-val${broken ? " file-broken" : ""}${(kind === "url" || kind === "email" || kind === "phone") && v ? " url-link" : ""}`}>
                    {kind === "relation"
                      ? relVals.map((rv, i) => (
                          <span key={rv}>
                            {i > 0 && ", "}
                            {rv}
                          </span>
                        ))
                      : kind === "multi"
                        ? <MultiValues values={multiVals} options={opts} />
                        : <OptionPill color={optionColor(opts, v)}>{display}</OptionPill>}
                  </span>
                  {editor}
                </span>
              );
            }
            if (editingChip === k) {
              return (
                <span key={k} className="prop-row">
                  <span className="prop-key chip-key">{k}</span>
                  <input
                    className="chip-input"
                    autoFocus
                    value={chipDraft}
                    size={Math.max(chipDraft.length, 4)}
                    onChange={(e) => setChipDraft(e.target.value)}
                    onBlur={() => commitChip(k, chipDraft)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitChip(k, chipDraft);
                      if (e.key === "Escape") setEditingChip(null);
                    }}
                  />
                </span>
              );
            }
            const openMenu = (el: Element) => {
              setChipAnchor(anchorFrom(el));
              setEditingChip(k);
              setChipDraft(v);
            };
            // checkbox chips: the value IS the square — click
            // toggles in place, no picker; right-click opens the schema
            // options like other kinds
            if (kind === "checkbox") {
              const checked = props[k] === true;
              return (
                <span
                  key={k}
                  className="prop-row chip"
                  title="Click to toggle · right-click for options"
                >
                  <button
                    type="button"
                    className="chip-primary"
                    aria-label={`${k}: ${checked ? "checked" : "unchecked"}. Toggle`}
                    aria-pressed={checked}
                    onClick={() => toggleCheckboxChip(k)}
                    onKeyDown={(e) => {
                      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
                      e.preventDefault();
                      setChipAnchor(anchorFrom(e.currentTarget));
                      setEditingChip(k);
                      setSchemaEditChip(k);
                      setChipDraft(v);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setChipAnchor(anchorFrom(e.currentTarget));
                      setEditingChip(k);
                      setSchemaEditChip(k);
                      setChipDraft(v);
                    }}
                  />
                  <span className="prop-key chip-key" aria-hidden="true">{k}</span>
                  <span className="prop-val chip-val" aria-hidden="true">
                    <span className={`prop-check${checked ? " on" : ""}`} aria-label={checked ? "Checked" : "Unchecked"} />
                  </span>
                {onReceipts && !ghost && (
                  <button
                    type="button"
                    className="chip-clock"
                    // pointer-only on purpose: the row's tab stops are its
                    // primary action and its remove button, and the keyboard
                    // door to the same peek is the chip editor's own
                    // last-change line (spec §6)
                    tabIndex={-1}
                    aria-label={`Who changed ${k}`}
                    title="Who changed this, and when"
                    // hover intent warms the lane (§5) so the click that
                    // follows lands on data rather than on a spinner
                    onPointerEnter={() => prefetchFact(meta.path, factKeyOf(k), vaultEpoch)}
                    onFocus={() => prefetchFact(meta.path, factKeyOf(k), vaultEpoch)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onReceipts(factKeyOf(k), anchorFrom(e.currentTarget));
                    }}
                  >
                    <ClockIcon />
                  </button>
                )}
                  <button
                    type="button"
                    className="chip-x"
                    aria-label={`Remove ${k} property`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeChip(k);
                    }}
                  >
                    <XIcon />
                  </button>
                </span>
              );
            }
            const contactLink =
              kind === "url" && v
                ? v
                : (kind === "email" || kind === "phone") && v
                  ? contactHref(kind, v)
                  : null;
            const opensFile = kind === "file" && !!v && fileOk[v] !== false;
            const primaryLabel =
              isType
                ? `Change database from ${v}`
                : kind === "relation"
                  ? `Edit ${k} relations${relVals.length > 0 ? `: ${relVals.join(", ")}` : ""}`
                  : opensFile || contactLink
                    ? `Open ${k}: ${display}`
                    : `Edit ${k}: ${display || "empty"}`;
            const activatePrimary = (el: HTMLElement) => {
              // healthy file links open directly (the chip IS the link);
              // empty or broken ones fall through to the menu
              if (opensFile) {
                fileOpen(v).catch(console.error);
                return;
              }
              // url/email/phone chips are always links — right-click edits
              if (contactLink) {
                openExternalLink(contactLink);
                return;
              }
              openMenu(el);
            };
            // every chip claims its right-click (an unclaimed one
            // now falls through to the app-root menu, which is never the
            // wish on a chip). Link kinds get their options menu — click
            // opens the link; the rest get the same editor click opens.
            const openPrimaryContext = (e: React.MouseEvent<HTMLElement>) => {
              e.preventDefault();
              openMenu(e.currentTarget);
            };
            const openPrimaryContextKey = (e: React.KeyboardEvent<HTMLElement>) => {
              if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
              e.preventDefault();
              openMenu(e.currentTarget);
            };
            return (
              <span
                key={k}
                className="prop-row chip"
                title={
                  (kind === "file" || kind === "url" || kind === "email" || kind === "phone") && v
                    ? `${v}\nClick to open · right-click for options`
                    : undefined
                }
              >
                {contactLink ? (
                  <a
                    className="chip-primary"
                    href={contactLink}
                    aria-label={primaryLabel}
                    onClick={(e) => {
                      e.preventDefault();
                      activatePrimary(e.currentTarget);
                    }}
                    onKeyDown={openPrimaryContextKey}
                    onContextMenu={openPrimaryContext}
                  />
                ) : (
                  <button
                    type="button"
                    className="chip-primary"
                    aria-label={primaryLabel}
                    onClick={(e) => activatePrimary(e.currentTarget)}
                    onKeyDown={openPrimaryContextKey}
                    onContextMenu={openPrimaryContext}
                  />
                )}
                <span className="prop-key chip-key" aria-hidden="true">{isType ? "Database" : k}</span>
                {isType && resolveIcon(v, iconForType(dbIcons, v)) ? (
                  <span aria-hidden="true"><TypeIcon type={v} icon={iconForType(dbIcons, v)} size={13} /></span>
                ) : null}
                <span
                  className={`prop-val chip-val${broken ? " file-broken" : ""}${(kind === "url" || kind === "email" || kind === "phone") && v ? " url-link" : ""}`}
                  aria-hidden={kind === "relation" ? undefined : "true"}
                >
                  {kind === "relation"
                    ? relVals.map((rv, i) => (
                        <span key={rv}>
                          {i > 0 && ", "}
                          <button
                            type="button"
                            className="chip-rel"
                            aria-label={`Open related note ${rv}`}
                            title={`Open ${rv}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openRelationValue(k, rv, e.currentTarget.closest(".chip") ?? e.currentTarget);
                            }}
                          >
                            {rv}
                          </button>
                        </span>
                      ))
                    : kind === "multi"
                      ? <MultiValues values={multiVals} options={opts} />
                      : <OptionPill color={optionColor(opts, v)}>{display}</OptionPill>}
                </span>
                {/* born-empty schema rows: a quiet affordance — the
                    chip-val itself stays empty (e2e contract) */}
                {!v && <span className="prop-empty" aria-hidden="true">Empty</span>}
                {onReceipts && !ghost && (
                  <button
                    type="button"
                    className="chip-clock"
                    // pointer-only on purpose: the row's tab stops are its
                    // primary action and its remove button, and the keyboard
                    // door to the same peek is the chip editor's own
                    // last-change line (spec §6)
                    tabIndex={-1}
                    aria-label={`Who changed ${k}`}
                    title="Who changed this, and when"
                    // hover intent warms the lane (§5) so the click that
                    // follows lands on data rather than on a spinner
                    onPointerEnter={() => prefetchFact(meta.path, factKeyOf(k), vaultEpoch)}
                    onFocus={() => prefetchFact(meta.path, factKeyOf(k), vaultEpoch)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onReceipts(factKeyOf(k), anchorFrom(e.currentTarget));
                    }}
                  >
                    <ClockIcon />
                  </button>
                )}
                <button
                  type="button"
                  className="chip-x"
                  aria-label={`Remove ${k} property`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeChip(k);
                  }}
                >
                  <XIcon />
                </button>
              </span>
            );
          })}
          {ghost ? null : addingChip ? (
            <span className="prop-row">
              <span className="prop-key" />
              <input
                className="chip-input"
                autoFocus
                placeholder="key: value"
                value={chipDraft}
                size={Math.max(chipDraft.length, 10)}
                onChange={(e) => setChipDraft(e.target.value)}
                onBlur={(e) => commitAdd(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitAdd(e.currentTarget);
                  if (e.key === "Escape") {
                    setAddingChip(false);
                    setChipDraft("");
                  }
                }}
              />
            </span>
          ) : (
            <button
              type="button"
              className="prop-row chip chip-add"
              aria-label="Add property"
              onClick={() => {
                setAddingChip(true);
                setChipDraft("");
              }}
            >
              + property
            </button>
          )}
          {typePick && chipAnchor && (
            <SelectMenu
              anchor={chipAnchor}
              value={noteType ?? ""}
              options={[]}
              used={dbTypesRecent ?? dbTypes}
              canEditSchema={false}
              label="Pick a database"
              listHeading="Databases"
              valueIcons={dbIcons}
              onCommit={(nv) => {
                setTypePick(false);
                commitChip("type", nv);
              }}
              onClear={() => setTypePick(false)}
              onSaveSchema={() => {}}
              onClose={() => setTypePick(false)}
            />
          )}
        </div>
        {fmState?.error && (
          <div className="fm-banner" role="alert">
            <span className="err-dot" />
            {fmState.repairable ? (
              <>
                <span>Frontmatter can’t be parsed — property edits are blocked.</span>
                <button type="button" onClick={() => setFmRepair(true)}>
                  Repair…
                </button>
              </>
            ) : (
              // An unterminated `---` has no block for the dialog to
              // edit, and the whole file is already in the editor below —
              // so the banner points at the fix instead of offering a dialog
              <span>
                Frontmatter is never closed — add a <code>---</code> line below the properties
                to unblock property edits.
              </span>
            )}
          </div>
        )}
        {loaded && loaded.path === meta.path && (
          isSheet ? (
            <SheetGrid
              key={`${loaded.docPath}@${reloadNonce}`}
              meta={meta}
              docPath={loaded.docPath}
              initial={loaded.body}
              vaultEpoch={vaultEpoch}
              onChange={onBodyChange}
              onFollowLink={onFollowLink}
              onToast={onToast}
              focusRef={editorFocusRef}
              docRef={docReplaceRef}
              readOnly={readOnly}
              columnNotify={columnNotify}
              onSetColumnNotify={readOnly ? undefined : setColumnNotify}
              reveal={sheetReveal}
              onRevealed={onRowRevealed}
            />
          ) : (
            <Editor
              docKey={`${loaded.docPath}@${reloadNonce}`}
              foldKey={meta.path}
              initial={loaded.body}
              onChange={onBodyChange}
              onFollowLink={onFollowLink}
              onOpenTag={onOpenTag}
              tagUniverse={tagUniverse}
              numberLocale={numberLocale}
              calcFx={calcFx}
              liveSheets={liveSheets}
              noteTitles={noteTitles}
              dbTypes={dbTypes}
              embedQuery={embedQuery}
              onOpenNote={onOpenNote}
              onOpenView={onOpenView}
              onEmbedSetProp={onEmbedSetProp}
              onEmbedCreate={onEmbedCreate}
              embedUsedValues={usedValues}
              embedRelationCandidates={relationCandidates}
              onEmbedCreateRelation={onEmbedCreateRelation}
              vaultEpoch={vaultEpoch}
              focusRef={editorFocusRef}
              docRef={docReplaceRef}
              reveal={reveal && reveal.path === meta.path ? reveal : null}
              onRevealed={onRevealed}
              onEscape={onEscape ? () => onEscape(meta.path) : undefined}
              onToast={onToast}
              onExtractNote={extractToNote}
              emptyHint={ghost ? "No entry — start writing" : undefined}
              readOnly={readOnly}
            />
          )
        )}
        {showHistory && (
          <HistoryPanel
            meta={meta}
            onClose={() => setShowHistory(false)}
            onRestored={() => {
              setReloadNonce((n) => n + 1);
              onMutated();
            }}
            // a purge/trim changes no file, so this is the only signal the rest
            // of the app gets that the history caches must drop
            onHistoryRewritten={onMutated}
          />
        )}
        {fmRepair && fmState && (
          <FmRepairDialog
            path={meta.path}
            fm={fmState}
            onClose={() => setFmRepair(false)}
            onSaved={(m) => {
              if (pathRef.current === meta.path) {
                // the repaired block's props parse now — adopt them, and
                // re-check health from disk so the banner clears on truth
                setDiskProps(m.props);
                vaultFmRaw(meta.path)
                  .then((f) => setFmState(f))
                  .catch(() => setFmState(null));
              }
              onMutated();
            }}
          />
        )}
        {!isSheet &&
          relatedGroups(related).map((g) => (
            <div className="backlinks related" key={g.dbType}>
              <div className="backlinks-label">
                {g.entries.length} {pluralType(g.dbType, g.entries.length)}{" "}
                {g.entries.length === 1 ? "points" : "point"} here
              </div>
              {g.entries.map((r) => (
                <button
                  type="button"
                  key={`${r.path}:${r.prop}`}
                  className="backlink"
                  onClick={() => onOpenNote(r.path)}
                >
                  <BacklinkIcon />
                  <span>{r.title}</span>
                  <span className="related-prop">{r.prop}</span>
                </button>
              ))}
            </div>
          ))}
        {!isSheet && backlinks.length > 0 && (
          <div className="backlinks">
            <div className="backlinks-label">
              Backlinks · {backlinks.length}
            </div>
            {backlinks.map((b) => (
              <button
                type="button"
                key={b.path}
                className="backlink"
                onClick={() => onOpenNote(b.path)}
              >
                <BacklinkIcon />
                <span>{b.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {sealedDialog && (
        <SealedNoteDialog
          meta={meta}
          mode={sealedDialog}
          onClose={() => setSealedDialog(null)}
          onDone={(result) => {
            const mode = sealedDialog;
            setSealedDialog(null);
            if (mode === "seal") {
              setSealedOverride(true);
              setSealedUnlocked(false);
              // sealing leaves the note LOCKED: the seal command releases its
              // own authorization once the purge is safe (holders back to 0),
              // so this pane holds nothing. Claiming a hold here would make
              // the pane's teardown release someone else's authorization —
              // whoever unlocks the note next.
              sealedHeld.current = false;
              const quick = (result as { device_unlock?: boolean } | undefined)?.device_unlock;
              if (quick === false) onToast?.("Sealed — use the vault password to unlock on this device");
              onMutated();
            } else if (mode === "unseal") {
              setSealedOverride(false);
              setSealedUnlocked(false);
              // the note is plaintext again: the engine dropped every hold on
              // it, so this pane has nothing left to release
              sealedHeld.current = false;
              onMutated();
            } else {
              sealedHeld.current = true;
              setSealedUnlocked(true);
            }
          }}
        />
      )}
    </div>
  );
}

/* The pane reads its note through props alone, so App-state churn
   that does not touch them (toast, sidebar drags, palette, list selection of
   the note already open) stops re-rendering the editor subtree. Every
   callback and object prop is stabilized at the App call site. */
export default memo(NotePane);
