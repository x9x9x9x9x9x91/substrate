/** What one level of the vault's heavy-binary folder holds — the arithmetic
 * behind the browse, with no DOM and no backend in it.
 *
 * Two sources, and the whole point of the surface is that they disagree. What
 * is on THIS disk comes from a folder listing; what the vault REMEMBERS is in
 * an index some other device wrote, where the files actually are. A device
 * that keeps this folder off sync has the second and not the first, and the
 * honest rendering of that is a row that is there, greyed, saying it is not
 * here — not an empty folder, which would read as "there is nothing", and not
 * a broken link, which would read as damage.
 *
 * So every row carries `here`, and a row that is remembered AND present is one
 * row: the disk wins on every fact it can answer, because a size the index
 * recorded a week ago is a claim about a week ago.
 */

import { fileExt, type FileKind } from "./folderfiles.ts";
import { isImageName, AUDIO_EXT_RE } from "./artwork.ts";
import { normalizeFolder } from "./embedtarget.ts";
import type { GhostIndex } from "./syncfolders.ts";
import type { FolderFile } from "./types.ts";

/** One row in the browse — a folder or a file, present or remembered. */
export interface FileRow {
  /** vault-relative path, `/`-separated: the row's identity and its sort key */
  rel: string;
  name: string;
  dir: boolean;
  /** false for a row that only the index knows about: it is listed, greyed,
      and offers nothing that would need the bytes */
  here: boolean;
  /** absolute path, for the OS open and reveal — only a row that is here */
  path?: string;
  size: number;
  mtimeMs: number;
  kind: FileKind;
  ext: string | null;
}

/** One remembered file, lifted out of the index into the vault-relative path
 * the rest of the browse speaks. */
export interface IndexedAt {
  rel: string;
  size: number;
  mtime: number;
}

