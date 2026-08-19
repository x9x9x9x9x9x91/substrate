import { invoke, setHistoryReadOnly } from "./tauri.ts";
import { isAppFile, SETTINGS_PATH } from "./settings.ts";
import type { KindBundleInfo } from "./kinds.ts";
import type { ReflexReceipt, ReflexStatus } from "./reflexes.ts";
import type { CodingScan } from "./codingScan.ts";
import type { OnboardingStatus, VaultCandidate } from "./onboarding.ts";
import type { WidgetSummary } from "./widgets.ts";
import type {
  AggKind,
  AssetInfo,
  BulkSweep,
  CalendarFeedConfig,
  CalendarFeedSnapshot,
  ConflictChoice,
  ConflictState,
  CookbookInstall,
  CuratorRun,
  DbIcon,
  DbLayout,
  DeeplinkResolved,
  DiffLine,
  DoctorReport,
  DriveEntry,
  DriveHit,
  DriveInfo,
  FmState,
  FolderListing,
  FolderMetaMap,
  Mount,
  MountInfo,
  MountRow,
  MountScanStats,
  FullSearchResult,
  RecallResult,
  RecallStats,
  RecallStatus,
  FactLane,
  HistorySheetsAt,
  HiddenPerLayout,
  HistoryEntry,
  HistoryStatus,
  HistoryVaultSnapshot,
  Freshness,
  Job,
  JobRun,
  LaunchdJob,
  NewTypeProp,
  NoteContent,
  NoteMeta,
  NumberFormat,
  PropKind,
  PropValue,
  RelatedEntry,
  RemoteSetup,
  RenameResult,
  RollupConfig,
  SavedView,
  SavedViewSort,
  SchemaConfig,
  SearchHit,
  SealResult,
  SealScopeInfo,
  SealScopeResult,
  SelectOption,
  SetPropResult,
  SidebarOrder,
  SyncConfig,
  SyncReport,
  SyncRun,
  SyncStateFile,
  TagCount,
  TagFolder,
  TrashEntry,
  VaultSyncStatus,
  ViewExportReport,
  ViewsConfig,
  VaultHistoryPoint,
} from "./types";

let historyProjection: HistoryVaultSnapshot | null = null;
/** true from historyEnter until the write guard is released again — spans the
    present-mode reload, where the projection is already gone. */
let pastSession = false;
const clone = <T,>(value: T): T => structuredClone(value);
/** perf: one deep copy of the projection's note list, made when the
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

/* Modules that stage unsaved text outside the mounted pane register
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
  // historical body.
  if (pastSession) for (const purge of historyLeaveHooks) purge();
  historyProjection = null;
  projectedNotes = [];
  if (unlock) pastSession = false;
  if (unlock) setHistoryReadOnly(false);
}

export const historyProjectionActive = () => historyProjection !== null;

/** The projection's own copy of a note's body, synchronously, or
    null when no projection is active or it held no such note. `vaultRead`
    answers from the same in-memory snapshot, but only ever as a promise — so
    a pane that waits for it paints one empty frame over data already in
    process. Read-only: the caller gets the string, never the object. */
export const projectedNoteBody = (path: string): string | null =>
  historyProjection?.contents[path]?.body ?? null;

export const vaultRoot = () => invoke<string>("vault_root");

/* first-run onboarding */
export const onboardingStatus = () => invoke<OnboardingStatus>("onboarding_status");
/** What a candidate folder is, before anything is written to it. */
export const vaultInspect = (path: string) => invoke<VaultCandidate>("vault_inspect", { path });
/** Validate + initialize + persist; `consent` = the user confirmed
    initializing inside a folder that already holds unrelated files. */
export const vaultChoose = (path: string, consent = false) =>
  invoke<string>("vault_choose", { path, consent });
/** Disposable copy of the bundled example vault, selected as the choice. */
export const vaultDemo = () => invoke<string>("vault_demo");
/** Write `terminal-command` into the just-chosen vault's Settings.md
    (pre-relaunch, so the ⌘⇧T terminal is wired from the first real session).
    Empty string clears the key — an un-picked chip. */
export const onboardingSetAgent = (command: string) =>
  invoke<null>("onboarding_set_agent", { command });
export const appRelaunch = () => invoke<null>("app_relaunch");
/** Native WidgetKit support exists only in the iOS target. Checking before
    evaluating any dashboard keeps desktop startup unchanged. */
