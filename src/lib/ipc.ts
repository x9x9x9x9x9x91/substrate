import { invoke, setHistoryReadOnly } from "./tauri.ts";
import { isAppFile, SETTINGS_PATH } from "./settings.ts";
import type { OnboardingStatus, VaultCandidate } from "./onboarding.ts";
import type {
  AggKind,
  AssetInfo,
  BulkSweep,
  CalendarFeedConfig,
  CalendarFeedSnapshot,
  ConflictChoice,
  ConflictState,
  DbIcon,
  DbLayout,
  DiffLine,
  DoctorReport,
  FmState,
  FolderMetaMap,
  FolderMapping,
  FolderScanStats,
  FullSearchResult,
  HiddenPerLayout,
  HistoryEntry,
  HistoryStatus,
  HistoryVaultSnapshot,
  NewTypeProp,
  NoteContent,
  NoteMeta,
  NumberFormat,
  PropKind,
  PropValue,
  RelatedEntry,
  RenameResult,
  RollupConfig,
  SavedView,
  SavedViewSort,
  SchemaConfig,
  SearchHit,
  SelectOption,
  SetPropResult,
  SidebarOrder,
  SyncReport,
  TrashEntry,
  VaultSyncStatus,
  ViewsConfig,
  VaultHistoryPoint,
} from "./types";

let historyProjection: HistoryVaultSnapshot | null = null;
/** true from historyEnter until the write guard is released again — spans the
    present-mode reload, where the projection is already gone (SUB-822). */
let pastSession = false;
const clone = <T,>(value: T): T => structuredClone(value);
/** SUB-822 (perf): one deep copy of the projection's note list, made when the
    snapshot is adopted. `vaultList` is called on every `vault:changed` — and
    the live vault keeps emitting those while the past is on screen — so a deep
    `structuredClone` per call re-copied every note in the vault for a list that
    cannot have changed. Callers get `.slice()` of this, so the array they sort
    or splice is still their own; only in-place edits of a NoteMeta object would
    be shared, and nothing in the app mutates one (writes go through the engine
    and come back as fresh metas). */
let projectedNotes: NoteMeta[] = [];

/** Fetch + activate one immutable whole-vault history projection. */
export async function historyEnter(id: string): Promise<HistoryVaultSnapshot> {
  const snapshot = await invoke<HistoryVaultSnapshot>("history_vault_snapshot", { id });
  historyProjection = snapshot;
  projectedNotes = clone(snapshot.notes);
  pastSession = true;
  setHistoryReadOnly(true);
  return clone(snapshot);
}

/* SUB-822: modules that stage unsaved text outside the mounted pane register
   a purge here — NotePane's orphanedEdits is the one that matters. Text
   captured while a historical body was on screen must never survive the trip
   back to the present, or reopening that note adopts the past text and saves
   it over the live file. Registered at module scope by the holder, so a new
   buffer can't forget the hook; kept here (not imported from the component)
   to keep ipc.ts free of component imports. */
const historyLeaveHooks = new Set<() => void>();
export function onHistoryLeave(purge: () => void): void {
  historyLeaveHooks.add(purge);
}

/** Drop the projection; subsequent reads return to the live vault. During the
 * present-mode reload, callers can retain the write guard until every live
 * index/config has been adopted. */
export function historyLeave(unlock = true): void {
  // The purge runs on every leg of the trip back, not just the first: the
  // present-mode reload runs with the write guard still on, so a pane
  // flushing there gets a rejected write and stages a fresh orphan from the
  // historical body (SUB-822).
  if (pastSession) for (const purge of historyLeaveHooks) purge();
  historyProjection = null;
  projectedNotes = [];
  if (unlock) pastSession = false;
  if (unlock) setHistoryReadOnly(false);
}

export const historyProjectionActive = () => historyProjection !== null;

export const vaultRoot = () => invoke<string>("vault_root");

/* first-run onboarding (SUB-436) */
export const onboardingStatus = () => invoke<OnboardingStatus>("onboarding_status");
/** What a candidate folder is, before anything is written to it. */
export const vaultInspect = (path: string) => invoke<VaultCandidate>("vault_inspect", { path });
/** Validate + initialize + persist; `consent` = the user confirmed
    initializing inside a folder that already holds unrelated files. */
