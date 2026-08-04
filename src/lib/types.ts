/** App-machinery types, not databases (SUB-389): dashboards and sheets are
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
  /** The note's tag set (SUB-818): inline `#hashtags` unioned with the
      `tags:` prop, deduplicated case-insensitively, computed at index time.
      Optional so older projections (history snapshots) still typecheck. */
  tags?: string[];
}

/** Everything a single property can hold across the IPC boundary. `null` is
    the absence sentinel on both sides: as a write it removes the key, as a
    prior it means the key wasn't there.

    `number` is here because the vault genuinely stores numeric scalars
    (docs/vault-format.md §6 — `rating: 4`, `price: 1299.50`) and hands them
    back as `prior`, which undo writes straight back. The UI authors strings,
    bools and string lists; numbers only ever arrive on the read path. */
export type PropValue = string | string[] | boolean | number | null;

/** What a guarded property write returns (SUB-477): the post-write meta every
    caller already used, plus the value the write replaced. */
export interface SetPropResult {
  meta: NoteMeta;
  prior: PropValue;
}

/** What a rename returns (SUB-515): the renamed note's meta plus every note
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

/** A note's raw frontmatter block (no fences) + its health (SUB-430).
    `error` null = parses fine; the repair dialog prefills from `raw`.
    `repairable` false = the dialog can't fix it (SUB-552: an unterminated
    opener has no block to edit — the fix is in the body editor). */
export interface FmState {
  raw: string;
  error: string | null;
  repairable: boolean;
}

export interface SearchHit {
  path: string;
  snippet: string;
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
}

/** A full-search page plus how much of the match set it covers (SUB-566).
 *  `hits` is capped at 200 notes; `total_notes` is every note matching within
 *  the scope that was asked for, so the pane can say "first 200 of 359"
 *  instead of showing a truncated page as if it were the whole answer —
 *  and can tell a real "no results" apart from a page that simply ran out. */
export interface FullSearchResult {
  hits: FullSearchHit[];
  total_notes: number;
  truncated: boolean;
}

/** Where an embedded asset lives on disk, plus freshness facts that key the
 * waveform peak cache — a re-bounced file with the same name invalidates. */
export interface AssetInfo {
  path: string;
  size: number;
  mtime_ms: number;
}

/** One loose (non-note) file in a folder view (SUB-812) — mirrors Rust's
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

/** What a vault-doctor finding is about (SUB-432) — mirrors `DoctorKind`. */
export type DoctorKind =
  | "broken-link"
  | "broken-relation"
  | "broken-embed"
  | "broken-view-ref"
  | "ambiguous-target"
  | "stale-config"
  | "invalid-prop";

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

/** The portable half of a mount, as `.vault/mounts.json` stores it: identity
    that syncs between machines. Deliberately no path — see `MountInfo`. */
export interface Mount {
  id: string;
  name: string;
  globs: string[];
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
  props: Record<string, unknown>;
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
  error?: string;
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
  | { kind: "dbmanager" }
  | { kind: "db"; type: string }
  /** a reality mount (SUB-888) — keyed by mount id, not name, so a rename
      doesn't strand the open view */
  | { kind: "mount"; id: string }
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
      `.assets/` file (SUB-479 — recoverable, never history-tracked);
      `template` is a deleted database's template note (SUB-781) */
  kind: "note" | "folder" | "asset" | "template";
  /** folder entries: original paths of the notes inside (drives count + purge) */
  notes: string[];
}

export type DbLayout = "list" | "table" | "board" | "gallery";

/** Per-layout column-visibility sets (SUB-642), one optional hidden-prop
    list per consuming layout. A layout with no set of its own falls back to
    the pref's flat `hidden`, which pre-SUB-642 files seed both layouts with. */
export interface HiddenPerLayout {
  table?: string[];
  list?: string[];
}

/** Table-footer aggregation over one column (SUB-74); absent key = none. */
export type AggKind = "sum" | "avg" | "min" | "max" | "count";

