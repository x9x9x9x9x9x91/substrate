/** App-machinery types, not databases: dashboards and sheets are
    surfaces the app renders, so they never collapse into database blocks,
    never list in All databases, and their date-shaped props never schedule
    (calendar.ts). One set, shared by every "is this type a database?" site. */
export const FUNCTIONAL_TYPES: ReadonlySet<string> = new Set(["dashboard", "sheet"]);

export interface NoteMeta {
  path: string;
  stem: string;
  title: string;
  folder: string;
  props: Record<string, unknown>;
  updated_ms: number;
  excerpt: string;
  /** The note's tag set: inline `#hashtags` unioned with the
      `tags:` prop, deduplicated case-insensitively, computed at index time.
      Optional so older projections (history snapshots) still typecheck. */
  tags?: string[];
  /** The note is whole-file encrypted on disk. REQUIRED, unlike
      `tags` above: every surface that decides whether to emit a body — export,
      duplicate, send-as-link — reads this, and an optional field lets a
      forgotten assignment read as "not sealed", which is the one wrong answer
      that leaks plaintext. The backend always sends it. */
  sealed: boolean;
}

export interface SealResult {
  meta: NoteMeta;
  device_unlock: boolean;
}

export interface SealScopeInfo {
  /** Empty string names the vault root. */
  path: string;
  state: "pending" | "active";
  /** False for a marker that arrived by sync or an external write and has not
      been confirmed on this device. Unconfirmed markers seal nothing, convert
      nothing, and never purge history. */
  confirmed: boolean;
}

export interface SealScopeResult {
  path: string;
  sealed: number;
  already_sealed: number;
  device_unlock: boolean;
}

/** Everything a single property can hold across the IPC boundary. `null` is
    the absence sentinel on both sides: as a write it removes the key, as a
    prior it means the key wasn't there.

    `number` is here because the vault genuinely stores numeric scalars
    (docs/vault-format.md §6 — `rating: 4`, `price: 1299.50`) and hands them
    back as `prior`, which undo writes straight back. The UI authors strings,
    bools and string lists; numbers only ever arrive on the read path. */
export type PropValue = string | string[] | boolean | number | null;

/** What a guarded property write returns: the post-write meta every
    caller already used, plus the value the write replaced. */
export interface SetPropResult {
  meta: NoteMeta;
  prior: PropValue;
}

/** What a rename returns: the renamed note's meta plus every note
    the rename actually rewrote — itself, its link sources, and the notes whose
    relation props named it. Undo keys its invalidation on that set, so an
    external edit to a link-rewritten third-party note refuses the undo
    instead of clobbering it (docs/undo.md §6.3). */
export interface RenameResult {
  meta: NoteMeta;
  touched: string[];
}

export interface NoteContent {
  body: string;
  props: Record<string, unknown>;
}

/** A note's raw frontmatter block (no fences) + its health.
    `error` null = parses fine; the repair dialog prefills from `raw`.
    `repairable` false = the dialog can't fix it (an unterminated
    opener has no block to edit — the fix is in the body editor). */
export interface FmState {
  raw: string;
  error: string | null;
  repairable: boolean;
}

export interface SearchHit {
  path: string;
  snippet: string;
  /** The matching prop VALUE, when the note matched only in its properties.
      `snippet` then holds whatever the note opens with, which marks nothing
      and explains nothing — this is the text that answered the query. Null
      whenever the title or body matched too: those explain themselves. */
  prop_snippet: string | null;
}

/** One run of snippet text; `hit` marks a matched token. */
export interface SnippetPart {
  text: string;
  hit: boolean;
}

/** One matching body line, 1-based, in editor coordinates. */
export interface SearchMatch {
  line: number;
  parts: SnippetPart[];
}

/** Full-search result for one note; `total` counts hits beyond the line cap. */
export interface FullSearchHit {
  path: string;
  title_parts: SnippetPart[];
  total: number;
  matches: SearchMatch[];
  /** The searched body is only the front of the source: a mounted document
      read to its page or byte cap. Always false for a note, whose
      body is the whole note. A pane that doesn't say so lets the opening of a
      forty-page paper pass for the whole of it — and a miss further down read
      as the phrase being absent from the file. */
  partial: boolean;
  /** The note's matching prop values, marked — empty when no prop matched.
      A prop hit has no body line to render, so without it the pane counted
      the hit and then showed nothing that matched. */
  prop_parts: SnippetPart[];
}

/** A full-search page plus how much of the match set it covers.
 *  `hits` is capped at 200 notes; `total_notes` is every note matching within
 *  the scope that was asked for, so the pane can say "first 200 of 359"
 *  instead of showing a truncated page as if it were the whole answer —
 *  and can tell a real "no results" apart from a page that simply ran out. */
export interface FullSearchResult {
  hits: FullSearchHit[];
  total_notes: number;
  truncated: boolean;
}

/** One past version of one note that matched a Deep Recall search: the body a
 *  blob held, and the stretch of history during which it WAS that note. */
export interface RecallVersion {
  /** git blob id — the dedupe key: identical bodies are one indexed body. */
  oid: string;
  /** the snapshot where this text became the note's content */
  first_id: string;
  first_ts_ms: number;
  /** the snapshot that replaced or removed it */
  last_id: string;
  last_ts_ms: number;
  /** the note was deleted at `last_id`, not merely edited */
  deleted: boolean;
  /** Matching lines. The line numbers count the historical file whole,
      frontmatter included — a past version is opened through the time
      scrubber, not at a coordinate in the note as it stands today. */
  matches: SearchMatch[];
  total: number;
}