export const widgetSummarySupported = () => invoke<boolean>("widget_summary_supported");
/** Replace the App Group's atomic, pre-rendered WidgetKit read model. */
export const widgetSummaryWrite = (summary: WidgetSummary) =>
  invoke<null>("widget_summary_write", { summary });
/** Card ids referenced by widgets actually placed on the home screen — the
    export allow-list. No placed widgets means no values leave the app. */
export const widgetConfiguredIds = () => invoke<string[]>("widget_configured_ids");
/* scoped MCP door — per-machine config, never Settings.md */
export type McpAccess = "read" | "write";
export interface McpGrant {
  client: string;
  prefix: string;
  access: McpAccess;
}
export interface McpSetup {
  binary_path: string;
  binary_available: boolean;
  client_config_path: string;
  claude_desktop_snippet: string;
}
export const mcpGrantsList = () => invoke<McpGrant[]>("mcp_grants_list");
export const mcpGrantPick = (client: string, access: McpAccess) =>
  invoke<McpGrant[]>("mcp_grant_pick", { client, access });
export const mcpGrantRevoke = (client: string, prefix: string) =>
  invoke<McpGrant[]>("mcp_grant_revoke", { client, prefix });
export const mcpGrantsRevokeAll = () => invoke<McpGrant[]>("mcp_grants_revoke_all");
export const mcpSetup = () => invoke<McpSetup>("mcp_setup");
/** What the door heard the last client call itself. Grants match this string
    exactly, so a stray space or a renamed product reads as "all grants live,
    every call denied" — showing it back is the whole diagnosis. */
export interface McpLastSeen {
  name: string;
  at: string;
}
export const mcpLastSeen = () => invoke<McpLastSeen | null>("mcp_last_seen");

export const vaultList = () =>
  historyProjection
    ? Promise.resolve(projectedNotes.slice())
    : invoke<NoteMeta[]>("vault_list");
/** Settings.md is app configuration, not vault content, and several
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
export const vaultSealedConfigured = () => invoke<boolean>("vault_sealed_configured");
export const vaultSealScopes = () => invoke<SealScopeInfo[]>("vault_seal_scopes");
export const vaultSealScope = (path: string, password?: string) =>
  invoke<SealScopeResult>("vault_seal_scope", {
    path,
    password: password ?? null,
  });
export const vaultConfirmSealScope = (path: string, password?: string) =>
  invoke<SealScopeResult>("vault_confirm_seal_scope", {
    path,
    password: password ?? null,
  });
export const vaultRemoveSealScope = (path: string) =>
  invoke<null>("vault_remove_seal_scope", { path });
export const vaultSealNote = (path: string, password?: string) =>
  invoke<SealResult>("vault_seal_note", { path, password: password ?? null });
export const vaultUnlockSealedNote = (path: string, password?: string) =>
  invoke<NoteContent>("vault_unlock_sealed_note", { path, password: password ?? null });
export const vaultLockSealedNote = (path: string) =>
  invoke<null>("vault_lock_sealed_note", { path });
export const vaultUnsealNote = (path: string) => invoke<NoteMeta>("vault_unseal_note", { path });
export const vaultWriteBody = (path: string, body: string, expectedBody?: string | null) =>
  invoke<NoteMeta>("vault_write_body", { path, body, expectedBody: expectedBody ?? null });
/** Write one property. `expected` is the undo guard: omit it and the
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
/** Turn a sheet column's date notifications on or off. Separate from
    `vaultSetProp` because the settings live in a nested `columns:` map and that
    command only writes scalars. `notifyBefore` is the lead-time in days
    (1..365, clamped); null/undefined leaves only the day-of alert. Clearing
    both removes the column's entry, and the last entry removes the map. */
export const sheetSetColumnNotify = (
  path: string,
  column: string,
  notify: boolean,
  notifyBefore?: number | null
) =>
  invoke<NoteMeta>("sheet_set_column_notify", {
    path,
    column,
    notify,
    notifyBefore: notifyBefore ?? null,
  });
/** Raw frontmatter block + health; null = the note has no block. */
export const vaultFmRaw = (path: string) =>
  historyProjection
    ? // Serve the snapshot's own frontmatter. Falling back to the
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
/** Custom dashboard kinds installed in this vault, each with the
    consent record for THIS vault when there is one — enough to run
    `resolveKindState` without a second round trip. Broken bundles are in the
    list too, carrying the reason they are broken. */