/** Per-database layout preference, persisted in `.vault/views.json`. */
export interface ViewPref {
  view: DbLayout;
  /** the prop a BOARD groups its columns by */
  group_by?: string;
  /** the prop a TABLE groups its section rows by (SUB-184) — a separate key
      so a board grouping never re-sections a table and vice versa */
  table_group_by?: string;
  /** table footer calculations, column → aggregation (SUB-74) */
  aggregations?: Record<string, AggKind>;
  /** the database's remembered sort (SUB-326) — the ordered key list header
      clicks build, persisted so it survives navigating away; absent =
      unsorted. A saved-view pin's own sort wins inside the pin. */
  sorts?: SavedViewSort[];
  /** props hidden from the table's columns (SUB-326); absent = all shown.
      Pre-SUB-642 this one set fed BOTH the table and the list subtitle; now
      it only seeds a layout that has no set of its own yet (read-side
      migration — the first per-layout write materializes both layouts' sets
      and drops this flat key) */
  hidden?: string[];
  /** per-layout hidden-prop sets (SUB-642): the table and the list curate
      column visibility independently — hiding a table column no longer
      rewrites every list row's subtitle, and curating a list no longer
      strips the table. Board/gallery have no curation UI and never carry a
      set. */
  hidden_per_layout?: HiddenPerLayout;
  /** table column order (SUB-949) — the ordered prop keys a header drag
      builds. Keys naming no column are ignored; a prop added after the drag
      appends after the ordered ones in its default `dbColumns` position.
      The Name column is frozen first and never appears here. Absent = the
      default order. */
  col_order?: string[];
  /** table column widths in px (SUB-404), prop → width; the reserved `title`
      key sizes the Name column. Absent = every column auto-sizes. */
  widths?: Record<string, number>;
  /** props whose table cells wrap instead of clipping (SUB-404); `title`
      names the Name column here too. Absent = clip. */
  wrap?: string[];
  /** table grid-lines override (SUB-607): true/false pins this database's
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

/** A pinned, named query over one database (SUB-18), persisted in
    `.vault/views.json` under the reserved `$views` key. `query` is the raw
    SUB-7 operator string, parsed on open by `filterByQuery`. Multi-key sorts
    (SUB-199): `sorts` holds the full ordered key list when 2+ keys are active
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
  /** table-layout grouping (SUB-184), persisted like the board's group_by */
  table_group_by?: string;
  /** per-view display columns (SUB-212): the ordered property keys this view
      renders in table/list layouts (the title column always leads). Absent =
      the default `dbColumns` union; keys naming no known column are ignored. */
  columns?: string[];
}

/** Sidebar section ordering and collapse state, persisted in `.vault/views.json`
    under `$sidebar`. `collapsed` holds section ids ("dashboards", "savedviews",
    "folders") — SUB-70. The `databases` order predates the SUB-159 manager
    surface (the flat sidebar section it ordered is gone); the engine still
    carries the array, the UI no longer writes it. `folders` (SUB-401) holds
    ROOT-level folder paths in the user's drag order — nested folders stay
    alphabetical, folders not in the list append after the ordered ones.
    `pins` (SUB-410) holds note paths pinned to the Pinned section, in row
    order; the engine retargets them on rename/move and drops them on trash.
    `keys` (SUB-467) holds user-assigned shortcuts as key token ("mod+5",
    "ctrl+3") → sidebar target token — `viewKey()`'s vocabulary plus
    "note:<path>" and "journal". The engine retargets and drops those values
    alongside `pins`; a target that outlives its row is inert, not an error.
    `dashgroups` (SUB-698) holds the FOLDER paths of the Dashboards section's
    subfolder group headers (SUB-466) in the user's drag order — its own lane
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
    options (SUB-43); `date` = ISO value with a calendar picker; `file` = a
    LINK to a real file/folder on disk (absolute or `~/…`) — Substrate never
    copies, moves, or touches the target; `relation` = a typed link to entries
    of another database (`type` below), stored as the target's title/stem (or
    a YAML list of them) and rewritten on rename; `multi` = a select with
    several values per note (SUB-79) — same options/colors as select, the
    value stored as a YAML list of strings (a scalar is legal for one value),
    the picker toggling membership instead of replacing; `url` = an external
    link (SUB-172), stored as the plain URL string and rendered as a clickable
    stripped title (no scheme/www/trailing slash) that opens in the browser;
    `email`/`phone` = contact links (SUB-181), stored as the plain string and
    rendered exactly as typed — clicking opens `mailto:`/`tel:` externally
    (only the dialed number strips spaces/dashes), editing shows the raw
    string; `checkbox` = a boolean (SUB-173), stored as the YAML scalar
    `true` when checked — absent/empty means unchecked, so unchecking REMOVES
    the prop rather than writing `false` (a stored `false` still reads as
    unchecked) — rendered as a small check square that toggles on one click,
    no editor popup; `number` = a numeric column (SUB-188), the value stored
    exactly as today (plain YAML scalar, string or number) with an optional
    display `format` below — cells right-align, editing shows the raw stored
    string, and non-numeric junk always renders as typed; `rollup` = a
    DERIVED column (SUB-678): aggregates (`agg`) one prop's values across the
    rows a relation prop of the SAME database links to — computed on read,
    stored nowhere (no frontmatter value ever lands), so the cell is
    read-only and an empty aggregation renders blank, the footer's
    convention. The wiring rides the three optional fields below. */
export type PropKind = "text" | "date" | "file" | "relation" | "multi" | "url" | "email" | "phone" | "checkbox" | "number" | "rollup";