/** Every past version of one path, collapsed into one row — the "collapse
 *  versions" grouping: many spans, one note, one line in the results. */
export interface RecallGroup {
  path: string;
  /** newest first, capped — `total_versions` is the honest count */
  versions: RecallVersion[];
  total_versions: number;
  /** lifespan of the matching text across every version of it */
  first_ts_ms: number;
  last_ts_ms: number;
  /** the newest matching version ended in a deletion */
  deleted: boolean;
}

export interface RecallResult {
  groups: RecallGroup[];
  truncated: boolean;
}

/** What the index costs and covers — the honest half of the Settings row. */
export interface RecallStats {
  /** snapshots walked so far */
  commits: number;
  /** unique bodies indexed — what the dedupe actually saved */
  blobs: number;
  /** past versions the index can point at */
  versions: number;
  bytes: number;
  /** false until a first index run has committed something */
  indexed: boolean;
}

/** The Settings readout: the switch and whether a walk is running, plus the
 *  numbers behind them. */
export interface RecallStatus extends RecallStats {
  enabled: boolean;
  indexing: boolean;
}

/** Where an embedded asset lives on disk, plus freshness facts that key the
 * waveform peak cache — a re-bounced file with the same name invalidates. */
export interface AssetInfo {
  path: string;
  size: number;
  mtime_ms: number;
}

/** One loose (non-note) file in a folder view — mirrors Rust's
    `FolderFile`. `path` is absolute: it is what streams through the asset
    protocol, what the OS open/reveal actions take, AND the shared audio
    player's key, so a row and a link-in-place embed of the same file drive
    one player rather than two. */
export interface FolderFile {
  rel: string;
  name: string;
  path: string;
  size: number;
  mtime_ms: number;
}

/** A folder's loose files, plus how many it really has — `files` is capped
    (Rust `FOLDER_FILES_MAX`) so one pathological directory can't ship a
    multi-megabyte payload into the list pane; `total` stays honest so the
    pane can say what it is not showing. */
export interface FolderListing {
  files: FolderFile[];
  total: number;
}

/** What a vault-doctor finding is about — mirrors `DoctorKind`. */
export type DoctorKind =
  | "broken-link"
  | "broken-relation"
  | "broken-embed"
  | "broken-view-ref"
  | "ambiguous-target"
  | "corrupt-config"
  | "stale-config"
  | "invalid-prop"
  | "broken-reflex"
  | "unscannable-sealed-note";

/** `error` = definitively broken; `warn` = ambiguous or suspicious. */
export type DoctorSeverity = "warn" | "error";

/** One integrity problem. `paths` holds every note involved (two-plus for
    ambiguity), or the `.vault/*.json` file for config findings. */
export interface DoctorFinding {
  kind: DoctorKind;
  severity: DoctorSeverity;
  paths: string[];
  /** the offending reference verbatim — link target, prop value, view name */
  subject: string;
  detail: string;
}

/** A read-only integrity snapshot of the whole vault. Never repairs. */
export interface DoctorReport {
  scanned_ms: number;
  notes: number;
  findings: DoctorFinding[];
}

/** One drained `substrate://` link. Exactly one field is set:
    `path` is a note that survived validation AND exists in this vault;
    `error` is already-worded text to show — a refused link, or one naming a
    note this vault doesn't have. */
export interface DeeplinkResolved {
  path?: string | null;
  error?: string | null;
}

/** The portable half of a mount, as `.vault/mounts.json` stores it: identity
    that syncs between machines. Deliberately no path — see `MountInfo`. */
export interface Mount {
  id: string;
  name: string;
  globs: string[];
  /** Paths the mount deliberately doesn't see — a pattern without a slash
      filters by name at any depth, one with a slash by the path relative to
      the mount root, and a matching folder is pruned whole. Hand-authored in
      `.vault/mounts.json`; absent means today's behaviour, which is
      everything `globs` admits. */
  ignore?: string[];
  watch?: boolean;
}

/** One mount as `mounts_list` returns it (vault-format.md §8): the portable
    half from `.vault/mounts.json` plus what THIS machine knows about it.
    `path` absent = not bound here, which is an ordinary state — the board
    still renders from the last-known index, with "Locate folder…" offered. */
export interface MountInfo extends Mount {
  path?: string;
  /** bound here, but the folder is gone (unplugged drive, moved folder) */
  missing: boolean;
  /** RFC 3339 stamp of the last scan; empty for a mount never scanned */
  scanned: string;
  /** rows in the last-known index — the count the database list shows, read
      from the index rather than the disk so it agrees on every machine */
  files: number;
}

/** One drive on the shelf: a disk the vault has cataloged, plugged in or
    not. Everything except `online`/`path` reads from the catalog, so a drive
    in a drawer answers exactly as fully as one on the desk. */
export interface DriveInfo {
  /** the underlying mount id — what every drive command takes */
  id: string;
  /** the volume's own name, as the OS mounts it; never rewritten by a rename
      of the database, which is `name` */
  label: string;
  name: string;
  /** the volume identity a forget is recorded against */
  volume: string;
  /** capacity in bytes, 0 where the platform wouldn't say */
  total: number;
  /** RFC 3339: first time this disk was ever cataloged, and the last time it
      was seen mounted anywhere — what the shelf's staleness label reads */
  first_seen: string;
  last_seen: string;
  /** RFC 3339 stamp of the scan that produced the catalog */
  scanned: string;
  files: number;
  bytes: number;
  /** files the last scan left uncataloged at the per-drive cap; > 0 means
      this catalog is knowingly incomplete and says so */
  capped: number;
  /** plugged into THIS machine right now */
  online: boolean;
  path?: string;
}