export const kindsList = () => invoke<KindBundleInfo[]>("kinds_list");
/** Record consent to run `id`'s code at exactly `hash` — the hash the enable
    card showed. Rejects if the bundle changed since, so consent is never
    applied to bytes nobody read. */
export const kindsEnable = (id: string, hash: string) =>
  invoke<void>("kinds_enable", { id, hash });
/** Turn the standing "trust updates to this kind in this vault" rider on or
    off. Only ever edits a consent that already exists: a no-op for a
    kind nobody enabled, because it carries a decision forward and never makes
    one. */
export const kindsSetTrust = (id: string, trust: boolean) =>
  invoke<void>("kinds_set_trust", { id, trust });
/** Withdraw consent. Never fails on an unknown id — a bundle deleted from the
    vault still has to be revocable. */
export const kindsDisable = (id: string) => invoke<void>("kinds_disable", { id });
/** This vault's reflex rules — what the file says, what the runtime
    remembers about each rule, and whether this device has armed the feature at
    all. One round trip so the rule list can't be a call stale against the
    switch that governs it. */
export const reflexesStatus = () => invoke<ReflexStatus>("reflexes_status");
/** Arm reflexes for this vault on this device. One switch for the whole
    feature: after this, rule edits need no re-approval. */
export const reflexesEnable = () => invoke<void>("reflexes_enable");
/** Stop for now, keeping the decision — unlike `reflexesDisable`, re-arming is
    one click and not a fresh grant of trust. */
export const reflexesSetPaused = (paused: boolean) =>
  invoke<void>("reflexes_set_paused", { paused });
/** Withdraw the enable entirely: back to the first-run state. */
export const reflexesDisable = () => invoke<void>("reflexes_disable");
/** The receipts log, newest first. */
export const reflexesReceipts = () => invoke<ReflexReceipt[]>("reflexes_receipts");
/** Capture a pasted link as a reference note. `enrich` decides
    whether the engine then asks that site for its page title — the caller
    reads `net-link-titles` from Settings.md; the note is created either way,
    keeping the bare URL as its title when the fetch is off. */
export const urlCapture = (url: string, enrich = true) =>
  invoke<NoteMeta>("url_capture", { url, enrich });
/** Today's USD→EUR reference rate. Engine-side because the shipped
    CSP allows no remote origin — a browser fetch here only ever worked in the
    browser lane. Rejects rather than reporting a rate it isn't sure of. */
export const fxUsdEur = () => invoke<{ usdEur: number; asOf: string }>("fx_usd_eur");
/** The whole majors table — one call, every pair the app converts.
    Same engine-side reasoning as fxUsdEur. */
export const fxRates = () =>
  invoke<{ base: string; rates: Record<string, number>; asOf: string }>("fx_rates");
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
/** Upload a sealed handoff payload to the relay; returns the
    handoff id. Engine-side for the same CSP reason as fxUsdEur, plus the
    SSRF guard on the user-configured relay URL. The key never rides along —
    it exists only in the link the frontend builds. */
export const shareUpload = (relayUrl: string, payloadB64: string, expiry: string, token?: string) =>
  invoke<string>("share_upload", { relayUrl, payloadB64, expiry, token: token || null });
/** Renames, and reports every note it rewrote (`touched`) — the link sweep
    reaches third-party notes, and undo has to invalidate on all of them. */
export const vaultRename = (path: string, title: string) =>
  invoke<RenameResult>("vault_rename", { path, title });
// both resolve to the trash id they created — restore by that id, never by a
// path scan of the trash listing (the same path can sit there twice)
export const vaultDelete = (path: string) => invoke<string>("vault_delete", { path });
/** Bulk trash: ONE call for a whole selection, so every note in it shares a
    `deleted_ms` and the Trash pane lists the group together in path order.
    Resolves to one result per input path, in order — `Ok` carries
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
/** Restore a deleted database's template; resolves to the stem it
    landed under — numbered when the type has been given a new template since. */
export const vaultTrashRestoreTemplate = (id: string) =>
  invoke<string>("vault_trash_restore_template", { id });
export const vaultTrashDeleteTemplate = (id: string) =>
  invoke<void>("vault_trash_delete_template", { id });
