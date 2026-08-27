/* Import pipeline: one shared core, N source adapters.

   An adapter's whole job is to turn a source directory into `ImportItem`s —
   title, body, props, folder, attachments. Everything after that is here and
   is the same for every source: what a run would do (`buildPlan`), what it
   already did (the stamp props), and the note a finished run leaves behind
   (`importLogNote`).

   Pure by construction, like csvimport.ts next door: the plan is built from
   data a caller hands in, so this module loads under `node --test`. The half
   that picks a folder, reads files and writes notes touches Tauri IPC and
   lives in importrun.ts. */

/** Prop naming the source an imported note came from — the adapter's id
    (`logseq`), not a path. Pairs with `IMPORT_ID_PROP`: the two together are
    what a re-run matches on, so a second source with colliding ids of its own
    never shadows the first one's notes. */
export const IMPORT_SOURCE_PROP = "import-source";

/** Prop carrying the source's own identity for one note — for a file-backed
    source, its path relative to the picked root. Stable across runs of the
    same graph, which is the entire idempotency mechanism. */
export const IMPORT_ID_PROP = "import-id";

/** Folder the per-run log notes land in. */
export const IMPORT_LOG_FOLDER = "Imported/Logs";

/** One entry from the directory scan: path relative to the picked root
    (`/`-separated) and its size on disk. Every file-backed adapter is handed
    the same listing, so the shape lives here rather than in one of them. */
export interface ScanEntry {
  path: string;
  size: number;
}

/** One file to copy into the vault's assets alongside a note. */
export interface ImportAttachment {
  /** Path on disk, as the scan reported it — the importer hands this straight
      to the asset import, which is the only thing that reads bytes. */
  sourcePath: string;
  /** The name the body references it by, so the rewrite can find it. */
  filename: string;
}

/** One note-to-be, in the shape every adapter produces and the writer takes. */
export interface ImportItem {
  /** Value for `IMPORT_ID_PROP` — unique within one source. */
  importId: string;
  title: string;
  /** Vault folder, `/`-separated, no leading or trailing slash. */
  folder: string;
  body: string;
  /** Extra frontmatter, string pairs only (what `vault_create` writes). The
      stamp props are added by the writer, not by adapters. */
  props: [string, string][];
  /** ISO day for the `created` prop when the source knows one. */
  created?: string;
  attachments: ImportAttachment[];
}

/** A source file the adapter deliberately did not import, and why. The reason
    is user-facing prose in the preview, so it says what was skipped rather
    than naming a rule. */
export interface ImportSkip {
  path: string;
  reason: string;
}

/** One converted note, shown in the preview before anything is written.

    A count and a folder tree say how much would land; they say nothing about
    whether it would land *right*. For a source whose conversion is lossy by
    construction — an HTML export is not markdown, and no converter reads every
    tag — the only honest way to let someone judge that before confirming is to
    show them one note as it would actually be written. Adapters whose mapping
    is a passthrough leave this unset and the preview stays as it was. */
export interface ImportSample {
  title: string;
  /** The converted body, truncated for display — never the whole note. */
  markdown: string;
}

/** What an adapter returns for a picked directory. `notes` are one-line
    caveats the preview shows verbatim — what the import does NOT carry over. */
export interface SourceParse {
  items: ImportItem[];
  skips: ImportSkip[];
  notes: string[];
  sample?: ImportSample;
}

/** What a parse may report back while it runs, and how it is told to stop.
    Optional on both sides: an adapter that ignores it still works, and a
    caller that passes nothing still gets a parse. That is deliberate — the
    context is an addition to the adapter contract, not a change to it, so an
    adapter written against the older two-argument shape keeps compiling.

    `cancelled` is polled rather than awaited: a parse is a loop over files,
    and the cheapest honest place to abandon it is between two files. */
export interface ParseContext {
  /** Called as files are read, with how many of how many are done. Counts
      never go backwards within one parse. */
  onProgress?: (done: number, total: number) => void;
  /** Polled between batches; true means stop and throw. */
  cancelled?: () => boolean;
}

