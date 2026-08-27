import type { ImportItem, ImportSkip, SourceParse } from "./importer.ts";
import { safeSegment } from "./importer.ts";
import { bodyAssets, rewriteAssetRefs, type ScanEntry } from "./importLogseq.ts";

/* Bear adapter: a Bear export folder → the import pipeline's common
   intermediate. Pure, like importer.ts and importLogseq.ts — it is handed the
   file listing and the text of the files it asked for, and never reads disk
   itself, so it loads under `node --test`. importrun.ts does the reading.

   What Bear's "Export notes" writes into a folder is one of two things, and
   this reads both:

     Name.md            a plain markdown file, named for the note's title
     Name.textbundle/   a directory holding text.md (or text.markdown),
                        optional info.json metadata, and assets/ for whatever
                        the note embeds

   Bear has no folders — a note's place is its tags. So the first tag on a note
   becomes its folder path under the import root, nested tags included, and the
   rest become a `tags` property. The tag text itself is taken out of the body,
   because a tag in Bear is a filing statement written inline, not prose.

   What this deliberately does NOT do is open an archive. A `.bear2bk` backup
   and a `.textpack` are zip files; the folder picker cannot see inside one and
   nothing here unzips. Both are counted skips saying so, rather than an empty
   import that looks like it worked. */

/** Where imported notes land, with the note's first tag beneath it. */
export const BEAR_FOLDER = "Imported/Bear";

/** The adapter's id, and the value of the `import-source` stamp. */
export const BEAR_SOURCE = "bear";

/** Biggest note file the parse will read — the cap the Logseq adapter reads
    pages under, for the same reason: a markdown file past this is a pasted log
    or a database dump, and reading a folder of them turns a preview into a
    hang. */
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

/** A note the scan found: one markdown file, plus whatever the text bundle
    around it carried. A plain `.md` export has no bundle, so no info and no
    assets. */
export interface BearNote {
  /** Path of the note's markdown, relative to the picked root. This is the
      tail of the import id, so it is what a re-run matches on. */
  path: string;
  /** Filename the title falls back to, extension off — the bundle's own name
      for a bundle, the file's for a plain export. Bear names both for the
      note's title. */
  stem: string;
  /** Path of the bundle's `info.json`, when it has one. */
  info?: string;
  /** Asset filename (lowercased) → its relative path, for reference lookup.
      Bundle-scoped: two bundles may each hold an `image.png` without either
      shadowing the other. */
  assets: Map<string, string>;
}

/** The scan sorted into what the parse will do with it. */
export interface BearScan {
  notes: BearNote[];
  /** Every path the parse needs read, in the order it wants them — note texts
      and the info files beside them. */
  reads: string[];
  skips: ImportSkip[];
}

/** A Bear tag, in both forms the app writes: `#tag`, `#tag/nested`, and the
    closed `#multi word tag#` used when a tag holds spaces.

    The closed form is tried first, and its content may hold neither a `#` nor
    a leading or trailing space — that is what keeps `#one more text #two` from
    reading as one tag named "one more text ". The open form must start with a
    letter, so `#1` in prose ("take #2") is a number and a markdown heading
    (`# Notes`, `## Notes`) is a heading.

    A second `#` sitting tight against a word later on the same line therefore
    closes the first one — `#reeds and a C#` is the single tag "reeds and a C",
    not "reeds" and some prose. That is Bear's own reading of that line, and
    following it is what makes the import match the app it came from. */
const TAG_TOKEN = /#(?:([^#\s](?:[^#\n]*[^#\s])?)#|([A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_-]+)*))/g;

/** A fence line, opening or closing. Tags are not read inside one — literal
    code is not tag syntax, the rule the vault's own tags follow. */