/** `scope`, when given, is the allow-list of paths the caller's structured
    filters left standing — the engine applies it BEFORE its result
    cap, so the page comes from notes the user can actually see. Omit it when
    the query has no filters. `excludeAppFiles` mirrors the conceal toggle:
    pass true while the app hides AGENTS.md/CLAUDE.md/
    Settings.md so the engine's counts and page slots skip them too.
    The historical projection applies the same boundary — a snapshot
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
      // a projection searches title and body text only — no props to name
      prop_snippet: null,
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
      // a projection searches the notes a snapshot holds, whole — mounted
      // files are this machine's, not the snapshot's
      partial: false,
      // …and it never matched a prop, so there is none to show
      prop_parts: [],
    };
  });
  return Promise.resolve({ hits, total_notes: all.length, truncated: all.length > hits.length });
};
/** Deep Recall — search the vault's past rather than its present.
 *  Deliberately NOT history-projection-aware like the searches above: a
 *  projection is one moment reconstructed in the client, and recall's whole
 *  subject is every moment. It answers off the index either way.
 *  `excludeAppFiles` mirrors the conceal toggle the live searches take: past
 *  versions of a concealed file stay concealed. */
export const recallSearch = (q: string, excludeAppFiles?: boolean) =>
  invoke<RecallResult>("recall_search", { q, excludeAppFiles });
export const recallStatus = () => invoke<RecallStatus>("recall_status");
export const recallSetEnabled = (enabled: boolean) =>
  invoke<RecallStatus>("recall_set_enabled", { enabled });
/** Walk whatever history is not indexed yet. Slow only the first time;
 *  progress arrives on the `recall:index` event. */
export const recallIndex = () => invoke<RecallStats>("recall_index");

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
/* Voice capture. The recording lives in the backend, not the webview: it must
   survive the capture window losing focus or being hidden, and a MediaRecorder
   in a hidden window is at the mercy of the OS. */
/** Whether this build can record at all — false off macOS, where the UI hides
    the affordance instead of offering a button that always fails. */
export const voiceSupported = () => invoke<boolean>("voice_supported");
/** Start recording; resolves with the stem the capture will be filed under
    (`Voice 2026-08-04 14.32`). Rejects with a human-readable reason when the
    microphone is missing, refused or busy. */
export const voiceStart = () => invoke<string>("voice_start");
/** Stop recording and file it as a `type: voice` note in Inbox. */
export const voiceStop = () => invoke<NoteMeta>("voice_stop");
/** Stop and discard. Never rejects for "wasn't recording". */
export const voiceCancel = () => invoke<void>("voice_cancel");
/** Whether a recording is in flight — asked on mount so a reopened capture
    window rejoins an in-progress recording instead of showing idle. */
export const voiceIsRecording = () => invoke<boolean>("voice_is_recording");
/** Speech model: whether it's installed, and how far a download has got.
    `bytes` is the part-file's size while one is running. */
export type VoiceModelState = {
  installed: boolean;
  bytes: number;
  expected_bytes: number;
};
export const voiceModelState = () => invoke<VoiceModelState>("voice_model_state");
/** Start the one-time model download. Returns immediately; progress arrives as
    `voice:model` events and failure as `voice:model-error`. This is the only
    moment voice capture touches the network, and only because someone pressed
    the button. */
export const voiceModelDownload = () => invoke<void>("voice_model_download");
/** Transcribe a voice note again, replacing its body — for the transcript that
    came out wrong. The caller confirms first: the body is replaced. */
export const voiceTranscribe = (path: string) => invoke<void>("voice_transcribe", { path });
/** Physical Shift state at drop time — Tauri drop events carry no
    modifiers, so the handler asks the OS. Always false off macOS. */
export const dropShiftDown = () => invoke<boolean>("drop_shift_down");
export const vaultAssetInfo = (name: string) => invoke<AssetInfo>("vault_asset_info", { name });
/** Loose (non-note) files directly inside one folder — the folder
    view's file rows. Lazy per folder on purpose: the vault index stays
    `.md`-only, so a folder of masters costs one `read_dir` when you open it
    and nothing when you don't. `path` may be `""` for the vault root. */
export const vaultFolderFiles = (path: string) =>
  invoke<FolderListing>("vault_folder_files", { path });