/** One row of a drive's catalog: a folder rolled up, or a file. */
export interface DriveEntry {
  name: string;
  /** the folder prefix to descend into, or the file's path inside the drive */
  rel: string;
  dir: boolean;
  /** the file's bytes, or everything under the folder */
  size: number;
  /** files under a folder; 1 for a file */
  files: number;
  /** empty on a folder — a folder's date would be its newest file's, which
      reads as fact and isn't one */
  modified: string;
  missing?: boolean;
}

/** One hit of a search across every drive's catalog, carrying the age of the
    catalog it came from: an answer from a year-old catalog must never be
    shown as if it were checked today. */
export interface DriveHit {
  id: string;
  label: string;
  rel: string;
  size: number;
  modified: string;
  scanned: string;
  online: boolean;
  missing?: boolean;
}

/** One row of a mount's board: the file as the index knows it, plus the
    sidecar note bound to it once the user has annotated the row. */
export interface MountRow {
  rel: string;
  name: string;
  extension: string;
  size: number;
  modified: string;
  created: string;
  identity: string;
  missing?: boolean;
  /** vault path of the sidecar note, absent until first annotated */
  note?: string;
  /** The sidecar's user props, plus whatever was read out of the file itself
      (duration, pages, tags…). Extraction happens behind a scan, so
      a row can arrive without them and gain them on the next refresh. */
  props: Record<string, unknown>;
  /** The opening line of the document as this machine read it —
      what a note shows under its title, for a file. Absent for anything
      nothing was read from: a file with no text, an unbound mount, a reading
      still queued. */
  excerpt?: string;
  /** That reading stopped at its cap, so the document continues past the
      excerpt — and past what a search of it could ever have covered. */
  excerpt_partial?: boolean;
}

/** Outcome of one mount's scan pass. `error` set means the folder itself
    couldn't be read — the index was left exactly as it was. */
export interface MountScanStats {
  id: string;
  name: string;
  scanned: number;
  added: number;
  updated: number;
  renamed: number;
  missing: number;
  /** mount-relative paths of the newly-seen files, absent when there are
      none; a mount's very first scan reports none by design */
  added_files?: string[];
  error?: string;
}

/** What a `dashboard: sync` note binds itself to on this machine: the sync
    system's state file, its log, the launchd label prefix its agents use and
    the runner a Run button starts. Every field is optional — an estate on the
    conventional layout configures nothing. */
export interface SyncConfig {
  state?: string;
  log?: string;
  prefix?: string;
  runner?: string;
}

/** Raw payload of the `sync_state_read` command backing `dashboard: sync`
    notes: the external sync system's state file verbatim (the component
    parses it defensively — every field inside may be absent) plus the recent
    ERROR lines of its log. Missing files come back as null/empty, never an
    error. */
export interface SyncStateFile {
  state_json: string | null;
  log_errors: string[];
  log_mtime: number | null;
  /** the resolved state-file path, so the pane can name what it read */
  state_path: string;
  /** is a runner actually on this machine? The pane gates its Run buttons on
      this rather than offering a verb that could only fail. */
  can_run: boolean;
}

/** One launchd agent's health from `sync_launchd_read`: plist-on-disk vs
    loaded-in-launchd, live pid, last exit code, human schedule parsed from
    the plist. */
export interface LaunchdJob {
  label: string;
  service: string;
  plist: boolean;
  loaded: boolean;
  pid: number | null;
  last_exit: number | null;
  schedule: string | null;
}

/** One entry of the sync manager's runs registry (`sync_control` starts it,
    `sync_runs` polls it): in-flight while `done` is false, exit verdict and
    output tail once finished. */
export interface SyncRun {
  id: string;
  /** "run" | "pause" | "resume" */
  kind: string;
  label: string;
  /** run target — lets the UI mark the exact leg row in flight (null for
      pause/resume, which target a job label instead) */
  direction: string | null;
  leg: string | null;
  started_ms: number;
  done: boolean;
  ok: boolean | null;
  tail: string;
}

/** One launchd agent's health from `jobs_read` — the generalized
    form of `LaunchdJob`, over whatever label prefixes the dashboard note
    allows rather than a single system's. `plist` doubles as the runtime
    control probe: no plist on disk means the row is read-only. */
export interface Job {
  label: string;
  /** the allowed prefix this label matched (the row's grouping key) */
  prefix: string;
  /** label minus the prefix — the short name the row shows */
  name: string;
  plist: boolean;
  loaded: boolean;
  pid: number | null;
  last_exit: number | null;
  schedule: string | null;
  /** recent run outcomes, oldest first, capped at 10 app-side.
      Approximate: a run that starts and ends between polls leaves no trace. */
  exit_ring: number[];
}

/** The synchronous outcome of one `jobs_control` action. Unlike a sync run
    these finish in milliseconds, so there is no registry to poll. */
export interface JobRun {
  label: string;
  /** "pause" | "resume" | "run" */
  action: string;
  started_ms: number;
  ok: boolean;
  /** empty on a clean success, else "already paused" / launchctl's stderr */
  note: string;
}

/** One artifact-freshness verdict from `jobs_freshness`: a job can
    be loaded, green, and quietly producing nothing — this is the check that
    notices. Missing or unparseable stamps are stale, never an error. */
export interface Freshness {
  label: string;
  /** the stamp exactly as written in the note, never reformatted */
  stamp: string | null;
  age_ms: number | null;
  max_age_ms: number;
  stale: boolean;
  /** why, in one clause — the row's tooltip */
  reason: string;
}