/** Display format of a number-kind prop (SUB-188): `plain` = the number as
    stored (same as absent); `euro` = German-style `1.234,56 €` (dot
    thousands, comma decimals, 2 decimals only when the value has decimals);
    `percent` (SUB-196) = the same de-DE path with a ` %` suffix (`8,5 %`) —
    the stored number IS the percent, no ×100 math. Display-only: the stored
    value never changes.

    Since SUB-834 the same field also names the column's UNIT: any units.ts
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
  /** date-kind only: macOS notification when the date comes due (SUB-21) */
  notify?: boolean;
  /** date-kind only (SUB-842): an ADDITIONAL macOS alert this many days
      before the date comes due. Independent of `notify` — either may stand
      alone, both set means two alerts. Absent/0 = off, capped at 365. */
  notifyBefore?: number;
  /** relation kind only: the database type this prop points at */
  type?: string;
  /** number kind only (SUB-188): display format; absent = plain */
  format?: NumberFormat;
  /** rollup kind only (SUB-678): the relation prop on the SAME database to
      follow — its `type` names the related database, its values name the
      linked rows */
  relation?: string;
  /** rollup kind only (SUB-678): the prop on the related database to read */
  prop?: string;
  /** rollup kind only (SUB-678): the aggregation over the linked rows'
      values — same vocabulary as the table footer's Calculate */
  agg?: AggKind;
  /** any kind, kindless select props included (SUB-191): a one-line entry
      hint shown muted where values are typed; absent = none */
  description?: string;
}

/** A rollup prop's wiring (SUB-678), as the schema editor hands it to
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

/** A database's icon (SUB-27): a curated outline glyph id or an emoji,
    optionally tinted with a muted palette name (`--opt-*` tokens). Stored on
    the type's entry in `.vault/schema.json` under the reserved `icon` key.
    See src/lib/dbicons.ts for the accessors that read it back out. */
export interface DbIcon {
  glyph?: string;
  emoji?: string;
  tint?: string;
}

/** Per-folder metadata (SUB-84), persisted in `.vault/views.json` under the
    reserved `$folders` key: currently just the folder's icon, in the SUB-27
    model. A folder rename retargets its keys (subtree included); trashing a
    folder drops them. */
export interface FolderMeta {
  icon?: DbIcon;
}

/** `$folders` map: vault-relative folder path → metadata. */
export type FolderMetaMap = Record<string, FolderMeta>;

/** How a tag folder's positive tags combine (SUB-818). */
export type TagMatch = "any" | "all";

/** One tag folder, as persisted in `.vault/tagfolders.json` (SUB-818).

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
    PropSchema) and `home` key (a folder path string, SUB-85) — both inert at
    every `?.kind`/`?.options` access site here; read them via typeIcon /
    typeHome. */
export type SchemaConfig = Record<string, Record<string, PropSchema>>;

/** One initial property in a create-database call: name + kind, `target`
    naming the pointed-at database for relation kinds. */
export interface NewTypeProp {
  name: string;
  kind?: PropKind | null;
  target?: string | null;
}

/** Outcome of a bulk note sweep (database rename/delete, property
    rename/clear): `notes` rewritten, `skipped` left untouched because the
    target key already existed.

    `failed` is the error of a sweep that died partway (SUB-501). The sweep
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
  /** Raw frontmatter per note as of this snapshot (SUB-822) — the body in
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

/** What one saved-view link-folder export did (SUB-810). */
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
  /** Vault-relative paths this pull's checkout rewrote (SUB-516) — the diff
      between the HEAD we came from and the one we landed on. Empty when
      nothing was checked out: a push, an up-to-date pull, a conflicted pull
      that parked. The app rides these in on `vault:pulled` to invalidate
      exactly the undo entries the checkout stepped on (docs/undo.md §3.5). */
  changed: string[];
}

export interface VaultSyncStatus {
  configured: boolean;
  last_result: SyncReport | null;
  last_error: string | null;
  /** Paths of the conflicted merge parked in git, read from the repository —
   * unlike `last_result`, this survives a restart (SUB-572). */
  conflicted: string[];
}

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
  if (v.kind === "tagfolder") return `tagfolder:${v.id}`;
  // folded, so #Demo and #demo are one destination — the same rule matching
  // uses (SUB-818)
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

/** The home folder on one type's schema entry, validated (SUB-85) — like
    typeIcon the reserved `home` key rides inside the flat prop map typed as
    `Record<string, PropSchema>`. Anything malformed reads as no home. */
export function typeHome(entry: Record<string, PropSchema> | undefined): string | undefined {
  if (!entry) return undefined;
  const raw = (entry as Record<string, unknown>).home;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}