export const vaultAssetsOrphaned = () => invoke<AssetInfo[]>("vault_assets_orphaned");
/** Move `.assets/` files to the trash — recoverable, not unlinked.
    Resolves to one result per input name, in order: `Ok` carries the
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
/** Read-only integrity scan — reports, never repairs. */
export const vaultDoctor = () => invoke<DoctorReport>("vault_doctor");
export const vaultSyncPush = (origin?: "auto") =>
  origin
    ? invoke<SyncReport>("vault_sync_push", { origin })
    : invoke<SyncReport>("vault_sync_push");
export const vaultSyncPull = (origin?: "auto") =>
  origin
    ? invoke<SyncReport>("vault_sync_pull", { origin })
    : invoke<SyncReport>("vault_sync_pull");
export const vaultSyncStatus = () => invoke<VaultSyncStatus>("vault_sync_status");
/** Raw tokens use HTTP Basic as the password; prefix with `Bearer ` or pass
    an explicit `Basic ` authorization value when the endpoint requires it.
    `cert` pins a self-signed server certificate (PEM) — required for private
    endpoints because the sync stack does not read the OS trust store.
    A `blob+https://` URL is an end-to-end-encrypted blob-store remote:
    it needs `passphrase` instead of `cert`, and the caller must pass the
    passphrase NFC-normalized so the same typed phrase unwraps the key on
    every platform. */
export const vaultSyncSetRemote = (
  url: string,
  token: string,
  cert?: string,
  passphrase?: string,
) =>
  invoke<RemoteSetup>("vault_sync_set_remote", {
    url,
    token,
    cert: cert ?? null,
    passphrase: passphrase ?? null,
  });
/** Re-wrap the vault master key under a new passphrase. The key itself does
    not change, so every device already enrolled keeps syncing untouched — the
    new phrase is what a future device (or this one after a reinstall) types.
    Both phrases must be NFC-normalized by the caller, same as `setRemote`. */
export const vaultSyncChangePassphrase = (oldPassphrase: string, newPassphrase: string) =>
  invoke<void>("vault_sync_change_passphrase", {
    oldPassphrase,
    newPassphrase,
  });
/** The pending conflicted pull, recomputed from git on every call. */
export const vaultSyncConflicts = () => invoke<ConflictState>("vault_sync_conflicts");
export const vaultSyncResolveSet = (path: string, choice: ConflictChoice) =>
  invoke<ConflictState>("vault_sync_resolve_set", { path, choice });
export const vaultSyncResolveClear = (path: string) =>
  invoke<ConflictState>("vault_sync_resolve_clear", { path });
/** Commits the merge once every conflicted file has a choice. */
export const vaultSyncResolveFinish = () => invoke<SyncReport>("vault_sync_resolve_finish");
/** The user says they have dealt with the plaintext `privacy_error` warns
    about. Nothing else dismisses it except the cleanup itself succeeding on a
    later sync — a successful sync alone deliberately does not. */
export const vaultSyncAckPrivacy = () => invoke<void>("vault_sync_ack_privacy");
export const historyList = (path: string) => invoke<HistoryEntry[]>("history_list", { path });
export const historyPoints = () => invoke<VaultHistoryPoint[]>("history_points");
/** The history of specific frontmatter facts, for `AT()` / `PROP()` and the
    chart `history:` source. Batched: one call opens the repository
    once and walks the oldest-snapshot boundary once, however many facts a
    dashboard is asking about. */
export const historyFacts = (refs: { path: string; key: string }[]) =>
  invoke<FactLane[]>("history_facts", { refs });
/** Every sheet note as it stood at each instant, for `AT(date, Sheet.member)`.
    Instants rather than dates because "the last moment of that day"
    is the reader's own calendar, already resolved front-end for fact lanes —
    sending the instant keeps one definition of the boundary. Batched for the
    same reason as `historyFacts`: one repository walk per dashboard. */
export const historySheets = (instants: number[]) =>
  invoke<HistorySheetsAt[]>("history_sheets", { instants });
export const historyDiff = (id: string, file: string) =>
  invoke<DiffLine[]>("history_diff", { id, file });
/** `baselineMs` is the `updated_ms` the caller is rendering. When the file on
    disk turns out to be newer, the restore still runs and the backend emits
    `history:restored-over-external` so the buried edit is announced. */
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
/** Where this saved view exports to on this machine, or null if never asked. */
export const viewExportTarget = (viewId: string) =>
  invoke<string | null>("view_export_target", { viewId });