/** One entry of the feed-curator run registry: the feed
    dashboard's refresh button runs the configured `feed-curator` command,
    ONE run at a time, no queue (`curator_refresh` starts it, `curator_runs`
    polls it). The curated rows land through the vault watcher; this record
    only drives the button state and the error banner. */
export interface CuratorRun {
  id: string;
  /** "running" | "done" | "failed" */
  state: string;
  started_ms: number;
  finished_ms: number | null;
  /** the command's closing one-line summary, when it printed one */
  summary: string | null;
  /** failure reason (spawn error, stderr tail, "cancelled", timeout) */
  error: string | null;
}


/** What one cookbook install wrote. `renamed_from` is null when the
    recipe's own path was free; when it isn't, the vault already had that note
    and the recipe's copy landed beside it under a ` (cookbook)` name. */
export interface CookbookInstalledFile {
  path: string;
  renamed_from: string | null;
}

export interface CookbookInstall {
  files: CookbookInstalledFile[];
  /** the installed dashboard, for the click-through — null on a recipe that
      somehow wrote nothing */
  open: string | null;
}

export type View =
  | { kind: "today" }
  | { kind: "notes" }
  | { kind: "all" }
  | { kind: "search" }
  | { kind: "trash" }
  | { kind: "assets" }
  | { kind: "doctor" }
  | { kind: "calendar" }
  | { kind: "vaultsync" }
  | { kind: "changelog" }
  | { kind: "cookbook" }
  | { kind: "dbmanager" }
  | { kind: "db"; type: string }
  /** a reality mount — keyed by mount id, not name, so a rename
      doesn't strand the open view */
  | { kind: "mount"; id: string }
  /** the Drive Shelf itself: every disk this vault has ever cataloged */
  | { kind: "shelf" }
  /** one drive's catalog, browsable with the disk unplugged. `id` is the
      mount id; `prefix` is where in the catalog the browse currently is */
  | { kind: "drive"; id: string; prefix: string }
  | { kind: "saved"; id: string }
  | { kind: "dashboard"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "tagfolder"; id: string }
  | { kind: "tag"; tag: string }
  ;

/** One recoverable item in `.trash/` — `id` addresses it, `path` is where restore puts it back. */
export interface TrashEntry {
  id: string;
  path: string;
  title: string;
  deleted_ms: number;
  /** a folder trashes its whole subtree as one entry; `asset` is a trashed
      `.assets/` file (recoverable, never history-tracked);
      `template` is a deleted database's template note */
  kind: "note" | "folder" | "asset" | "template";
  /** folder entries: original paths of the notes inside (drives count + purge) */
  notes: string[];
}

export type DbLayout = "list" | "table" | "board" | "gallery";

/** Per-layout column-visibility sets, one optional hidden-prop
    list per consuming layout. A layout with no set of its own falls back to
    the pref's flat `hidden`, which pre-change files seed both layouts with. */
export interface HiddenPerLayout {
  table?: string[];
  list?: string[];
}

/** Table-footer aggregation over one column; absent key = none. */
export type AggKind = "sum" | "avg" | "min" | "max" | "count";

/** Per-database layout preference, persisted in `.vault/views.json`. */
export interface ViewPref {
  view: DbLayout;
  /** the prop a BOARD groups its columns by */
  group_by?: string;
  /** the prop a TABLE groups its section rows by — a separate key
      so a board grouping never re-sections a table and vice versa */
  table_group_by?: string;
  /** table footer calculations, column → aggregation */
  aggregations?: Record<string, AggKind>;
  /** the database's remembered sort — the ordered key list header
      clicks build, persisted so it survives navigating away; absent =
      unsorted. A saved-view pin's own sort wins inside the pin. */
  sorts?: SavedViewSort[];
  /** props hidden from the table's columns; absent = all shown.
      This one set once fed BOTH the table and the list subtitle; now
      it only seeds a layout that has no set of its own yet (read-side
      migration — the first per-layout write materializes both layouts' sets
      and drops this flat key) */
  hidden?: string[];
  /** per-layout hidden-prop sets: the table and the list curate
      column visibility independently — hiding a table column no longer
      rewrites every list row's subtitle, and curating a list no longer
      strips the table. Board/gallery have no curation UI and never carry a
      set. */
  hidden_per_layout?: HiddenPerLayout;
  /** table column order — the ordered prop keys a header drag
      builds. Keys naming no column are ignored; a prop added after the drag
      appends after the ordered ones in its default `dbColumns` position.
      The Name column is frozen first and never appears here. Absent = the
      default order. */
  col_order?: string[];
  /** the board's hand order — note paths in the order a card drag
      left them, for the whole board rather than per column, so a card keeps
      its slot when its group changes. It lives here and NEVER as a prop in
      the note file: the vault format stays untouched by a UI arrangement.
      Only an UNSORTED board reads it (a sorted view's order is its sort).
      Tolerant by construction: paths naming no note are ignored, and a note
      the list doesn't mention appends after the ordered ones in resting
      order — so a note created or renamed outside the app can't break it. */
  card_order?: string[];
  /** table column widths in px, prop → width; the reserved `title`
      key sizes the Name column. Absent = every column auto-sizes. */
  widths?: Record<string, number>;
  /** props whose table cells wrap instead of clipping; `title`
      names the Name column here too. Absent = clip. */
  wrap?: string[];
  /** table grid-lines override: true/false pins this database's
      vertical column rules on/off; absent = follow the global `db-grid`
      setting. Writers store it only while it disagrees with the global, so
      toggling a database back to the global value re-follows the global. */
  grid?: boolean;
}

export type ViewsConfig = Record<string, ViewPref>;

