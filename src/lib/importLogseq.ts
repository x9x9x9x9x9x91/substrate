import type {
  ImportAttachment,
  ImportItem,
  ImportSkip,
  ScanEntry,
  SourceParse,
} from "./importer.ts";
import { safeSegment } from "./importer.ts";

/* Logseq adapter: a Logseq graph directory → the import pipeline's common
   intermediate. Pure, like importer.ts — it is handed the file listing and the
   text of the files it asked for, and never reads disk itself, so it loads
   under `node --test`. importrun.ts does the reading.

   A Logseq graph is three folders that matter:

     pages/     one markdown file per page; `key:: value` lines at the top are
                the page's properties
     journals/  one file per day, named for the day
     assets/    the binaries pages embed

   What this deliberately does NOT do is interpret the outline. Logseq's blocks
   carry identity, refs and collapse state; markdown lists do not. Bullets come
   across as bullets — the text survives exactly, the block semantics do not,
   and the preview says so rather than half-converting them. */

/** Where imported pages land, with the page's namespace beneath it. */
export const LOGSEQ_PAGES_FOLDER = "Imported/Logseq";

/** Where journal files land — the vault's own daily-note folder, so an
    imported day is the same note the app opens for that date. */
export const JOURNAL_FOLDER = "Journal";

/** The adapter's id, and the value of the `import-source` stamp. */
export const LOGSEQ_SOURCE = "logseq";

/** The scan entry shape moved to importer.ts once a second adapter took the
    same listing; re-exported here so a caller reaching for the Logseq adapter's
    types still finds it. */
export type { ScanEntry } from "./importer.ts";

/** The scan sorted into what the parse will do with it. */
export interface LogseqScan {
  /** Relative paths of `pages/*.md`. */
  pages: string[];
  /** Relative paths of `journals/*.md`. */
  journals: string[];
  /** Asset filename (lowercased) → its relative path, for reference lookup. */
  assets: Map<string, string>;
  skips: ImportSkip[];
}

/** A Logseq page property line: `key:: value`, optionally as the first
    bullet. Keys are letters, digits, dashes and underscores — anything else
    is prose that happens to contain a colon pair. */
const PROP_LINE = /^(?:-\s+)?([A-Za-z][A-Za-z0-9_-]*)::[ \t]*(.*)$/;

/** `2026_08_27`, `2026-08-27` and `2026_08_27` with any of the separators
    Logseq's date formats produce. */
const JOURNAL_NAME = /^(\d{4})[-_](\d{2})[-_](\d{2})$/;

/** Asset references in a page body: `![alt](../assets/name.png)`, with however
    many `../` the page sat behind. */
const ASSET_REF = /\((?:\.{1,2}\/)*assets\/([^)\s]+)\)/g;

/** Page properties the vault owns outright: the engine's create writes its own
    `title`, `type` and `created` and drops a caller's, so a source page's would
    disappear without a trace. Kept under a prefixed name instead. */
const RESERVED_PROPS = new Set(["title", "type", "created"]);

/** Biggest `pages/` or `journals/` file the parse will read. A markdown file
    past this is a database export or a pasted log, not a page, and reading a
    graph full of them is what turns a preview into a hang. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** The extensions the pipeline treats as text to parse. */