export const vaultChoose = (path: string, consent = false) =>
  invoke<string>("vault_choose", { path, consent });
/** Disposable copy of the bundled example vault, selected as the choice. */
export const vaultDemo = () => invoke<string>("vault_demo");
/** SUB-804: write `terminal-command` into the just-chosen vault's Settings.md
    (pre-relaunch, so the ⌘⇧T terminal is wired from the first real session).
    Empty string clears the key — an un-picked chip. */
export const onboardingSetAgent = (command: string) =>
  invoke<null>("onboarding_set_agent", { command });
export const appRelaunch = () => invoke<null>("app_relaunch");
export const vaultList = () =>
  historyProjection
    ? Promise.resolve(projectedNotes.slice())
    : invoke<NoteMeta[]>("vault_list");
/** SUB-822: Settings.md is app configuration, not vault content, and several
    live surfaces re-read it while the scrubber is open — the terminal HUD, the
    palette's quick actions, the conceal toggle, the drop hint. Projecting the
    historical copy silently swapped the running app's behaviour (a quick action
    the user deleted last week comes back, `terminal-command` reverts to an old
    agent) for as long as they browsed. The past is a read of the vault's notes;
    it is not a settings rollback. */
export const vaultRead = (path: string) => {
  if (historyProjection && path !== SETTINGS_PATH) {
    const content = historyProjection.contents[path];
    return content
      ? Promise.resolve(clone(content))
      : Promise.reject(new Error("note did not exist at this snapshot"));
  }
  return invoke<NoteContent>("vault_read", { path });
};
export const vaultWriteBody = (path: string, body: string, expectedBody?: string | null) =>
  invoke<NoteMeta>("vault_write_body", { path, body, expectedBody: expectedBody ?? null });
/** Write one property. `expected` is the undo guard (SUB-477): omit it and the
    write is unconditional, as it has always been; pass `{ value }` and the
    write is refused with "conflict: property changed on disk" unless the prop
    on disk still equals that value (`{ value: null }` = "expected absent").
    The reply's `prior` is the value replaced — the argument that inverts it. */
export const vaultSetProp = (
  path: string,
  key: string,
  value: PropValue,
  expected?: { value: PropValue }
) => invoke<SetPropResult>("vault_set_prop", { path, key, value, expected: expected ?? null });
/** Raw frontmatter block + health (SUB-430); null = the note has no block. */
export const vaultFmRaw = (path: string) =>
  historyProjection
    ? // SUB-822: serve the snapshot's own frontmatter. Falling back to the
      // live block would be worse than null — the props panel would show
      // today's frontmatter above a historical body.
      Promise.resolve<FmState | null>(clone(historyProjection.fm[path] ?? null))
    : invoke<FmState | null>("vault_fm_raw", { path });
/** Replace the frontmatter block (body preserved); rejects a still-broken
    block with its bare diagnosis. Empty fm removes the block. */
export const vaultFmWrite = (path: string, fm: string) =>
  invoke<NoteMeta>("vault_fm_write", { path, fm });
export const vaultCreate = (
  title: string,
  folder?: string,
  type?: string,
  props?: [string, string][],
  body?: string
) =>
  invoke<NoteMeta>("vault_create", {
    title,
    folder,
    noteType: type ?? null,
    props: props ?? null,
    body: body ?? null,
  });
/** A type's `.vault/templates/<type>.md` note (frontmatter defaults + body
    skeleton), null when the type has no template. */
export const vaultTemplateRead = (type: string) =>
  invoke<NoteContent | null>("vault_template_read", { noteType: type });
/** Types that have a template note under `.vault/templates/`. */
export const vaultTemplateList = () => invoke<string[]>("vault_template_list");
export const urlCapture = (url: string) => invoke<NoteMeta>("url_capture", { url });
/** Today's USD→EUR reference rate (SUB-667). Engine-side because the shipped
    CSP allows no remote origin — a browser fetch here only ever worked in the
    browser lane. Rejects rather than reporting a rate it isn't sure of. */
export const fxUsdEur = () => invoke<{ usdEur: number; asOf: string }>("fx_usd_eur");
/** Cached read-only external calendar events. This call never waits on a URL
    or local `.ics` file; the backend refresh loop updates the cache separately. */