/** Sort captured in a saved view — the table header cycle (asc/desc). */
export interface SavedViewSort {
  key: string;
  dir: 1 | -1;
}

/** A pinned, named query over one database, persisted in
    `.vault/views.json` under the reserved `$views` key. `query` is the raw
    operator string, parsed on open by `filterByQuery`. Multi-key sorts:
    `sorts` holds the full ordered key list when 2+ keys are active
    and `sort` always mirrors its first entry, so older readers still work —
    readers treat a view as `sorts ?? (sort ? [sort] : [])`. */
export interface SavedView {
  id: string;
  name: string;
  db: string;
  query?: string;
  sort?: SavedViewSort;
  sorts?: SavedViewSort[];
  view?: DbLayout;
  group_by?: string;
  /** table-layout grouping, persisted like the board's group_by */
  table_group_by?: string;
  /** per-view display columns: the ordered property keys this view
      renders in table/list layouts (the title column always leads). Absent =
      the default `dbColumns` union; keys naming no known column are ignored. */
  columns?: string[];
}

/** Sidebar section ordering and collapse state, persisted in `.vault/views.json`
    under `$sidebar`. `collapsed` holds section ids ("dashboards", "pinned",
    "folders") plus one `dashgroup:<folder>` id per collapsed Dashboards
    subfolder group. The `databases` order predates the manager
    surface (the flat sidebar section it ordered is gone); the engine still
    carries the array, the UI no longer writes it. `folders` holds
    ROOT-level folder paths in the user's drag order — nested folders stay
    alphabetical, folders not in the list append after the ordered ones.
    `pins` holds note paths pinned to the Pinned section, in row
    order; the engine retargets them on rename/move and drops them on trash.
    `keys` holds user-assigned shortcuts as key token ("mod+5",
    "ctrl+3") → sidebar target token — `viewKey()`'s vocabulary plus
    "note:<path>" and "journal". The engine retargets and drops those values
    alongside `pins`; a target that outlives its row is inert, not an error.
    `dashgroups` holds the FOLDER paths of the Dashboards section's
    subfolder group headers in the user's drag order — its own lane
    because a group header orders against its sibling headers, never against
    the dashboard rows in `dashboards` or the tree folders in `folders`. */
export interface SidebarOrder {
  dashboards: string[];
  databases: string[];
  collapsed?: string[];
  folders?: string[];
  dashgroups?: string[];
  pins?: string[];
  keys?: Record<string, string>;
}

/** One allowed value of a select-type property; `color` names a muted
    palette dot (see `--opt-*` tokens), meaning-carrying marks only. */
export interface SelectOption {
  value: string;
  color?: string;
}

/** Extra property kinds beyond free text / select. `text` is the explicit
    form of free text — it lets a schema-registered text column exist with no
    options; `date` = ISO value with a calendar picker; `file` = a
    LINK to a real file/folder on disk (absolute or `~/…`) — Substrate never
    copies, moves, or touches the target; `relation` = a typed link to entries
    of another database (`type` below), stored as the target's title/stem (or
    a YAML list of them) and rewritten on rename; `multi` = a select with
    several values per note — same options/colors as select, the
    value stored as a YAML list of strings (a scalar is legal for one value),
    the picker toggling membership instead of replacing; `url` = an external
    link, stored as the plain URL string and rendered as a clickable
    stripped title (no scheme/www/trailing slash) that opens in the browser;
    `email`/`phone` = contact links, stored as the plain string and
    rendered exactly as typed — clicking opens `mailto:`/`tel:` externally
    (only the dialed number strips spaces/dashes), editing shows the raw
    string; `checkbox` = a boolean, stored as the YAML scalar
    `true` when checked — absent/empty means unchecked, so unchecking REMOVES
    the prop rather than writing `false` (a stored `false` still reads as
    unchecked) — rendered as a small check square that toggles on one click,
    no editor popup; `number` = a numeric column, the value stored
    exactly as today (plain YAML scalar, string or number) with an optional
    display `format` below — cells right-align, editing shows the raw stored
    string, and non-numeric junk always renders as typed; `rollup` = a
    DERIVED column: aggregates (`agg`) one prop's values across the
    rows a relation prop of the SAME database links to — computed on read,
    stored nowhere (no frontmatter value ever lands), so the cell is
    read-only and an empty aggregation renders blank, the footer's
    convention. The wiring rides the three optional fields below. */
export type PropKind = "text" | "date" | "file" | "relation" | "multi" | "url" | "email" | "phone" | "checkbox" | "number" | "rollup";

/** Display format of a number-kind prop: `plain` = the number as
    stored (same as absent); `euro` = German-style `1.234,56 €` (dot
    thousands, comma decimals, 2 decimals only when the value has decimals);
    `percent` = the same de-DE path with a ` %` suffix (`8,5 %`) —
    the stored number IS the percent, no ×100 math. Display-only: the stored
    value never changes.

    The same field also names the column's UNIT: any units.ts
    code (`USD`, `kg`, `BPM`, `LUFS`…) is a valid format, and `euro`/`percent`
    stay forever as the aliases for `EUR` and `%` that every existing vault
    already has on disk. One field, no migration. The vocabulary is open, so
    the type can't enumerate it — `(string & {})` keeps the three historical
    values in autocomplete while accepting the rest; validation lives where it
    can be exhaustive (aggregate.ts `formatUnit` for rendering, schema.rs
    `NUMBER_FORMATS`/`UNIT_CODES` on write). */
export type NumberFormat = "plain" | "euro" | "percent" | (string & {});