/** Thrown when a parse is abandoned. Its own error rather than a plain one so
    the pane can tell "the user pressed Cancel" from "the folder could not be
    read" and show an error for exactly one of them. */
export class ImportCancelled extends Error {
  constructor() {
    super("import cancelled");
    this.name = "ImportCancelled";
  }
}

/** Whether a thrown value is the cancellation above. Matched on the name, not
    with `instanceof`: the error crosses a module the pane imports lazily, and
    a name comparison cannot be defeated by two copies of the class. */
export function isImportCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "ImportCancelled";
}

/** Throw if the caller has cancelled. Exported because the stages either side
    of a parse — the scan, the vault listing — are worth abandoning too. */
export function throwIfCancelled(ctx?: ParseContext): void {
  if (ctx?.cancelled?.()) throw new ImportCancelled();
}

/** How many files are read at once. Not one (a graph is thousands of files and
    a serial walk is a minutes-long freeze behind a static line) and not all of
    them (thousands of concurrent reads at the IPC bridge starve the UI thread
    the preview is trying to stay responsive on). A batch is the middle: the
    bridge stays busy, and progress reaches the screen between batches. */
export const READ_BATCH = 24;

/** Read a list of source files into a map of path → text, in batches, with
    progress and a cancel between each. A file that will not read is left out
    of the map rather than failing the parse — the adapter turns its absence
    into a counted skip, which is what the preview shows.

    Pure in the sense this module means it: `read` is handed in, so the caller
    owns the IPC and this loop is testable with a function that resolves. */
export async function readSourceTexts(
  paths: string[],
  read: (path: string) => Promise<string>,
  ctx?: ParseContext,
  batchSize: number = READ_BATCH
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  const total = paths.length;
  const size = Math.max(1, batchSize);
  /* Announced before the first read, so the pane can say "Reading 0 of 4820"
     rather than "Reading the folder…" for as long as the first batch takes. */
  ctx?.onProgress?.(0, total);
  for (let start = 0; start < total; start += size) {
    throwIfCancelled(ctx);
    const batch = paths.slice(start, start + size);
    const got = await Promise.all(
      batch.map(async (path) => {
        try {
          return [path, await read(path)] as const;
        } catch {
          return [path, null] as const;
        }
      })
    );
    for (const [path, text] of got) if (text !== null) texts.set(path, text);
    ctx?.onProgress?.(start + batch.length, total);
  }
  /* Checked once more at the end: a cancel arriving during the last batch has
     to abandon the parse rather than fall through into a built plan. */
  throwIfCancelled(ctx);
  return texts;
}

/** One row of the preview's folder tree. */
export interface FolderCount {
  folder: string;
  notes: number;
}

/** Everything the confirm step shows, and everything the run then executes.
    Built before a single byte is written — that ordering is the point. */
export interface ImportPlan {
  /** Adapter id, e.g. `logseq`. */
  source: string;
  /** The picked root, for the log note's record of what ran. */
  root: string;
  /** Notes that would be created. */
  create: ImportItem[];
  /** Notes whose stamp is already in the vault — a re-run's skip set. Kept as
      whole items rather than a count so the preview can name them. */
  alreadyImported: ImportItem[];
  skips: ImportSkip[];
  notes: string[];
  folders: FolderCount[];
  attachmentCount: number;
  /** Titles that repeat within `create`, with how many times. The vault's own
      create dedupes filenames ("Idea 2.md"), so these land side by side rather
      than overwriting — the preview says so instead of the user finding out. */
  titleCollisions: { title: string; folder: string; count: number }[];
  /** How many of `create` land in a folder that already holds a note of that
      title. Same non-overwriting outcome as `titleCollisions` — "Idea 2" beside
      "Idea" — but against the vault rather than within the run, and worth its
      own line: a journal that lands as "2026-02-01 2" is not that day's daily
      note at all, and the preview is the only place to say so before the run. */
  existingCollisions: number;
  /** One converted note as it would be written, when the adapter offers one. */
  sample?: ImportSample;
  /** Subfolders of the picked root the engine could not open, and therefore
      did not offer. Not an error — a graph beside an unreadable folder still
      imports — but a count the preview says out loud, because the alternative
      is a user comparing note totals and finding the difference themselves. */
  unreadableDirs: number;
}