export const calendarFeedsRead = (start: string, end: string) =>
  invoke<CalendarFeedSnapshot>("calendar_feeds_read", { start, end });
export const calendarFeedSave = (feed: CalendarFeedConfig, originalUrl?: string) =>
  invoke<CalendarFeedConfig[]>("calendar_feed_save", {
    feed,
    originalUrl: originalUrl ?? null,
  });
export const calendarFeedDelete = (url: string) =>
  invoke<CalendarFeedConfig[]>("calendar_feed_delete", { url });
/** Resolves false when a refresh was already running, so the press did
    nothing — the caller says so instead of leaving the button looking idle. */
export const calendarFeedsRefresh = () => invoke<boolean>("calendar_feeds_refresh");
/** Upload a sealed handoff payload to the relay (SUB-833); returns the
    handoff id. Engine-side for the same CSP reason as fxUsdEur, plus the
    SSRF guard on the user-configured relay URL. The key never rides along —
    it exists only in the link the frontend builds. */
export const shareUpload = (relayUrl: string, payloadB64: string, expiry: string, token?: string) =>
  invoke<string>("share_upload", { relayUrl, payloadB64, expiry, token: token || null });
/** Renames, and reports every note it rewrote (`touched`) — the link sweep
    reaches third-party notes, and undo has to invalidate on all of them
    (SUB-515). */
export const vaultRename = (path: string, title: string) =>
  invoke<RenameResult>("vault_rename", { path, title });
// both resolve to the trash id they created — restore by that id, never by a
// path scan of the trash listing (SUB-478: the same path can sit there twice)
export const vaultDelete = (path: string) => invoke<string>("vault_delete", { path });
/** Bulk trash: ONE call for a whole selection, so every note in it shares a
    `deleted_ms` and the Trash pane lists the group together in path order
    (SUB-577). Resolves to one result per input path, in order — `Ok` carries
    the trash id, `Err` the message, so a partial failure stays attributable. */
export const vaultDeleteMany = (paths: string[]) =>
  invoke<{ Ok?: string; Err?: string }[]>("vault_delete_many", { paths });
export const vaultDeleteFolder = (path: string) =>
  invoke<string>("vault_delete_folder", { path });
export const vaultTrashList = () => invoke<TrashEntry[]>("vault_trash_list");
export const vaultTrashRestore = (id: string) => invoke<NoteMeta>("vault_trash_restore", { id });
export const vaultTrashDelete = (id: string) => invoke<void>("vault_trash_delete", { id });
export const vaultTrashEmpty = () => invoke<void>("vault_trash_empty");
export const vaultTrashRestoreFolder = (id: string) =>
  invoke<string>("vault_trash_restore_folder", { id });
export const vaultTrashDeleteFolder = (id: string) =>
  invoke<void>("vault_trash_delete_folder", { id });
/** Restore a deleted database's template (SUB-781); resolves to the stem it
    landed under — numbered when the type has been given a new template since. */
export const vaultTrashRestoreTemplate = (id: string) =>
  invoke<string>("vault_trash_restore_template", { id });
export const vaultTrashDeleteTemplate = (id: string) =>
  invoke<void>("vault_trash_delete_template", { id });
/** `scope`, when given, is the allow-list of paths the caller's structured
    filters left standing (SUB-566) — the engine applies it BEFORE its result
    cap, so the page comes from notes the user can actually see. Omit it when
    the query has no filters. `excludeAppFiles` mirrors the conceal toggle
    (SUB-831/878): pass true while the app hides AGENTS.md/CLAUDE.md/
    Settings.md so the engine's counts and page slots skip them too (SUB-907).
    The historical projection applies the same boundary (SUB-822) — a snapshot
    search must not surface files the live conceal toggle hides. */
const historySearchNotes = (q: string, scope?: string[], excludeAppFiles?: boolean) => {
  if (!historyProjection) return [];
  const needle = q.trim().toLocaleLowerCase();
  if (!needle) return [];
  const allowed = scope ? new Set(scope) : null;
  return historyProjection.notes.filter((note) => {
    if (excludeAppFiles && isAppFile(note.path)) return false;
    if (allowed && !allowed.has(note.path)) return false;
    const content = historyProjection?.contents[note.path];
    return `${note.title}\n${content?.body ?? ""}`.toLocaleLowerCase().includes(needle);
  });
};