export interface PropSchema {
  /** the allowed values; select and multi props only — other kinds carry [] */
  options: SelectOption[];
  kind?: PropKind;
  /** date-kind only: macOS notification when the date comes due */
  notify?: boolean;
  /** date-kind only: an ADDITIONAL macOS alert this many days
      before the date comes due. Independent of `notify` — either may stand
      alone, both set means two alerts. Absent/0 = off, capped at 365. */
  notifyBefore?: number;
  /** relation kind only: the database type this prop points at */
  type?: string;
  /** number kind only: display format; absent = plain */
  format?: NumberFormat;
  /** rollup kind only: the relation prop on the SAME database to
      follow — its `type` names the related database, its values name the
      linked rows */
  relation?: string;
  /** rollup kind only: the prop on the related database to read */
  prop?: string;
  /** rollup kind only: the aggregation over the linked rows'
      values — same vocabulary as the table footer's Calculate */
  agg?: AggKind;
  /** any kind, kindless select props included: a one-line entry
      hint shown muted where values are typed; absent = none */
  description?: string;
  /** any kind: how long a value here stays believable before it wants
      looking at again (`90d`, `1y`; absent = it never goes stale). Nothing
      pings — the window only lets a reader ask which values are past theirs
      (src/lib/shelflife.ts). */
  review?: string;
}

/** A rollup prop's wiring, as the schema editor hands it to
    vaultSchemaSet: follow `relation` (a relation prop of the same database),
    read `prop` on the linked rows, fold with `agg`. Mirrors the three
    optional PropSchema fields above; on disk they flatten into the prop's
    schema entry. */
export interface RollupConfig {
  relation: string;
  prop: string;
  agg: AggKind;
}

/** One read-only `.ics` subscription stored in `.vault/calendars.json`. */
export interface CalendarFeedConfig {
  url: string;
  name: string;
  tint: string;
  enabled: boolean;
}

/** Subscription health returned with the cached event window. */
export interface CalendarFeed extends CalendarFeedConfig {
  fetchedAt: number | null;
  error: string | null;
  cached: boolean;
}

/** One expanded VEVENT occurrence from a cached external feed. */
export interface ExternalCalendarEvent {
  id: string;
  feedUrl: string;
  feedName: string;
  tint: string;
  title: string;
  startDay: string;
  startTime: string | null;
  endDay: string | null;
  endTime: string | null;
  allDay: boolean;
  location: string | null;
}

export interface CalendarFeedSnapshot {
  feeds: CalendarFeed[];
  events: ExternalCalendarEvent[];
  refreshing: boolean;
  configError: string | null;
}

/** A database's icon: a curated outline glyph id or an emoji,
    optionally tinted with a muted palette name (`--opt-*` tokens). Stored on
    the type's entry in `.vault/schema.json` under the reserved `icon` key.
    See src/lib/dbicons.ts for the accessors that read it back out. */
export interface DbIcon {
  glyph?: string;
  emoji?: string;
  tint?: string;
}

/** Per-folder metadata, persisted in `.vault/views.json` under the
    reserved `$folders` key: currently just the folder's icon. A folder rename
    model. A folder rename retargets its keys (subtree included); trashing a
    folder drops them. */
export interface FolderMeta {
  icon?: DbIcon;
}

/** `$folders` map: vault-relative folder path → metadata. */
export type FolderMetaMap = Record<string, FolderMeta>;

/** How a tag folder's positive tags combine. */
export type TagMatch = "any" | "all";

/** One tag folder, as persisted in `.vault/tagfolders.json`.

    A tag folder is a saved query, not a place: it lists notes carrying its
    tags, and acting inside it (create, drag-in) tags the note rather than
    moving any file. `exclude` always vetoes. */
export interface TagFolder {
  id: string;
  name: string;
  tags: string[];
  match: TagMatch;
  exclude: string[];
  icon?: DbIcon;
}

/** One tag in the vault's tag universe: display spelling plus note count. */
export interface TagCount {
  tag: string;
  count: number;
}

/** Per-type property schemas, persisted in `.vault/schema.json`.
    Notes keep plain YAML values — this only drives pickers and option order.
    A type entry also carries the reserved `icon` key (DbIcon, not a
    PropSchema) and `home` key (a folder path string) — both inert at
    every `?.kind`/`?.options` access site here; read them via typeIcon /
    typeHome. */
export type SchemaConfig = Record<string, Record<string, PropSchema>>;

/** The kind vocabulary a create-database call may name. Wider than
    PropKind by exactly one word: a select column is a kindless schema entry
    with options, so it has no PropKind to ride, and every surface that offers
    it — the schema editor's own picker included — spells it "select". The
    engine turns that back into the stored absence.

    Options are what make a select one: with none, every reader here resolves
    the entry back to text, and the engine reads it as a property that isn't
    there. So only a create that can NAME the options may use this kind — a
    CSV import, whose columns arrive with their values. */
export type NewPropKind = PropKind | "select";

/** One initial property in a create-database call: name + kind, `target`
    naming the pointed-at database for relation kinds, `options` the value
    vocabulary of a select or multi column (dropped for every other kind,
    exactly as a schema edit drops it). */
export interface NewTypeProp {
  name: string;
  kind?: NewPropKind | null;
  target?: string | null;
  options?: SelectOption[] | null;
}

/** Outcome of a bulk note sweep (database rename/delete, property
    rename/clear): `notes` rewritten, `skipped` left untouched because the
    target key already existed.

    `failed` is the error of a sweep that died partway. The sweep
    stops at the first failing note, so the count is what it managed before
    giving up — always report both, since the vault really did change.
    `skipped` is only ever non-zero for a property rename. */