function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function fileName(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

/** An asset reference reduced to the name the scan indexed it under. The scan
    keys on the filename alone, so `assets/2026/tide.png` and `assets/tide.png`
    are one entry, last-wins — two same-named files in different asset
    subfolders are indistinguishable to this import. */
function assetName(raw: string): string {
  const base = raw.slice(raw.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(base);
  } catch {
    // a stray `%` that is not an escape — the raw name is the honest fallback
    return base;
  }
}

/** Sort a scan into pages, journals, assets and reasons-not-to. Everything
    unrecognized is a counted skip rather than a silent drop: a graph the user
    thinks is fully imported, minus a folder nobody mentioned, is the failure
    mode this exists to prevent. */
export function logseqClassify(files: ScanEntry[]): LogseqScan {
  const pages: string[] = [];
  const journals: string[] = [];
  const assets = new Map<string, string>();
  const skips: ImportSkip[] = [];
  for (const file of files) {
    const path = file.path;
    const name = fileName(path);
    /* Logseq's own bookkeeping and the editor's leftovers. Neither is content
       and both are in every graph, so they are not worth a skip line. */
    if (name.startsWith(".") || path.startsWith("logseq/") || path.startsWith(".git/")) continue;
    if (path.toLowerCase().endsWith(".org")) {
      skips.push({ path, reason: "org-mode file — this import reads markdown only" });
      continue;
    }
    if (path.startsWith("assets/")) {
      assets.set(name.toLowerCase(), path);
      continue;
    }
    const isPage = path.startsWith("pages/") && isMarkdown(path);
    const isJournal = path.startsWith("journals/") && isMarkdown(path);
    if ((isPage || isJournal) && file.size > MAX_PAGE_BYTES) {
      skips.push({ path, reason: "larger than the 2 MiB page cap" });
      continue;
    }
    if (isPage) {
      pages.push(path);
      continue;
    }
    if (isJournal) {
      journals.push(path);
      continue;
    }
    if (isMarkdown(path)) {
      skips.push({ path, reason: "markdown outside pages/ and journals/" });
      continue;
    }
    skips.push({ path, reason: "not a page, a journal or a referenced asset" });
  }
  pages.sort();
  journals.sort();
  return { pages, journals, assets, skips };
}

/** Split a page's leading property block off its body. Logseq puts page
    properties in the first block, so the scan stops at the first line that is
    neither a property nor blank — a `key:: value` further down is content
    (a block property) and stays in the body where it was written.

    A key written twice keeps its first spelling and position and its last
    value: the vault's create refuses a note whose props hold two keys differing
    only in case, so a page with both `Alias::` and `alias::` would otherwise
    not import at all. */
export function splitPageProps(text: string): { props: [string, string][]; body: string } {
  const lines = text.split("\n");
  const props: [string, string][] = [];
  const slots = new Map<string, number>();
  let at = 0;
  for (; at < lines.length; at++) {
    const line = lines[at];
    if (!line.trim()) {
      // a blank line before any property is just leading space; after one it
      // closes the block
      if (props.length) {
        at++;
        break;
      }
      continue;
    }
    const hit = PROP_LINE.exec(line);
    if (!hit) break;
    const value = hit[2].trim();
    // a property with no value carries nothing across; Logseq writes these
    // when a field is cleared rather than removed
    if (!value) continue;
    const slot = slots.get(hit[1].toLowerCase());
    if (slot === undefined) {
      slots.set(hit[1].toLowerCase(), props.length);
      props.push([hit[1], value]);
    } else {
      props[slot] = [props[slot][0], value];
    }
  }
  return { props, body: lines.slice(at).join("\n").replace(/^\n+/, "").trimEnd() };
}

/** The vault title and folder for a `pages/` file. Logseq encodes a page's
    namespace in the filename — `Work%2FClients.md` in current graphs, the
    older `Work___Clients.md` before that — and both mean a hierarchy, so both
    become folders under the import root. */
export function pageTarget(relPath: string): { title: string; folder: string } {
  const stem = fileName(relPath).replace(/\.md$/i, "");
  let decoded = stem;
  try {
    decoded = decodeURIComponent(stem);
  } catch {
    // a stray `%` that is not an escape — the raw name is the honest fallback
  }
  const segments = decoded
    .split(/___|\//)
    .map((segment) => safeSegment(segment))
    .filter(Boolean);
  const title = segments.pop() || safeSegment(stem) || "Untitled";
  return {
    title,
    folder: [LOGSEQ_PAGES_FOLDER, ...segments].join("/"),
  };
}

/** The ISO day a `journals/` filename names, or null when the name is not a
    date — an unrecognized journal file is a skip, not a guess. */
export function journalDay(relPath: string): string | null {
  const stem = fileName(relPath).replace(/\.md$/i, "");
  const hit = JOURNAL_NAME.exec(stem);
  if (!hit) return null;
  const [, year, month, day] = hit;
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;
  return `${year}-${month}-${day}`;
}

/** The assets a body embeds, resolved against the scan. A reference to a file
    the graph does not contain is dropped from the attachment list — the body
    keeps the reference text, which reads as the broken link it already was. */
export function bodyAssets(body: string, assets: Map<string, string>): ImportAttachment[] {
  const out: ImportAttachment[] = [];
  const seen = new Set<string>();
  for (const hit of body.matchAll(ASSET_REF)) {
    const name = assetName(hit[1]);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    const sourcePath = assets.get(key);
    if (!sourcePath) continue;
    seen.add(key);
    out.push({ sourcePath, filename: name });
  }
  return out;
}

/** Point a body's asset references at the vault's own embed form. `landed`
    maps the source filename to the name the vault gave it, which is only known
    once the asset is copied in — so this runs at write time, not parse time.

    The leading `!` in the source makes no difference to what comes out.
    `![[name]]` is the vault's only asset reference form (vault-format §9): a
    plain `[[name]]` is a link to a *note* of that name, so keeping the source's
    bang would turn `[the brief](../assets/brief.pdf)` into a wikilink pointing
    at nothing. The alt text is lost either way — the form carries none. */
export function rewriteAssetRefs(body: string, landed: Map<string, string>): string {
  return body.replace(/!?\[([^\]]*)\]\((?:\.{1,2}\/)*assets\/([^)\s]+)\)/g, (whole, _alt, raw) => {
    const vaultName = landed.get(assetName(raw).toLowerCase());
    if (!vaultName) return whole;
    return `![[${vaultName}]]`;
  });
}