const FENCE_LINE = /^\s*(?:```|~~~)/;

/** An archive this import cannot open: Bear's own backup and the zipped form
    of a text bundle. Matched on any path segment, so the files inside one that
    the scan happened to walk are named by their archive too. */
const ARCHIVE_SEGMENT = /\.(bear2bk|textpack)$/i;

const BUNDLE_SEGMENT = /\.textbundle$/i;

function fileName(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function stemOf(name: string): string {
  return name.replace(/\.(md|markdown|textbundle)$/i, "");
}

/** The `X.textbundle` prefix a path sits under, or null when it sits under
    none. The outermost bundle wins: a bundle inside a bundle is one note with
    an oddly named asset, not two. */
function bundleRootOf(path: string): string | null {
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (BUNDLE_SEGMENT.test(parts[i])) return parts.slice(0, i + 1).join("/");
  }
  return null;
}

function archiveReason(path: string): string | null {
  for (const part of path.split("/")) {
    if (ARCHIVE_SEGMENT.test(part)) {
      return part.toLowerCase().endsWith(".bear2bk")
        ? "Bear backup archive — unzip it and pick the folder inside"
        : "zipped text bundle — unzip it and pick the folder inside";
    }
  }
  return null;
}

/** One text bundle, while the scan is still filling it in. */
interface Bundle {
  root: string;
  text?: string;
  info?: string;
  assets: Map<string, string>;
  /** Its text file was past the size cap, so the bundle has already raised the
      one skip line it is going to raise. */
  oversize: boolean;
}

/** Sort a scan into notes, the files beside them, and reasons-not-to.
    Everything unrecognized is a counted skip rather than a silent drop: an
    export the user thinks landed in full, minus the half that was in a format
    nobody mentioned, is the failure mode this exists to prevent. */
export function bearClassify(files: ScanEntry[]): BearScan {
  const bundles = new Map<string, Bundle>();
  const loose: BearNote[] = [];
  const skips: ImportSkip[] = [];

  for (const file of files) {
    const path = file.path;
    const name = fileName(path);
    /* The editor's leftovers and a repository around the export. Neither is
       content and both turn up in any folder, so neither is worth a skip. */
    if (name.startsWith(".") || path.startsWith(".git/")) continue;

    const archive = archiveReason(path);
    if (archive) {
      skips.push({ path, reason: archive });
      continue;
    }

    const bundleRoot = bundleRootOf(path);
    if (bundleRoot) {
      let bundle = bundles.get(bundleRoot);
      if (!bundle) {
        bundle = { root: bundleRoot, assets: new Map(), oversize: false };
        bundles.set(bundleRoot, bundle);
      }
      const rel = path.slice(bundleRoot.length + 1);
      const relLower = rel.toLowerCase();
      if (relLower === "text.md" || relLower === "text.markdown") {
        if (file.size > MAX_NOTE_BYTES) {
          skips.push({ path, reason: "larger than the 2 MiB note cap" });
          bundle.oversize = true;
        } else {
          bundle.text = path;
        }
        continue;
      }
      if (relLower === "info.json") {
        bundle.info = path;
        continue;
      }
      if (relLower.startsWith("assets/")) {
        const key = name.toLowerCase();
        /* Two assets under one bundle sharing a filename: references name a
           file, so only one of them can be the one a reference means. The
           other is counted rather than overwritten, because an embed that
           quietly points at the wrong image is the worse outcome. */
        if (bundle.assets.has(key)) {
          skips.push({ path, reason: "same name as another asset in this bundle" });
        } else {
          bundle.assets.set(key, path);
        }
        continue;
      }
      skips.push({ path, reason: "inside a text bundle, but not its text, assets or info" });
      continue;
    }

    if (isMarkdown(path)) {
      if (file.size > MAX_NOTE_BYTES) {
        skips.push({ path, reason: "larger than the 2 MiB note cap" });
        continue;
      }
      loose.push({ path, stem: stemOf(name), assets: new Map() });
      continue;
    }

    skips.push({ path, reason: "not a note, a text bundle or a file one of them uses" });
  }

  const notes = [...loose];
  for (const root of [...bundles.keys()].sort()) {
    const bundle = bundles.get(root)!;
    if (!bundle.text) {
      /* A bundle with no text carries nothing to import — and saying so once,
         about the bundle, beats one line per asset inside it. */
      if (!bundle.oversize) skips.push({ path: root, reason: "text bundle with no text file" });
      continue;
    }
    notes.push({
      path: bundle.text,
      stem: stemOf(fileName(root)),
      info: bundle.info,
      assets: bundle.assets,
    });
  }
  notes.sort((a, b) => a.path.localeCompare(b.path));

  const reads: string[] = [];
  for (const note of notes) {
    reads.push(note.path);
    if (note.info) reads.push(note.info);
  }
  return { notes, reads, skips };
}

/** The note's title, the tags the title line carried, and the body with that
    title taken off. Bear exports open on an `# H1` of the note's own title, so
    keeping it would write the title into the note twice; a file with no
    leading heading falls back to its name, which is what Bear named it for. A
    heading further down is a heading and stays where it was written.

    A tag written on the title line is filing, the same as one written in the
    body — Bear lets a note be tagged from its first line. So it comes out of
    the title rather than into the filename, and it counts ahead of the body's
    tags, which is the order the document put them in. */
export function splitTitle(
  text: string,
  stem: string
): { title: string; body: string; tags: string[] } {
  const lines = text.split("\n");
  let at = 0;
  while (at < lines.length && !lines[at].trim()) at++;
  const heading = at < lines.length ? /^#[ \t]+(.+?)[ \t]*$/.exec(lines[at]) : null;
  if (!heading) {
    return {
      title: safeSegment(stem) || "Untitled",
      body: text.replace(/^\n+/, "").trimEnd(),
      tags: [],
    };
  }
  const { tags, body: titled } = extractTags(heading[1]);
  const body = lines
    .slice(at + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd();
  return { title: safeSegment(titled) || safeSegment(stem) || "Untitled", body, tags };
}

/** Take the tags out of one line of prose, returning what is left. `before` is
    the character the line held ahead of this stretch, so a `#` that follows a
    word character — a URL fragment, an id in prose — is not read as a tag.
    Only a word character: `(#gear)` and `"#gear` are tags in Bear, and
    punctuation ahead of one is punctuation, not an id it belongs to. */
function takeLineTags(text: string, before: string, found: string[]): string {
  let out = "";
  let at = 0;
  TAG_TOKEN.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = TAG_TOKEN.exec(text))) {
    const prev = hit.index === 0 ? before : text[hit.index - 1];
    if (prev && /\w/.test(prev)) {
      TAG_TOKEN.lastIndex = hit.index + 1;
      continue;
    }
    found.push((hit[1] ?? hit[2]).trim());
    out += text.slice(at, hit.index);
    at = hit.index + hit[0].length;
    /* Lifting the token out leaves the space ahead of it beside the space
       behind it. Merging exactly those two is the whole cleanup — every other
       run of spaces on the line was typed, and aligned columns are the case
       that notices when it is not. */
    if (/[ \t]$/.test(out) && /^[ \t]/.test(text.slice(at))) at++;
  }
  return out + text.slice(at);
}