/** Rebuild the view's link folder at `dest` and remember it as the target. */
export const viewExportRun = (
  viewId: string,
  viewName: string,
  dest: string,
  paths: string[]
) => invoke<ViewExportReport>("view_export_run", { viewId, viewName, dest, paths });
/** Drop a remembered target — the folder on disk is left alone. */
export const viewExportForget = (viewId: string) =>
  invoke<void>("view_export_forget", { viewId });
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
  /** date kind only: lead-time alert N days before; 0 clears it */
  notifyBefore?: number,
  target?: string,
  format?: NumberFormat,
  description?: string,
  /** rollup kind only: the derived column's wiring */
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
/** Set or clear a database's icon — the whole icon at once; null
    removes it (auto-glyph fallback). */
export const vaultSchemaSetIcon = (dbType: string, icon: DbIcon | null) =>
  invoke<SchemaConfig>("vault_schema_set_icon", {
    dbType,
    glyph: icon?.glyph ?? null,
    emoji: icon?.emoji ?? null,
    tint: icon?.tint ?? null,
  });
/** Set or clear a database's home folder — null clears it (the
    database leaves the Folders tree and lists under Databases again). */
export const vaultSchemaHomeSet = (dbType: string, home: string | null) =>
  invoke<SchemaConfig>("vault_schema_home_set", { dbType, home });
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });
/** Read-only health of an external backup-sync system (sync dashboard): its
    state file and the recent errors of its log, under the note's bindings. */
export const syncStateRead = (cfg: SyncConfig) =>
  invoke<SyncStateFile>("sync_state_read", { cfg });
/** Health of the launchd agents under the note's label prefix. */
export const syncLaunchdRead = (cfg: SyncConfig) =>
  invoke<LaunchdJob[]>("sync_launchd_read", { cfg });
/** Allowlisted sync control: run takes a direction (a remote the state file
    names) + optional leg, pause/resume take the job's short name as
    `direction`. Returns the started registry entry — completion is polled
    via syncRuns. */
export const syncControl = (
  action: "run" | "pause" | "resume",
  direction: string,
  leg: string | undefined,
  cfg: SyncConfig
) => invoke<SyncRun>("sync_control", { action, direction, leg: leg ?? null, cfg });
/** Poll the sync manager's in-flight + finished runs. */
export const syncRuns = () => invoke<SyncRun[]>("sync_runs");
/** Machine-wide keep-awake flag: true = lid-close sleep disabled, null =
    pmset doesn't report it on this hardware. */
export const syncSleepRead = () => invoke<boolean | null>("sync_sleep_read");
/** Flip keep-awake (sudo -n pmset -a disablesleep); resolves to the
    read-back-verified state. */
export const syncSleepSet = (on: boolean) => invoke<boolean>("sync_sleep_set", { on });
/** Is there a launchd on this machine at all? Gates the jobs
    dashboard's control verbs — false off macOS, where the pane says so
    instead of offering buttons whose only outcome is an error. */
export const jobsAvailable = () => invoke<boolean>("jobs_available");
/** Health of every launchd agent under the jobs dashboard's prefix allowlist
    An empty list means the backend defaults. */
export const jobsRead = (prefixes: string[]) => invoke<Job[]>("jobs_read", { prefixes });
/** pause | resume | run one job. The label is validated against the jobs
    actually present under an allowed prefix before launchctl sees it, so an
    absent job is refused rather than acted on. */
export const jobsControl = (label: string, action: "pause" | "resume" | "run", prefixes: string[]) =>
  invoke<JobRun>("jobs_control", { label, action, prefixes });
/** Artifact-freshness probes ("label | note.md | prop | 26h"): is what this
    job produces still recent? Malformed specs are dropped, not errors. */
export const jobsFreshness = (specs: string[]) =>
  invoke<Freshness[]>("jobs_freshness", { specs });
/** Per-repo git health under a scan root (coding dashboard). `root` is the
    note's `root:` prop — null scans the default ~/Coding. force=true bypasses
    the backend's 1h scan cache (the refresh button). */
export const codingScan = (force: boolean, root?: string | null) =>
  invoke<CodingScan>("coding_scan", { force, root: root ?? null });
/** Run the vault's configured `feed-curator` command (feed
    dashboard) — one headless curation of the items sheet, cwd'd at
    the vault root. The caller passes the Settings.md command AFTER the
    per-machine trust gate has approved it. Refused while one is live;
    completion is polled via curatorRuns. */