/** The whole graph, parsed. `texts` holds the content of every path in the
    scan's `pages` and `journals` — a path missing from it becomes a skip
    rather than an empty note, so a file that failed to read is visible.

    `graphName` is the picked folder's own name, and it leads every import id.
    Without it two graphs that each hold a `pages/Reeds.md` read as one
    another's re-run, and the second import silently writes nothing. */
export function logseqParse(
  scan: LogseqScan,
  texts: Map<string, string>,
  graphName: string
): SourceParse {
  const items: ImportItem[] = [];
  const skips = [...scan.skips];
  const referenced = new Set<string>();

  const take = (relPath: string, title: string, folder: string, created?: string) => {
    const text = texts.get(relPath);
    if (text === undefined) {
      skips.push({ path: relPath, reason: "couldn't be read" });
      return;
    }
    const { props: sourceProps, body } = splitPageProps(text);
    const props = sourceProps.map(([key, value]): [string, string] => {
      const lower = key.toLowerCase();
      return RESERVED_PROPS.has(lower) ? [`logseq-${lower}`, value] : [key, value];
    });
    if (!body.trim() && !props.length) {
      skips.push({ path: relPath, reason: "empty page" });
      return;
    }
    const attachments = bodyAssets(body, scan.assets);
    for (const attachment of attachments) referenced.add(attachment.sourcePath);
    items.push({
      // the graph name and the source path are the id: stable across runs of
      // the same folder, unique across graphs, and readable in the frontmatter
      // as where the note came from
      importId: `${graphName}/${relPath}`,
      title,
      folder,
      body,
      props,
      created,
      attachments,
    });
  };

  for (const page of scan.pages) {
    const { title, folder } = pageTarget(page);
    take(page, title, folder);
  }
  for (const journal of scan.journals) {
    const day = journalDay(journal);
    if (!day) {
      skips.push({ path: journal, reason: "journal filename is not a date" });
      continue;
    }
    take(journal, day, JOURNAL_FOLDER, day);
  }

  for (const path of scan.assets.values()) {
    if (!referenced.has(path)) skips.push({ path, reason: "asset no imported page embeds" });
  }

  return {
    items,
    skips,
    notes: [
      "Outline bullets come across as markdown lists — the text is kept, but block references, ids and collapse state are not.",
      "Page properties become frontmatter; properties written inside a block stay in the body text.",
      "Properties named title, type or created are kept as logseq-title, logseq-type, logseq-created — the vault owns those keys.",
    ],
  };
}
