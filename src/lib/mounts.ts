import { formatFileSize } from "./display.ts";
import type { MountInfo, MountRow, MountScanStats, NoteMeta } from "./types.ts";

/** Virtual path prefix for a mount row that has no sidecar note yet. It is
    not a vault path and never reaches the engine as one — the row pipeline is
    path-keyed (selection, focus, React keys), so an un-annotated row still
    needs something unique to be keyed by. */
export const MOUNT_SCHEME = "mount://";

/** The mount id and relative file path inside a virtual row path, or null for
    an ordinary vault path. Anything that opens a note has to ask, because a
    mount board mixes real sidecar notes and virtual rows in one list. */
export function parseMountPath(path: string): { id: string; rel: string } | null {
  if (!path.startsWith(MOUNT_SCHEME)) return null;
  const rest = path.slice(MOUNT_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { id: rest.slice(0, slash), rel: rest.slice(slash + 1) };
}

/** Props the engine owns on a sidecar: the binding keys plus the intrinsics
    the index carries. Never shown as user props — the row supplies them.

    Matched case-insensitively, like every other read of a hand-authored key:
    a sidecar written by hand can spell one `Type:` or `Mount:`, and an
    exact-case test lets that spelling through as a user column beside the
    row's own. The names are lowercase here, so `isOwned` folds the candidate. */
const OWNED = new Set(["mount", "mount_file", "mount_identity", "type"]);

const isOwned = (prop: string): boolean => OWNED.has(prop.toLowerCase());

/** One mount row as the note pipeline wants it.
 *
 * A row with a sidecar carries the sidecar's REAL vault path, so opening it,
 * renaming it or trashing it all route to the note that exists. A row without
 * one carries a `mount://` path: no note has been created, because nothing
 * has been said about the file yet.
 *
 * Intrinsic columns (name, extension, size, created, modified, missing) are
 * merged UNDER the sidecar's props, so a user prop named `size` wins on its
 * own row rather than being silently overwritten by the file's.
 */
export function rowMeta(mount: MountInfo, row: MountRow): NoteMeta {
  const path = row.note ?? `${MOUNT_SCHEME}${mount.id}/${row.rel}`;
  const slash = path.lastIndexOf("/");
  const stem = row.note ? path.slice(slash + 1).replace(/\.md$/, "") : row.name;
  return {
    path,
    stem,
    title: row.name,
    folder: row.note ? path.slice(0, Math.max(0, slash)) : "",
    props: {
      type: mount.name,
      name: row.name,
      extension: row.extension,
      size: row.size,
      created: row.created,
      modified: row.modified,
      ...(row.missing ? { missing: "true" } : {}),
      ...Object.fromEntries(Object.entries(row.props).filter(([k]) => !isOwned(k))),
    },
    // the file's own mtime, so sorting by "updated" sorts by the reality the
    // mount reflects rather than by when someone last annotated it
    updated_ms: Date.parse(row.modified.replace(" ", "T")) || 0,
    // the opening of the document itself, where this machine has read
    // one — the same one line a note shows, and the same string the
    // board's own filter matches on, so typing a phrase from inside a paper
    // narrows to it. A reading that stopped at its cap still starts at the
    // start, so the first line is never the misleading part; where the cut
    // matters is a search of the body, and that is what `partial` marks on
    // the hit itself.
    excerpt: row.excerpt ?? "",
    // a mount row projects a file living OUTSIDE the vault; sealing is a vault
    // note's property, and nothing here has one
    sealed: false,
  };
}

export function rowMetas(mount: MountInfo, rows: MountRow[]): NoteMeta[] {
  return rows.map((r) => rowMeta(mount, r));
}

/** The list identity of a search hit that landed inside a mounted document's
 * text.
 *
 * A mount row has no note until someone annotates it, so a hit on a
 * `mount://` path has nothing in the loaded note set to join against — and
 * a result pane that joins is a pane that silently drops the hit. This
 * rebuilds the little a result row needs from the hit itself plus the mount
 * the path names: the file's name as its title, the mount's name as its type
 * badge.
 *
 * `null` for an ordinary vault path (join it normally) and for a mount id this
 * machine has no mount for — a row that can't be named can't be opened either.
 *
 * `updated_ms` is 0 because a hit carries no mtime: sorting results by Updated
 * therefore sinks mount rows below every note. The board itself sorts by the
 * file's own mtime; only this projection is blind to it.
 */
export function searchHitMeta(
  path: string,
  title: string,
  mounts: MountInfo[]
): NoteMeta | null {
  const parsed = parseMountPath(path);
  if (!parsed) return null;
  const mount = mounts.find((m) => m.id === parsed.id);
  if (!mount) return null;
  const name = title || parsed.rel.slice(parsed.rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return {
    path,
    stem: name,
    title: name,
    folder: "",
    props: {
      type: mount.name,
      name,
      ...(dot > 0 ? { extension: name.slice(dot + 1) } : {}),
    },
    updated_ms: 0,
    excerpt: "",
    // the file lives outside the vault; sealing is a vault note's property
    sealed: false,
  };
}

/** Row class suffix for a mount row whose file isn't in the folder any more.
    Every layout composes it the same way it composes selection and open, so a
    missing file greys out wherever the mount is being looked at. Ordinary
    notes never carry `missing`, so this is inert off a mount board. */
export function missingCls(n: { props: Record<string, unknown> }): string {
  return n.props.missing ? " is-missing" : "";
}

/** The intrinsic columns every mount has, in board order. They are read-only:
    they describe the file, and the file is the source of truth. */
export const MOUNT_INTRINSICS = ["name", "extension", "size", "created", "modified"] as const;

/** Columns read out of the files themselves — duration for audio,
    page count for PDFs, tags where a file carries them. They appear on a row
    only once that file has been read, so a board fills these in behind a
    scan rather than with it. Read-only for the same reason the intrinsics
    are: the file says what it says, and the next extraction would overwrite
    anything typed over it. Mirrors `EXTRACTED_COLUMNS` in
    `src-tauri/src/vault/extract.rs`.

    A file's internal title is `media_title`: `title` is the row's own heading
    everywhere in the note pipeline, and `dbColumns` drops that name outright,
    so a column called `title` would be extracted and then never shown.

    An Ableton project's columns are prefixed `als_` for a neighbouring
    reason: a folder of music work holds the sessions and the stems they
    bounced to, and a bare `tempo` column filled from two unrelated readers
    would read as one fact about both. */
export const MOUNT_EXTRACTED = [
  "duration",
  "sample_rate",
  "channels",
  "artist",
  "album",
  "media_title",
  "pages",
  "als_tempo",
  "als_key",
  "als_tracks",
  "als_version",
] as const;

/** Whether a column belongs to the file rather than to whoever is annotating
    it — the read-only test the board's cell editor asks before allowing a
    write.

    Folded, because the name being tested comes from a hand-authored sidecar
    or a typed column heading, where casing carries no meaning: an exact-case
    test lets `Size` or `Duration` through, and the value then either shadows
    the file's own column on that row or is overwritten by the next
    extraction. Both lists above are lowercase by construction, so folding the
    candidate is the whole comparison — the same rule the engine's write guard
    already applies to the extracted names. */
export function isIntrinsic(prop: string): boolean {
  const folded = prop.toLowerCase();
  return (
    (MOUNT_INTRINSICS as readonly string[]).includes(folded) ||
    (MOUNT_EXTRACTED as readonly string[]).includes(folded) ||
    folded === "missing"
  );
}

/** How a mount's state reads in the board banner. `null` = nothing to say,
    which is the healthy bound case. */
export function mountStatus(m: MountInfo): string | null {
  if (!m.path) {
    return `“${m.name}” isn’t connected to a folder on this machine — showing the last known contents.`;
  }
  if (m.missing) {
    return `“${m.name}” points at ${m.path}, which isn’t here right now — showing the last known contents.`;
  }
  return null;
}

/** A mount's line in the All-databases list: how many files, and where they
    actually are. The path is the point — it is the one thing about a mount
    that differs per machine, so it is never hidden behind the name. */
export function mountSubtitle(m: MountInfo): string {
  const files = `${m.files} ${m.files === 1 ? "file" : "files"}`;
  if (!m.path) return `${files} · not on this machine`;
  return `${files} · ${m.path}${m.missing ? " (not found)" : ""}`;
}

/** One-line toast summary of a rescan, the palette's "Rescan folders". */
export function scanSummary(stats: MountScanStats[]): string {
  if (stats.length === 0) return "No mounted folders on this machine";
  const sum = (k: "added" | "updated" | "renamed" | "missing") =>
    stats.reduce((n, s) => n + (s.error ? 0 : s[k]), 0);
  const parts: string[] = [];
  const added = sum("added");
  const updated = sum("updated");
  const renamed = sum("renamed");
  const missing = sum("missing");
  if (added) parts.push(`${added} new`);
  if (updated) parts.push(`${updated} updated`);
  if (renamed) parts.push(`${renamed} moved`);
  if (missing) parts.push(`${missing} missing`);
  let base = parts.length ? `Mounts: ${parts.join(" · ")}` : "Mounts: everything up to date";
  const bad = stats.filter((s) => s.error).length;
  if (bad) base += ` · ${bad} folder${bad === 1 ? "" : "s"} unreadable`;
  return base;
}

/** One mount's scan outcome inline — the "Mount a folder…" dialog's result. */
export function scanStatLine(s: MountScanStats): string {
  if (s.error) return s.error;
  return `${s.scanned} ${s.scanned === 1 ? "file" : "files"}, ${s.added} new, ${s.updated} updated, ${s.missing} missing`;
}

/** The size column's display value — bytes are unreadable at sample-library
    scale, and a missing file has no size worth showing. */
export function sizeLabel(row: MountRow): string {
  if (row.missing && row.size === 0) return "";
  return formatFileSize(row.size);
}