export const curatorRefresh = (command: string) =>
  invoke<CuratorRun>("curator_refresh", { command });
/** Poll the curator's running + recently finished runs. */
export const curatorRuns = () => invoke<CuratorRun[]>("curator_runs");
/** Kill the live curation run. */
export const curatorCancel = (id: string) => invoke<void>("curator_cancel", { id });
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
  colOrder?: string[],
  hidden?: string[],
  widths?: Record<string, number>,
  wrap?: string[],
  grid?: boolean,
  hiddenPerLayout?: HiddenPerLayout,
  cardOrder?: string[]
) =>
  invoke<ViewsConfig>("vault_views_set", {
    db,
    view,
    groupBy: groupBy ?? null,
    tableGroupBy: tableGroupBy ?? null,
    aggregations: aggregations ?? null,
    sorts: sorts ?? null,
    colOrder: colOrder ?? null,
    hidden: hidden ?? null,
    widths: widths ?? null,
    wrap: wrap ?? null,
    grid: grid ?? null,
    hiddenPerLayout: hiddenPerLayout ?? null,
    cardOrder: cardOrder ?? null,
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
 — the directory sibling of `vaultMove`. Resolves to the folder's
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
/** Per-folder metadata: vault-relative folder path → icon. */
export const vaultFolderMetaRead = () =>
  historyProjection
    ? Promise.resolve(clone(historyProjection.folder_meta))
    : invoke<FolderMetaMap>("vault_folder_meta_read");
/** Set or clear a folder's icon — the whole icon at once; null
    removes it (plain folder glyph fallback). */
export const vaultFolderIconSet = (path: string, icon: DbIcon | null) =>
  invoke<FolderMetaMap>("vault_folder_icon_set", {
    path,
    glyph: icon?.glyph ?? null,
    emoji: icon?.emoji ?? null,
    tint: icon?.tint ?? null,
  });
/** Every tag in the vault with its note count, most-used first —
    the source for `#` autocomplete and the tag folder builder's chip picker. */
export const vaultTags = () => invoke<TagCount[]>("vault_tags");
/** Tag folder definitions from `.vault/tagfolders.json`. */
export const vaultTagFoldersRead = () => invoke<TagFolder[]>("vault_tag_folders_read");
/** Replace the whole tag folder list — ordering is the frontend's, as with
    saved views and the sidebar order. Resolves to the list as written. */
export const vaultTagFoldersWrite = (folders: TagFolder[]) =>
  invoke<TagFolder[]>("vault_tag_folders_write", { folders });
/** Add tags to a note — what acting inside a tag folder does. Writes only the
    `tags:` prop; the note never moves on disk. */
export const vaultNoteAddTags = (path: string, tags: string[]) =>
  invoke<NoteMeta>("vault_note_add_tags", { path, tags });
/** Reality mounts: a real folder rendered as a database, no import
    and no copies. `mounts.json` holds the portable half; the folder each mount
    points at is machine-local, which is why binding is its own call. */
export const mountsList = () => invoke<MountInfo[]>("mounts_list");
/** "Mount a folder…": register the mount, bind it to `path` on this machine,
    and scan it once so the board has rows immediately. The first scan's stats
    come back for the dialog to report; their `id` is the new mount's. */
export const mountAdd = (name: string, path: string, globs: string[], watch: boolean) =>
  invoke<MountScanStats>("mount_add", { name, path, globs, watch });
/** "Locate folder…": point an existing mount at a folder on THIS machine.
    `null` unbinds it here — the mount, its index and its sidecars all stay. */
export const mountBind = (id: string, path: string | null) =>
  invoke<MountScanStats>("mount_bind", { id, path });
/** Rescan mounts bound here — one when `id` is given, all of them otherwise.
    Unbound mounts are skipped, never errored. */
export const mountRescan = (id?: string) =>
  invoke<MountScanStats[]>("mount_rescan", { id: id ?? null });
/** A mount's rows: last-known index merged with the sidecars bound to it.
    Renders the same whether or not the folder is on this machine. */
export const mountRows = (id: string) => invoke<MountRow[]>("mount_rows", { id });
/** Set one prop on one row, creating its sidecar note on first annotation —
    the only write path a mount has. `null` clears the prop. */
export const mountAnnotate = (id: string, rel: string, prop: string, value: PropValue) =>
  invoke<NoteMeta>("mount_annotate", { id, rel, prop, value });
/** Unmount. `cleanup` false keeps every sidecar as an ordinary note; true
    trashes them (recoverable from Trash, never hard-deleted). */
export const mountRemove = (id: string, cleanup: boolean) =>
  invoke<Mount[]>("mount_remove", { id, cleanup });
/** The Drive Shelf: every external disk this vault has ever cataloged, online
    first. A drive is a mount carrying a volume mark, so everything above still
    applies to it — these are the calls a shelf needs on top. */
export const drivesList = () => invoke<DriveInfo[]>("drives_list");
/** Look at what is plugged in and act on the difference: adopt and scan a new
    volume, unbind one that vanished, keep every catalog either way. Slow (a
    scan walks a disk); resolves to the shelf as it now stands. */
export const drivesSync = () => invoke<DriveInfo[]>("drives_sync");
/** One level of a drive's catalog. Reads the index, never the disk — the same
    answer whether the drive is on the desk or in a drawer. */
export const driveEntries = (id: string, prefix: string) =>
  invoke<DriveEntry[]>("drive_entries", { id, prefix });
/** "Which disk is this file on?" across every catalog. Each hit carries its
    catalog's age, because an offline hit is not a claim about right now. */
export const driveSearch = (query: string) => invoke<DriveHit[]>("drive_search", { query });
/** "Forget this drive": drop the catalog and stop cataloging the volume on
    this machine. The disk is never touched. `cleanup` follows `mountRemove` —
    false keeps every sidecar written about a file on it, true trashes them. */
export const driveForget = (id: string, cleanup: boolean) =>
  invoke<DriveInfo[]>("drive_forget", { id, cleanup });
/** Undo a forget: catalog this volume again the next time it is seen. */
export const driveUnforget = (volume: string) =>
  invoke<void>("drive_unforget", { volume });
/** Volume ids this machine was told not to catalog — what makes a forget
    visible and reversible instead of a disk that never appears. */
export const drivesIgnored = () => invoke<string[]>("drives_ignored");
// Tray agenda popover: window management lives Rust-side
export const agendaOpenNote = (path: string) => invoke<void>("agenda_open_note", { path });
export const agendaOpenCapture = () => invoke<void>("agenda_open_capture");
/** Drain `substrate://` links the OS handed us. Called on mount —
    which is also what tells Rust the window is ready, so a cold-start link
    queued before the vault loaded resolves here — and again on
    `deeplink:pending`. Each entry carries either a note path to open or a
    message to show; a link that resolves to nothing is never silent. */
export const deeplinkTakePending = () => invoke<DeeplinkResolved[]>("deeplink_take_pending");
// Capture's side of the `substrate://capture?text=` handoff
// (`deeplink_capture_prefill` / `deeplink_clear_capture_prefill`) is invoked
// directly in capture.tsx, in that file's style — no wrapper here.
/** Fit the tray popover to its rendered card. `height` is the
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
    A `failed` sweep stopped partway — report its count too. */
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

/* The bundled dashboard cookbook — all three read the app bundle's
   own `cookbook/` folder; none of them reaches the network. */
/** The raw `index.json`; parse with `lib/cookbook.ts`. */
export const cookbookIndex = () => invoke<string>("cookbook_index");
/** A recipe's screenshot as base64, addressed by the index entry's `shot`. */
export const cookbookShot = (rel: string) => invoke<string>("cookbook_shot", { rel });
/** Copy a recipe's files into the vault, never overwriting: a taken path is
    written as `<stem> (cookbook).md` instead and reported in `renamed_from`. */
export const cookbookInstall = (id: string, files: string[]) =>
  invoke<CookbookInstall>("cookbook_install", { id, files });

/* Real-app smoke lane. Both refuse unless the engine
   saw SUBSTRATE_SMOKE=1; only src/lib/smoke.ts calls them, and that module is
   tree-shaken out of production builds. */
/** Drop a file in `$SUBSTRATE_SMOKE_DIR` — the driver's channel to the
    outside smoke script (handshakes + the result JSON). */
export const smokeSignal = (name: string, contents: string) =>
  invoke<void>("smoke_signal", { name, contents });
/** Quit through Tauri's own exit path, so RunEvent::Exit really runs. */
export const smokeExit = (code: number) => invoke<void>("smoke_exit", { code });