export interface BulkSweep {
  notes: number;
  skipped: number;
  failed?: string | null;
}

/** One note pointing at another through a schema'd relation prop — the
    structured cousin of a backlink (`db_type` + `prop` say HOW it points). */
export interface RelatedEntry {
  path: string;
  title: string;
  db_type: string;
  prop: string;
}

/** One auto-snapshot of a note, as listed in the History panel. */
export interface HistoryEntry {
  id: string;
  ts_ms: number;
  subject: string;
  /** the note's path at that snapshot (renames are followed) */
  file: string;
  adds: number;
  dels: number;
}

/** Who changed a fact, as far as the commit can say (receipts spec §4.4). The
    closed set the backend maps every commit into — semantic, never display
    text: the personal wording ("You", "Claude (via MCP)") is `actorText`'s
    business (`src/lib/receipts.ts`). */
export type Actor =
  | { kind: "app" }
  | { kind: "mcp"; name: string }
  | { kind: "sync" }
  | { kind: "bulk"; name: string }
  | { kind: "reflex"; name: string }
  | { kind: "external" }
  | { kind: "external_tool"; name: string };

/** One moment a fact took a new value. `value` is null where the note or the
    key did not exist then — a deletion is a real point on the lane, not a gap
    the previous value carries across. `actor` and `subject` are the receipt
    half (§7): who changed it, and the raw commit subject behind that verdict. */
export interface FactPoint {
  commit: string;
  ts_ms: number;
  value: string | null;
  actor: Actor;
  subject: string;
}

/** Every change of one frontmatter fact across vault history, oldest first.
    `oldest_ts_ms` is the commit time of the oldest snapshot still
    in the vault: anything before it was trimmed or purged and is UNKNOWABLE,
    which surfaces as "no history before …" rather than as a blank or a zero.
    Null when the vault has no snapshots at all. */
export interface FactLane {
  path: string;
  key: string;
  points: FactPoint[];
  oldest_ts_ms: number | null;
}

/** How long one fact has stood: the last time a person set it, with sweeps
    skipped (shelf-life spec §2). `reviewed_ts_ms` is null in two different
    situations, which `only_bulk` tells apart — the fact has changed, but only
    ever inside a sweep (an import, a format migration, a mass rewrite), so its
    real age is unknown; versus a fact with no history at all. Dating a fact
    from the sweep that rewrote it would be the lie this surface exists to
    avoid, so neither case is allowed to read as "changed today".
    `oldest_ts_ms` is the same trim boundary `FactLane` carries. */
export interface FactFreshness {
  path: string;
  key: string;
  reviewed_ts_ms: number | null;
  reviewed_commit: string | null;
  reviewed_actor: Actor | null;
  only_bulk: boolean;
  oldest_ts_ms: number | null;
}

/** One sheet note as it stood at a past instant — the raw material
    `AT(date, Sheet.member)` re-evaluates (docs/time-travel-spec.md §3.2). */
export interface HistorySheetNote {
  path: string;
  title: string;
  stem: string;
  body: string;
}

/** Every sheet note in the vault as of one instant. `commit` is null when no
    snapshot exists at or before it; `oldest_ts_ms` is the same trim boundary
    `FactLane` carries, so a date below it reads as "no history before …"
    rather than as an empty vault. */
export interface HistorySheetsAt {
  instant_ms: number;
  commit: string | null;
  oldest_ts_ms: number | null;
  sheets: HistorySheetNote[];
}

/** One whole-vault commit on the time scrubber, newest first. */
export interface VaultHistoryPoint {
  id: string;
  ts_ms: number;
  subject: string;
}

/** The complete read projection for one vault history commit. */
export interface HistoryVaultSnapshot {
  point: VaultHistoryPoint;
  notes: NoteMeta[];
  contents: Record<string, NoteContent>;
  /** Raw frontmatter per note as of this snapshot — the body in
      `contents` has the block stripped, so this is the past's only sight of
      it. Missing key = the note had no frontmatter then. */
  fm: Record<string, FmState>;
  folders: string[];
  views: ViewsConfig;
  schema: SchemaConfig;
  sidebar_order: SidebarOrder;
  saved_views: SavedView[];
  folder_meta: FolderMetaMap;
}

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
}

/** available = git initialized at all; enabled = the vault repo is ours (a
 * pre-existing user repo without the .git/substrate-owned stamp disables
 * history entirely). */
export interface HistoryStatus {
  available: boolean;
  enabled: boolean;
}

/** What one saved-view link-folder export did. */
export interface ViewExportReport {
  /** Absolute path of the folder holding the links. */
  dest: string;
  /** How many links it now holds. */
  links: number;
  /** Rows whose file was gone at export time — skipped, never fatal. */
  missing: number;
  /** Entries left alone because they are not links Substrate manages. */
  kept: number;
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  conflicted: string[];
  head: string;
  /** Vault-relative paths this pull's checkout rewrote — the diff
      between the HEAD we came from and the one we landed on. Empty when
      nothing was checked out: a push, an up-to-date pull, a conflicted pull
      that parked. The app rides these in on `vault:pulled` to invalidate
      exactly the undo entries the checkout stepped on (docs/undo.md §3.5). */
  changed: string[];
  /** Something the sync worked out that is worth saying before it becomes a
      failure — today, a hosted store approaching the number of encrypted
      objects one sync can work through. Absent on an ordinary sync. It is not
      an error: the sync succeeded, and the next one will too. */
  notice?: string | null;
}

