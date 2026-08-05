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
    the index carries. Never shown as user props — the row supplies them. */
const OWNED = new Set(["mount", "mount_file", "mount_identity", "type"]);

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
      ...Object.fromEntries(Object.entries(row.props).filter(([k]) => !OWNED.has(k))),
    },
    // the file's own mtime, so sorting by "updated" sorts by the reality the
    // mount reflects rather than by when someone last annotated it
    updated_ms: Date.parse(row.modified.replace(" ", "T")) || 0,
    excerpt: "",
    // a mount row projects a file living OUTSIDE the vault; sealing is a vault
    // note's property, and nothing here has one
    sealed: false,
  };
}

export function rowMetas(mount: MountInfo, rows: MountRow[]): NoteMeta[] {
  return rows.map((r) => rowMeta(mount, r));
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

/** Columns read out of the files themselves (SUB-887) — duration for audio,
    page count for PDFs, tags where a file carries them. They appear on a row
    only once that file has been read, so a board fills these in behind a
    scan rather than with it. Read-only for the same reason the intrinsics
    are: the file says what it says, and the next extraction would overwrite
    anything typed over it. Mirrors `EXTRACTED_COLUMNS` in
    `src-tauri/src/vault/extract.rs`.

    A file's internal title is `media_title`: `title` is the row's own heading
    everywhere in the note pipeline, and `dbColumns` drops that name outright,
    so a column called `title` would be extracted and then never shown. */
export const MOUNT_EXTRACTED = [
  "duration",
  "sample_rate",
  "channels",
  "artist",
  "album",
  "media_title",
  "pages",
] as const;

export function isIntrinsic(prop: string): boolean {
  return (
    (MOUNT_INTRINSICS as readonly string[]).includes(prop) ||
    (MOUNT_EXTRACTED as readonly string[]).includes(prop) ||
    prop === "missing"
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