const highlightedParts = (text: string, q: string) => {
  const needle = q.trim().toLocaleLowerCase();
  if (!needle) return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  const lower = text.toLocaleLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const start = lower.indexOf(needle, cursor);
    if (start < 0) {
      parts.push({ text: text.slice(cursor), hit: false });
      break;
    }
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    parts.push({ text: text.slice(start, start + needle.length), hit: true });
    cursor = start + needle.length;
  }
  return parts.length ? parts : [{ text, hit: false }];
};

export const vaultSearch = (q: string, scope?: string[], excludeAppFiles?: boolean) => {
  if (!historyProjection) return invoke<SearchHit[]>("vault_search", { q, scope, excludeAppFiles });
  return Promise.resolve(
    historySearchNotes(q, scope, excludeAppFiles).map((note) => ({
      path: note.path,
      snippet: historyProjection?.contents[note.path]?.body.split("\n").find((line) =>
        line.toLocaleLowerCase().includes(q.trim().toLocaleLowerCase()),
      ) ?? note.title,
    })),
  );
};
export const vaultSearchFull = (q: string, scope?: string[], excludeAppFiles?: boolean) => {
  if (!historyProjection)
    return invoke<FullSearchResult>("vault_search_full", { q, scope, excludeAppFiles });
  const needle = q.trim().toLocaleLowerCase();
  const all = historySearchNotes(q, scope, excludeAppFiles);
  const hits = all.slice(0, 200).map((note) => {
    const body = historyProjection?.contents[note.path]?.body ?? "";
    const matchingLines = body.split("\n").flatMap((line, index) =>
      line.toLocaleLowerCase().includes(needle)
        ? [{ line: index + 1, parts: highlightedParts(line, q) }]
        : [],
    );
    return {
      path: note.path,
      title_parts: highlightedParts(note.title, q),
      total: matchingLines.length + (note.title.toLocaleLowerCase().includes(needle) ? 1 : 0),
      matches: matchingLines.slice(0, 20),
    };
  });
  return Promise.resolve({ hits, total_notes: all.length, truncated: all.length > hits.length });
};
export const vaultBacklinks = (path: string) => {
  if (!historyProjection) return invoke<NoteMeta[]>("vault_backlinks", { path });
  const target = historyProjection.notes.find((note) => note.path === path);
  if (!target) return Promise.resolve([]);
  const names = new Set([target.stem.toLowerCase(), target.title.toLowerCase()]);
  const links = /!?\[\[([^[]+?)\]\]/g;
  const out = historyProjection.notes.filter((note) => {
    const body = historyProjection?.contents[note.path]?.body ?? "";
    for (const match of body.matchAll(links)) {
      if (!match[0].startsWith("!") && names.has(match[1].trim().toLowerCase())) return true;
    }
    return false;
  });
  return Promise.resolve(clone(out));
};
export const vaultRelated = (path: string) =>
  historyProjection
    ? Promise.resolve<RelatedEntry[]>([])
    : invoke<RelatedEntry[]>("vault_related", { path });
export const vaultResolve = (name: string) => {
  if (!historyProjection) return invoke<NoteMeta | null>("vault_resolve", { name });
  const key = name.trim().replace(/\.md$/i, "").toLowerCase();
  const note = historyProjection.notes.find(
    (candidate) =>
      candidate.path.toLowerCase() === name.trim().toLowerCase() ||
      candidate.stem.toLowerCase() === key ||
      candidate.title.toLowerCase() === key
  );
  return Promise.resolve(note ? clone(note) : null);
};
export const vaultSaveAsset = (name: string, dataB64: string) =>
  invoke<string>("vault_save_asset", { name, data: dataB64 });
export const vaultReadAsset = (name: string) => invoke<string>("vault_read_asset", { name });
export const vaultImportAsset = (path: string) =>
  invoke<string>("vault_import_asset", { path });
export const vaultLinkAsset = (path: string) =>
  invoke<string>("vault_link_asset", { path });
/** Physical Shift state at drop time (SUB-438) — Tauri drop events carry no
    modifiers, so the handler asks the OS. Always false off macOS. */
export const dropShiftDown = () => invoke<boolean>("drop_shift_down");
export const vaultAssetInfo = (name: string) => invoke<AssetInfo>("vault_asset_info", { name });
export const vaultAssetsOrphaned = () => invoke<AssetInfo[]>("vault_assets_orphaned");
/** Move `.assets/` files to the trash (SUB-479) — recoverable, not unlinked.
    Resolves to one result per input name, in order (SUB-669): `Ok` carries the
    trash id (empty when the name was already gone), `Err` the message, so a
    partial failure still says how many landed and which names did not. The
    call itself rejects only on up-front validation, before anything moves. */
export const vaultAssetsDelete = (names: string[]) =>
  invoke<{ Ok?: string; Err?: string }[]>("vault_assets_delete", { names });
/** Restore a trashed asset; resolves to the name it landed under. */
export const vaultAssetsRestore = (id: string) =>
  invoke<string>("vault_assets_restore", { id });
export const vaultAssetsTrashDelete = (id: string) =>
  invoke<void>("vault_assets_trash_delete", { id });
/** Read-only integrity scan (SUB-432) — reports, never repairs. */
export const vaultDoctor = () => invoke<DoctorReport>("vault_doctor");
export const vaultSyncPush = () => invoke<SyncReport>("vault_sync_push");
export const vaultSyncPull = () => invoke<SyncReport>("vault_sync_pull");
export const vaultSyncStatus = () => invoke<VaultSyncStatus>("vault_sync_status");
/** Raw tokens use HTTP Basic as the password; prefix with `Bearer ` or pass
    an explicit `Basic ` authorization value when the endpoint requires it.
    `cert` pins a self-signed server certificate (PEM) — required for private
    endpoints because the sync stack does not read the OS trust store. */
export const vaultSyncSetRemote = (url: string, token: string, cert?: string) =>
  invoke<void>("vault_sync_set_remote", { url, token, cert: cert ?? null });
/** The pending conflicted pull, recomputed from git on every call. */
export const vaultSyncConflicts = () => invoke<ConflictState>("vault_sync_conflicts");
export const vaultSyncResolveSet = (path: string, choice: ConflictChoice) =>
  invoke<ConflictState>("vault_sync_resolve_set", { path, choice });
export const vaultSyncResolveClear = (path: string) =>
  invoke<ConflictState>("vault_sync_resolve_clear", { path });
/** Commits the merge once every conflicted file has a choice. */
export const vaultSyncResolveFinish = () => invoke<SyncReport>("vault_sync_resolve_finish");
export const historyList = (path: string) => invoke<HistoryEntry[]>("history_list", { path });
export const historyPoints = () => invoke<VaultHistoryPoint[]>("history_points");
export const historyDiff = (id: string, file: string) =>
  invoke<DiffLine[]>("history_diff", { id, file });
/** `baselineMs` is the `updated_ms` the caller is rendering. When the file on
    disk turns out to be newer, the restore still runs and the backend emits
    `history:restored-over-external` so the buried edit is announced (SUB-781). */
export const historyRestore = (path: string, id: string, file: string, baselineMs?: number) =>
  invoke<NoteMeta>("history_restore", { path, id, file, baselineMs });
export const historyPurgeNote = (path: string) =>
  invoke<void>("history_purge_note", { path });
export const historyPurgeNotes = (paths: string[]) =>
  invoke<void>("history_purge_notes", { paths });
export const historyTrim = (beforeMs: number) => invoke<void>("history_trim", { beforeMs });
export const historyStatus = () => invoke<HistoryStatus>("history_status");
export const exportText = (dest: string, contents: string) =>
  invoke<void>("export_text", { dest, contents });
export const exportNoteBundle = (path: string, destDir: string) =>
  invoke<number>("export_note_bundle", { path, destDir });
export const printWindow = () => invoke<void>("print_window");
export const vaultViewsRead = () =>
  historyProjection
    ? Promise.resolve(clone(historyProjection.views))
    : invoke<ViewsConfig>("vault_views_read");
export const vaultSchemaRead = () =>
  historyProjection
    ? Promise.resolve(clone(historyProjection.schema))
    : invoke<SchemaConfig>("vault_schema_read");
export const vaultSchemaSet = (
  dbType: string,
  prop: string,
  options: SelectOption[],
  kind?: PropKind,
  notify?: boolean,
  /** date kind only (SUB-842): lead-time alert N days before; 0 clears it */
  notifyBefore?: number,
  target?: string,
  format?: NumberFormat,
  description?: string,
  /** rollup kind only (SUB-678): the derived column's wiring */
  rollup?: RollupConfig | null
) =>
  invoke<SchemaConfig>("vault_schema_set", {
    dbType,
    prop,
    options,
    kind: kind ?? null,
    notify: notify ?? null,
    notifyBefore: notifyBefore ?? null,
    target: target ?? null,
    format: format ?? null,
    description: description ?? null,
    relation: rollup?.relation ?? null,
    rollupProp: rollup?.prop ?? null,
    agg: rollup?.agg ?? null,
  });
/** Set or clear a database's icon (SUB-27) — the whole icon at once; null
    removes it (auto-glyph fallback). */
export const vaultSchemaSetIcon = (dbType: string, icon: DbIcon | null) =>
  invoke<SchemaConfig>("vault_schema_set_icon", {
    dbType,
    glyph: icon?.glyph ?? null,
    emoji: icon?.emoji ?? null,
    tint: icon?.tint ?? null,
  });
/** Set or clear a database's home folder (SUB-85) — null clears it (the
    database leaves the Folders tree and lists under Databases again). */
export const vaultSchemaHomeSet = (dbType: string, home: string | null) =>
  invoke<SchemaConfig>("vault_schema_home_set", { dbType, home });
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });
export const fileOpen = (path: string) => invoke<void>("file_open", { path });
export const fileReveal = (path: string) => invoke<void>("file_reveal", { path });
export const filePick = (dir: boolean, extensions?: string[]) =>
  invoke<string | null>("file_pick", { dir, extensions: extensions ?? null });