/** The key a stamp pair matches on. Source and id are both part of it: two
    sources may each number their notes from one.

    JSON rather than a joined string with a separator character: an id is a
    source-controlled path and may hold anything, so any separator picked out of
    the printable range can be forged, and the non-printable one that cannot be
    does not survive every transform this module is parsed by. An encoding that
    is unambiguous everywhere costs nothing here — the key is never stored, only
    compared. */
export function stampKey(source: string, id: string): string {
  return JSON.stringify([source, id]);
}

/** The stamps already in the vault, read off the note index. Props arrive as
    `Record<string, unknown>` (any YAML scalar), so anything non-string is
    ignored rather than coerced — a note whose `import-id` is a list is not a
    stamp this pipeline wrote.

    Keys are matched lowercased: YAML keeps whatever case the file was written
    with, and a stamp a user retyped as `Import-Id:` is still the stamp this
    pipeline is looking for. Reading it case-sensitively would call the note
    unimported and write a second copy. */
export function existingStamps(notes: { props: Record<string, unknown> }[]): Set<string> {
  const out = new Set<string>();
  for (const note of notes) {
    let source: unknown;
    let id: unknown;
    for (const [key, value] of Object.entries(note.props)) {
      const lower = key.toLowerCase();
      if (lower === IMPORT_SOURCE_PROP) source = value;
      else if (lower === IMPORT_ID_PROP) id = value;
    }
    if (typeof source === "string" && typeof id === "string" && source && id) {
      out.add(stampKey(source, id));
    }
  }
  return out;
}

/** The props one imported note carries on top of the adapter's own. Adapter
    props win nothing here — a source page with its own `import-id` property
    would otherwise be able to forge a stamp, so the stamp is written last.

    The filter is case-insensitive because the vault's create refuses a note
    whose props hold two keys differing only in case: a source page carrying
    `Import-Id::` would otherwise not forge a stamp but kill the whole note.

    `created` is deliberately absent. The create stamps every new note with the
    current day and drops a caller's own `created`, so the source's date is set
    on the note after it lands — see the writer in importrun.ts. */
export function stampProps(source: string, item: ImportItem): [string, string][] {
  const stamped = new Set<string>([IMPORT_SOURCE_PROP, IMPORT_ID_PROP]);
  const props = item.props.filter(([key]) => !stamped.has(key.toLowerCase()));
  props.push([IMPORT_SOURCE_PROP, source], [IMPORT_ID_PROP, item.importId]);
  return props;
}

/** Notes per folder, deepest-path-sorted for a stable tree. Folders with no
    notes of their own never appear — the tree lists what gets written. */