/** Tags in the order they were written, first spelling wins, one entry per
    tag however many times and however it was cased. */
function dedupeTags(raw: string[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const tag of raw) {
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** Every tag a body carries, in the order it carries them, and the body with
    the tag tokens taken out. Tags inside a fenced block or an inline code span
    are code, not filing — the same rule the vault's own tag extraction
    follows.

    A line that held nothing but tags goes with them: Bear writes a note's
    filing on its own last line, and leaving that line behind as whitespace is
    a blank paragraph the user never typed. A line that held prose keeps it,
    with only the token removed. */
export function extractTags(body: string): { tags: string[]; body: string } {
  const raw: string[] = [];
  const kept: string[] = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (FENCE_LINE.test(line)) {
      fenced = !fenced;
      kept.push(line);
      continue;
    }
    if (fenced || !line.includes("#")) {
      kept.push(line);
      continue;
    }
    const found: string[] = [];
    const parts = line.split("`");
    /* An odd number of backticks on the line leaves the last one unpaired, and
       an unpaired backtick is literal text rather than the opening of a code
       span — so that trailing segment is prose, and its tags count. */
    const trailingProse = parts.length % 2 === 0 ? parts.length - 1 : -1;
    let before = "";
    for (let i = 0; i < parts.length; i++) {
      // even segments are prose; odd ones are inline code, kept verbatim
      if (i % 2 === 0 || i === trailingProse) parts[i] = takeLineTags(parts[i], before, found);
      before = parts[i].slice(-1) || before;
    }
    if (!found.length) {
      kept.push(line);
      continue;
    }
    raw.push(...found);
    const stripped = parts.join("`");
    if (line.trim() && !stripped.trim()) continue;
    kept.push(stripped.trimEnd());
  }
  return {
    tags: dedupeTags(raw),
    body: kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").trimEnd(),
  };
}

/** The folder segments one tag names. `#work/clients` is two levels, the way
    it reads in Bear's sidebar. A tag that survives as nothing — punctuation
    only — names no folder, and the note lands at the import root. */
export function tagFolder(tag: string | undefined): string {
  if (!tag) return BEAR_FOLDER;
  const segments = tag
    .split("/")
    .map((segment) => safeSegment(segment))
    .filter(Boolean);
  return [BEAR_FOLDER, ...segments].join("/");
}

/** The dates a text bundle's `info.json` carries, as ISO days. Bear writes
    them under its own key; a bundle from another app has none, and an
    unparseable file is treated as one that has none — a wrong date nobody
    would notice is worse than the vault's own, which is at least honest about
    being the day the note landed. */
export function bearDates(infoText: string | undefined): { created?: string; modified?: string } {
  if (!infoText) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(infoText);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const meta = (parsed as Record<string, unknown>)["net.shinyfrog.bear"];
  if (!meta || typeof meta !== "object") return {};
  const day = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const hit = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    return hit ? hit[1] : undefined;
  };
  const fields = meta as Record<string, unknown>;
  return { created: day(fields.creationDate), modified: day(fields.modificationDate) };
}