/** Read a text file the user picked outside the vault (CSV import) — the
    engine caps the size and reads, never writes. */
export const fileReadText = (path: string) => invoke<string>("file_read_text", { path });
export const vaultViewsSet = (
  db: string,
  view: DbLayout,
  groupBy?: string,
  tableGroupBy?: string,
  aggregations?: Record<string, AggKind>,
  sorts?: SavedViewSort[],
  hidden?: string[],
  widths?: Record<string, number>,
  wrap?: string[],
  grid?: boolean,
  hiddenPerLayout?: HiddenPerLayout
) =>
  invoke<ViewsConfig>("vault_views_set", {
    db,
    view,
    groupBy: groupBy ?? null,
    tableGroupBy: tableGroupBy ?? null,
    aggregations: aggregations ?? null,
    sorts: sorts ?? null,
    hidden: hidden ?? null,
    widths: widths ?? null,
    wrap: wrap ?? null,
    grid: grid ?? null,
    hiddenPerLayout: hiddenPerLayout ?? null,
  });
export const vaultFolders = () =>
  historyProjection
    ? Promise.resolve(clone(historyProjection.folders))
    : invoke<string[]>("vault_folders");
export const vaultCreateFolder = (path: string) =>
  invoke<string>("vault_create_folder", { path });