export function planFolderTree(items: ImportItem[]): FolderCount[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.folder, (counts.get(item.folder) ?? 0) + 1);
  return [...counts.entries()]
    .map(([folder, notes]) => ({ folder, notes }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

/** Titles that repeat inside one folder of one run. Case-insensitive, because
    the vault's create dedupes that way too. */
export function planTitleCollisions(
  items: ImportItem[]
): { title: string; folder: string; count: number }[] {
  const seen = new Map<string, { title: string; folder: string; count: number }>();
  for (const item of items) {
    const key = JSON.stringify([item.folder, item.title.toLowerCase()]);
    const hit = seen.get(key);
    if (hit) hit.count += 1;
    else seen.set(key, { title: item.title, folder: item.folder, count: 1 });
  }
  return [...seen.values()]
    .filter((entry) => entry.count > 1)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** The dry run. Splits the adapter's items into what would be written and what
    a previous run already wrote, then counts the rest. Writes nothing — the
    caller shows this and waits for a confirmation before executing it.

    `existingTitles` is the vault's own notes as lowercased `folder/title`, so
    the plan can count the imports that land beside a note that is already
    there. `unreadableDirs` is carried through from the scan rather than
    computed here — the plan is the one thing the preview reads. */
export function buildPlan(
  source: string,
  root: string,
  parse: SourceParse,
  existing: Set<string>,
  existingTitles: Set<string>,
  unreadableDirs = 0
): ImportPlan {
  const create: ImportItem[] = [];
  const alreadyImported: ImportItem[] = [];
  /* Duplicate ids inside one parse would otherwise each be created: the first
     is written, the rest are a bug in the adapter, not a re-run. Fold them in
     with the already-imported so a run stays idempotent against itself. */
  const seen = new Set<string>();
  for (const item of parse.items) {
    const key = stampKey(source, item.importId);
    if (existing.has(key) || seen.has(key)) alreadyImported.push(item);
    else {
      seen.add(key);
      create.push(item);
    }
  }
  return {
    source,
    root,
    create,
    alreadyImported,
    skips: parse.skips,
    notes: parse.notes,
    folders: planFolderTree(create),
    attachmentCount: create.reduce((n, item) => n + item.attachments.length, 0),
    titleCollisions: planTitleCollisions(create),
    existingCollisions: create.filter((item) =>
      existingTitles.has(`${item.folder}/${item.title}`.toLowerCase())
    ).length,
    sample: parse.sample,
    unreadableDirs,
  };
}

/** Skips grouped by reason, for the preview's one line per reason rather than
    one line per file — a graph with 400 unsupported files is a count. */
export function skipSummary(skips: ImportSkip[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const skip of skips) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** What a finished run reports back, and what the log note records. */
export interface ImportResult {
  created: number;
  /** Paths the vault's create returned — the record of where things landed,
      suffixes and all. */
  paths: string[];
  attachments: number;
  skippedAlreadyImported: number;
  skippedFiles: number;
  /** Items whose write threw, with the error text. A failure is one note, not
      the run: the rest still land and the log says which did not. */
  failures: { title: string; error: string }[];
}

/** What a wikilink to a written note has to say. A wikilink resolves on a
    title or a filename stem, never on a path, so the log's list of what landed
    has to name the stem or every link in it is dead. The stem carries the
    create's dedupe suffix too ("Reeds 2"), which is exactly the note the run
    wrote rather than the one it landed beside. */
function linkTarget(path: string): string {
  const stem = path.slice(path.lastIndexOf("/") + 1);
  return stem.replace(/\.md$/i, "");
}

/** The note one executed run leaves in the vault, so the import has a record
    that outlives the dialog. `at` is passed in rather than read from the clock
    here — this module stays pure, and the caller already knows the time. */
export function importLogNote(
  plan: ImportPlan,
  result: ImportResult,
  at: string
): { title: string; folder: string; props: [string, string][]; body: string } {
  const day = at.slice(0, 10);
  const lines = [
    `Imported from ${plan.source} at ${at}.`,
    "",
    `- Source folder: \`${plan.root}\``,
    `- Notes created: ${result.created}`,
    `- Attachments copied: ${result.attachments}`,
    `- Already imported, skipped: ${result.skippedAlreadyImported}`,
    `- Files skipped: ${result.skippedFiles}`,
  ];
  if (result.failures.length) {
    lines.push(`- Failed to write: ${result.failures.length}`);
    lines.push("");
    lines.push("## Failures");
    for (const failure of result.failures) lines.push(`- ${failure.title} — ${failure.error}`);
  }
  const skips = skipSummary(plan.skips);
  if (skips.length) {
    lines.push("");
    lines.push("## Skipped files");
    for (const skip of skips) lines.push(`- ${skip.reason}: ${skip.count}`);
  }
  if (result.paths.length) {
    lines.push("");
    lines.push("## Notes written");
    for (const path of result.paths) lines.push(`- [[${linkTarget(path)}]]`);
  }
  return {
    title: `Import — ${plan.source} — ${at.replace(/[:.]/g, "-")}`,
    folder: IMPORT_LOG_FOLDER,
    props: [
      ["created", day],
      ["import-log", plan.source],
    ],
    body: lines.join("\n"),
  };
}

/** A vault folder segment that survives being a filename: the separators and
    the characters no filesystem in the estate agrees on. Empty in, empty out —
    the caller decides what an unnamed segment falls back to. */
export function safeSegment(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
}