/** The whole export, parsed. `texts` holds the content of every path the scan
    asked for — a note missing from it becomes a skip rather than an empty
    note, so a file that failed to read is visible.

    `exportName` is the picked folder's own name, and it leads every import id.
    Without it two exports that each hold a `Reeds.md` read as one another's
    re-run, and the second import silently writes nothing. */
export function bearParse(
  scan: BearScan,
  texts: Map<string, string>,
  exportName: string
): SourceParse {
  const items: ImportItem[] = [];
  const skips = [...scan.skips];
  const referenced = new Set<string>();

  for (const note of scan.notes) {
    const text = texts.get(note.path);
    if (text === undefined) {
      skips.push({ path: note.path, reason: "couldn't be read" });
      continue;
    }
    const { title, body: afterTitle, tags: titleTags } = splitTitle(text, note.stem);
    const { tags: bodyTags, body } = extractTags(afterTitle);
    const tags = dedupeTags([...titleTags, ...bodyTags]);
    const props: [string, string][] = [];
    /* The first tag is the note's place; the rest are what it is about. The
       vault reads a bare `tags` scalar as a comma-separated list (§3b), which
       is the shape a prop pair can carry. */
    if (tags.length > 1) props.push(["tags", tags.slice(1).join(", ")]);
    const infoText = note.info ? texts.get(note.info) : undefined;
    /* A bundle that has an info file whose text never arrived: the note still
       imports, but its created date silently becomes the day it landed, and a
       re-run will not fix that. Counting the file is what makes it visible. */
    if (note.info && infoText === undefined) {
      skips.push({ path: note.info, reason: "couldn't be read — created date not set" });
    }
    const dates = bearDates(infoText);
    /* The vault has no `updated` of its own, so Bear's is kept under Bear's
       name rather than dropped or written over a key the app owns. */
    if (dates.modified) props.push(["bear-modified", dates.modified]);
    /* Tags count as content: a note whose whole text was a title and a `#todo`
       is a note the user wrote, and dropping it as "empty" would be both a
       loss and a lie about why. */
    if (!body.trim() && !props.length && !tags.length) {
      skips.push({ path: note.path, reason: "empty note" });
      continue;
    }
    const attachments = bodyAssets(body, note.assets);
    for (const attachment of attachments) referenced.add(attachment.sourcePath);
    items.push({
      // the export folder's name and the note's path are the id: stable across
      // runs of the same folder, unique across exports, and readable in the
      // frontmatter as where the note came from
      importId: `${exportName}/${note.path}`,
      title,
      folder: tagFolder(tags[0]),
      body,
      props,
      created: dates.created,
      attachments,
    });
  }

  for (const note of scan.notes) {
    for (const path of note.assets.values()) {
      if (!referenced.has(path)) skips.push({ path, reason: "asset no imported note embeds" });
    }
  }

  return {
    items,
    skips,
    notes: [
      "Bear files by tag, so the first tag on a note becomes its folder, nested tags included; the rest become a tags property, and the tag text comes out of the body.",
      "Dates come from a text bundle's info.json where it has them — a plain markdown export carries none, so those notes are dated the day they land.",
      "Note identifiers, pinned state, and whether a note was archived are Bear's own and do not come across.",
      "A .bear2bk backup and a .textpack are zip files this import cannot open — unzip one and pick the folder inside.",
    ],
  };
}

/** Point a body's asset references at the vault's own embed form. A text
    bundle writes `![](assets/name.png)`, which is the form the Logseq adapter
    already rewrites — one implementation, so the two cannot drift. */
export { rewriteAssetRefs as bearRewriteAssets };