/** The folder one level up; `""` at `Files/` itself. */
export function parentOf(prefix: string): string {
  const parts = prefix.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

/** The vault-relative path of a browse position: `""` means `Files/` itself. */
export function browsePath(root: string, prefix: string): string {
  return prefix ? `${root}/${prefix}` : root;
}

function kindOf(name: string): FileKind {
  if (AUDIO_EXT_RE.test(name)) return "audio";
  if (isImageName(name)) return "image";
  return "other";
}

/** Whether a row is a document the app can draw pages of. */
export function isPreviewable(row: FileRow): boolean {
  return row.here && row.ext === "PDF";
}

/** Direct children of `path` among a flat list of every folder in the vault.
 * The engine's folder walk lists real directories whether or not they hold
 * notes, which is what makes a folder of nothing but PDFs visible here. */
export function childFolders(folders: readonly string[], path: string): string[] {
  const prefix = path ? `${path}/` : "";
  const out = new Set<string>();
  for (const folder of folders) {
    if (!folder.startsWith(prefix)) continue;
    const rest = folder.slice(prefix.length);
    if (!rest || rest.includes("/")) continue;
    out.add(folder);
  }
  return [...out];
}

/** What the index remembers, as vault-relative paths.
 *
 * The file is keyed by the excluded folder's own path and each entry inside it
 * is relative to THAT folder, not to the vault — `folders["Files"]` holding
 * `"Guides/x.pdf"` means the vault's `Files/Guides/x.pdf`. The browse works in
 * vault-relative paths throughout, so joining is the first thing that happens
 * to the index and the only place the two conventions meet. */
export function indexedFiles(index: GhostIndex | null): IndexedAt[] {
  const out: IndexedAt[] = [];
  for (const [rawFolder, record] of Object.entries(index?.folders ?? {})) {
    // the key is hand-editable, so `Files/`, `/Files` and `Files` all mean the
    // same folder. Joined raw they mean three different ones, and the two with
    // a stray slash match no browse path — every row under them would vanish
    // with nothing to say it had
    const folder = normalizeFolder(rawFolder);
    if (!folder) continue;
    for (const entry of record?.entries ?? []) {
      const rel = entry?.path ?? "";
      // an entry that climbs out of its own folder is not this vault's row
      if (!rel || rel.startsWith("/") || rel.split("/").some((s) => !s || s === "." || s === ".."))
        continue;
      out.push({ rel: `${folder}/${rel}`, size: entry.size, mtime: entry.mtime });
    }
  }
  return out;
}

/** Folders under `path` that only the index remembers — a subfolder that
 * exists on the device holding the files and nowhere on this one. */
export function ghostFolders(
  index: GhostIndex | null,
  path: string,
  present: readonly string[]
): string[] {
  if (!index) return [];
  const prefix = path ? `${path}/` : "";
  const here = new Set(present);
  const out = new Set<string>();
  for (const { rel } of indexedFiles(index)) {
    if (!rel.startsWith(prefix)) continue;
    const rest = rel.slice(prefix.length);
    // a remembered file three levels down still puts its top level here; a
    // file sitting directly at this level is a row, not a folder
    if (!rest.includes("/")) continue;
    const child = `${prefix}${rest.split("/")[0]}`;
    if (!here.has(child)) out.add(child);
  }
  return [...out];
}

/** Every row at one level, folders first and then files, each half sorted by
 * name the way a folder listing reads — case-insensitively, since a browse
 * that files every capital ahead of every lowercase looks shuffled.
 *
 * `files` is what the disk has here; `index` is what the vault remembers of
 * every folder. A remembered file the disk also has is dropped in favour of
 * the disk's row, so nothing is listed twice and no stale size is shown next
 * to a file you could open right now. */
export function browseRows(
  path: string,
  folders: readonly string[],
  files: readonly FolderFile[],
  index: GhostIndex | null
): FileRow[] {
  const presentFolders = childFolders(folders, path);
  const folderRows: FileRow[] = presentFolders.map((rel) => ({
    rel,
    name: rel.slice(rel.lastIndexOf("/") + 1),
    dir: true,
    here: true,
    size: 0,
    mtimeMs: 0,
    kind: "other",
    ext: null,
  }));
  for (const rel of ghostFolders(index, path, presentFolders)) {
    folderRows.push({
      rel,
      name: rel.slice(rel.lastIndexOf("/") + 1),
      dir: true,
      here: false,
      size: 0,
      mtimeMs: 0,
      kind: "other",
      ext: null,
    });
  }

  const fileRows: FileRow[] = files.map((f) => ({
    rel: f.rel,
    name: f.name,
    dir: false,
    here: true,
    path: f.path,
    size: f.size,
    mtimeMs: f.mtime_ms,
    kind: kindOf(f.name),
    ext: fileExt(f.name),
  }));
  const here = new Set(fileRows.map((r) => r.rel));
  const prefix = path ? `${path}/` : "";
  for (const entry of indexedFiles(index)) {
    if (here.has(entry.rel)) continue;
    // a remembered file deeper than this level belongs to a folder row, not
    // to this listing
    if (!entry.rel.startsWith(prefix)) continue;
    const name = entry.rel.slice(prefix.length);
    if (!name || name.includes("/")) continue;
    fileRows.push({
      rel: entry.rel,
      name,
      dir: false,
      here: false,
      size: entry.size,
      mtimeMs: entry.mtime,
      kind: kindOf(name),
      ext: fileExt(name),
    });
  }

  const byName = (a: FileRow, b: FileRow) => {
    const [al, bl] = [a.name.toLowerCase(), b.name.toLowerCase()];
    return al < bl ? -1 : al > bl ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };
  return [...folderRows.sort(byName), ...fileRows.sort(byName)];
}

/** Narrow one level by a typed filter, folders kept ahead of files the way
 * `browseRows` ordered them. The filter narrows THIS folder only. */
export function filterRows(rows: readonly FileRow[], query: string): FileRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}

/** Whether the surface has anything at all to show — the folder exists on
 * disk, or the vault remembers something in it. Below this the pane says how
 * to make one rather than rendering an empty browse. */
export function filesSurfaceExists(
  root: string,
  folders: readonly string[],
  index: GhostIndex | null
): boolean {
  if (folders.includes(root)) return true;
  const prefix = `${root}/`;
  // a record for the folder counts even when it lists nothing: the vault
  // remembers the folder, it is simply empty where it lives
  const keys = Object.keys(index?.folders ?? {});
  if (keys.some((f) => f === root || f.startsWith(prefix))) return true;
  return indexedFiles(index).some((e) => e.rel.startsWith(prefix));
}