export const vaultRenameFolder = (path: string, name: string) =>
  invoke<string>("vault_rename_folder", { path, name });
/** Move a folder under another parent ("" = vault root), keeping its name
    (SUB-698) — the directory sibling of `vaultMove`. Resolves to the folder's
    new vault-relative path. */
export const vaultMoveFolder = (path: string, folder: string) =>
  invoke<string>("vault_move_folder", { path, folder });
export const vaultMove = (path: string, folder: string) =>
  invoke<NoteMeta>("vault_move", { path, folder });
export const vaultSidebarOrder = () =>
  historyProjection
    ? Promise.resolve(clone(historyProjection.sidebar_order))
    : invoke<SidebarOrder>("vault_sidebar_order");
export const vaultSetSidebarOrder = (order: SidebarOrder) =>
  invoke<SidebarOrder>("vault_set_sidebar_order", { order });
/** Per-folder metadata (SUB-84): vault-relative folder path → icon. */
export const vaultFolderMetaRead = () =>
  historyProjection
    ? Promise.resolve(clone(historyProjection.folder_meta))
    : invoke<FolderMetaMap>("vault_folder_meta_read");
/** Set or clear a folder's icon (SUB-84) — the whole icon at once; null
    removes it (plain folder glyph fallback). */
export const vaultFolderIconSet = (path: string, icon: DbIcon | null) =>
  invoke<FolderMetaMap>("vault_folder_icon_set", {
    path,
    glyph: icon?.glyph ?? null,
    emoji: icon?.emoji ?? null,
    tint: icon?.tint ?? null,
  });