export interface VaultSyncStatus {
  configured: boolean;
  last_result: SyncReport | null;
  last_error: string | null;
  /** Paths of the conflicted merge parked in git, read from the repository —
   * unlike `last_result`, this survives a restart. */
  conflicted: string[];
  /** A sealing cleanup that failed and left plaintext in local git history.
   * Separate from `last_error` because `last_error` is the last attempt's
   * outcome and the next successful pull takes it back — while the plaintext
   * is still there. Only a resolved cleanup or `vaultSyncAckPrivacy` clears
   * this one, and it survives a restart. */
  privacy_error: string | null;
  /** The paths whose plaintext that warning is about. */
  privacy_paths: string[];
  /** The hosted store approaching the number of encrypted objects one sync can
   * work through. Sticky for the same reason `privacy_error` is: only push can
   * work it out, `last_result` is replaced by every auto pull, and a warning
   * riding the report alone is off the pane within one poll interval. A later
   * push finding the store back under the threshold is what clears it. */
  notice: string | null;
  /** Whether the vault syncs end-to-end encrypted (`hosted`) or in the clear
   * (`git`). Without it the pane could not say a vault was encrypted, and
   * re-saving a hosted remote under a plain URL converted it in silence. */
  remote_kind: RemoteKind;
  /** Where the vault syncs to, so the pane can show it and refill its field.
   * Never the token or the passphrase — those are write-only. */
  remote_url: string | null;
}

/** The kind of remote a vault syncs to. `hosted` is a `blob+https://` remote:
 *  the server holds ciphertext only and the vault passphrase is what opens
 *  it. `git` is a plain remote, whose server sees the vault's contents. */
export type RemoteKind = "none" | "hosted" | "git";

/** What saving a remote did to the vault's hosted enrollment. `created` is the
 *  one case where the typed passphrase BECAME the vault's passphrase and
 *  nothing else holds it — including a typo repeated into both fields. */
export type RemoteSetup = "plain" | "created" | "joined";

/** What the user picked for one conflicted path. */
export type ConflictChoice = "mine" | "theirs" | "both";

/** One side (base / mine / theirs) of a conflicted file. `present: false` =
 * that side deleted it; `text: null` = the blob is not UTF-8 text. */
export interface ConflictSide {
  present: boolean;
  text: string | null;
  oid: string;
  /** Git file mode (100644 regular, 100755 executable, 120000 symlink),
   * carried so resolving preserves it. 0 when the side is absent. */
  mode: number;
}

/** A frontmatter property the two sides disagree on. */
export interface PropConflict {
  key: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

export interface ConflictFile {
  path: string;
  base: ConflictSide;
  ours: ConflictSide;
  theirs: ConflictSide;
  /** Body diff mine → theirs, in History's DiffLine shape. */
  diff: DiffLine[];
  props: PropConflict[];
  resolution: ConflictChoice | null;
  /** Where keep-both writes the remote copy; empty when one side is gone. */
  both_path: string;
}

/** The pending conflicted pull. Rebuilt from git on every read — git is the
 * truth, so a half-resolved merge survives an app restart. */
export interface ConflictState {
  active: boolean;
  head: string;
  remote: string;
  files: ConflictFile[];
  resolved: number;
}

export function viewKey(v: View): string {
  if (v.kind === "db") return `db:${v.type}`;
  if (v.kind === "saved") return `sv:${v.id}`;
  if (v.kind === "dashboard") return `dash:${v.path}`;
  if (v.kind === "folder") return `folder:${v.path}`;
  // one destination per disk, and the browse prefix is deliberately NOT in
  // it: coming back to a drive means coming back to the drive, not to the
  // folder you happened to be three levels down in
  if (v.kind === "drive") return `drive:${v.id}`;
  if (v.kind === "tagfolder") return `tagfolder:${v.id}`;
  // folded, so #Demo and #demo are one destination — the same rule matching
  // uses
  if (v.kind === "tag") return `tag:${v.tag.toLowerCase()}`;
  return v.kind;
}

export function propStr(props: Record<string, unknown>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(props, key)) return undefined;
  const v = props[key];
  if (v === undefined || v === null) return undefined;
  // multi-value props (relation/multi lists) display as a joined string
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(", ");
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** The exact property key already present on one note, falling back to the
    first case-insensitive match. Exact wins when a hand-edited note carries
    case-only duplicates; no match preserves the requested key for a write. */
export function foldedPropKey(props: Record<string, unknown>, key: string): string {
  if (Object.prototype.hasOwnProperty.call(props, key)) return key;
  const folded = key.toLowerCase();
  return Object.keys(props).find((candidate) => candidate.toLowerCase() === folded) ?? key;
}

/** Case-insensitive property read with the same exact-first rule as writes. */
export function foldedPropStr(props: Record<string, unknown>, key: string): string | undefined {
  return propStr(props, foldedPropKey(props, key));
}

/** A note's database type as the engine matches it: folded key, folded and
    trimmed VALUE. `type: Sheet` and `type: sheet ` are one type — the word is
    typed by hand into frontmatter, so its casing carries no meaning, and a
    surface comparing the raw string to a literal turns a capital letter into
    "not a sheet". Undefined when the note declares no type. */
export function foldedTypeName(props: Record<string, unknown>): string | undefined {
  return foldedPropStr(props, "type")?.trim().toLowerCase() || undefined;
}

/** The home folder on one type's schema entry, validated — like
    typeIcon the reserved `home` key rides inside the flat prop map typed as
    `Record<string, PropSchema>`. Anything malformed reads as no home. */
export function typeHome(entry: Record<string, PropSchema> | undefined): string | undefined {
  if (!entry) return undefined;
  const raw = (entry as Record<string, unknown>).home;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}