export const folderDbsRescan = () => invoke<FolderScanStats[]>("folder_dbs_rescan");
/** The folder→database mappings from `.vault/folders.json` (SUB-672). */
export const folderDbsList = () => invoke<FolderMapping[]>("folder_dbs_list");
/** "Map a folder…" (SUB-672): append one mapping to `.vault/folders.json`.
    Resolves to the full list as written; run `folderDbsRescan` right after
    for the first sync. */
export const folderDbsAdd = (path: string, dbType: string, globs: string[], watch: boolean) =>
  invoke<FolderMapping[]>("folder_dbs_add", { path, dbType, globs, watch });
// Tray agenda popover (SUB-30): window management lives Rust-side
export const agendaOpenNote = (path: string) => invoke<void>("agenda_open_note", { path });
export const agendaOpenCapture = () => invoke<void>("agenda_open_capture");
/** Fit the tray popover to its rendered card (SUB-746). `height` is the
    card's logical height; Rust clamps it and re-anchors under the tray icon. */
export const agendaResize = (height: number) => invoke<void>("agenda_resize", { height });
export const vaultSavedViewsRead = () =>
  historyProjection
    ? Promise.resolve(clone(historyProjection.saved_views))
    : invoke<SavedView[]>("vault_saved_views_read");
export const vaultSavedViewSet = (view: SavedView) =>
  invoke<SavedView[]>("vault_saved_view_set", { view });
export const vaultSavedViewDelete = (id: string) =>
  invoke<SavedView[]>("vault_saved_view_delete", { id });
/** Create a database: register the type (+ optional initial props) in the
    schema so it lists in the sidebar even with zero notes. */
export const vaultCreateType = (name: string, props: NewTypeProp[]) =>
  invoke<SchemaConfig>("vault_create_type", { name, props });
/** Rename a database: bulk `type:` rewrite + schema key move (relation
    targets, views pref, sidebar order, template follow). Snapshot first.
    A `failed` sweep stopped partway — report its count too (SUB-501). */
export const vaultRenameType = (oldName: string, newName: string) =>
  invoke<BulkSweep>("vault_rename_type", { old: oldName, new: newName });
/** Delete a database: `trashNotes` false strips `type:` from its notes, true
    moves them all to the trash. Snapshot first. */
export const vaultDeleteType = (dbType: string, trashNotes: boolean) =>
  invoke<BulkSweep>("vault_delete_type", { dbType, trashNotes });
/** Rename one property: schema key move + bulk frontmatter key rewrite
    across the type's notes. Snapshot first. */
export const vaultRenameProp = (dbType: string, oldName: string, newName: string) =>
  invoke<BulkSweep>("vault_rename_prop", { dbType, old: oldName, new: newName });
/** Clean a removed property out of saved metadata. `stripValues` is true only
    for the separately-confirmed note-value sweep; snapshot that form first. */
export const vaultClearProp = (
  dbType: string,
  prop: string,
  wasNumber: boolean,
  stripValues: boolean
) => invoke<BulkSweep>("vault_clear_prop", { dbType, prop, wasNumber, stripValues });
/** On-demand history snapshot — the safety rail taken immediately before a
    bulk rewrite. Resolves whether a restore point EXISTS: false only when
    history is disabled (the vault is the user's own repo), never merely
    because the tree was already clean. */
export const historySnapshot = (label: string) =>
  invoke<boolean>("history_snapshot", { label });


/* Real-app smoke lane (SUB-426). Both refuse unless the engine
   saw SUBSTRATE_SMOKE=1; only src/lib/smoke.ts calls them, and that module is
   tree-shaken out of production builds. */
/** Drop a file in `$SUBSTRATE_SMOKE_DIR` — the driver's channel to the
    outside smoke script (handshakes + the result JSON). */
export const smokeSignal = (name: string, contents: string) =>
  invoke<void>("smoke_signal", { name, contents });
/** Quit through Tauri's own exit path, so RunEvent::Exit really runs. */
export const smokeExit = (code: number) => invoke<void>("smoke_exit", { code });
