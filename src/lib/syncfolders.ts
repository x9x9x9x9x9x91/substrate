/* No-sync folders — the frontend's view of which vault folders stay off sync.

   Types plus the two pure helpers the settings panel needs. Rust owns the
   decision entirely: the config file, the ownership of `.git/info/exclude`, and
   the weighing that decides whether a folder is allowed back INTO sync. These
   shapes mirror `commands::syncfolders`.

   The direction that matters: excluding a folder is free, letting one back in
   is not. Every object the sync transport carries is uploaded whole, so a
   single file past the ceiling fails the push it rides in — which is why an
   include comes back refused, with the offending files named, rather than
   quietly half-working. */

/** One folder as the panel lists it. `knownFiles`/`knownUpdated` come from the
    ghost index — the answer of whichever device actually has the folder — so a
    machine without it can still say how much is over there. */
export type SyncFolder = {
  path: string;
  excluded: boolean;
  onDisk: boolean;
  knownFiles: number;
  knownUpdated: number;
  knownCapped: boolean;
};

/** A file standing between a folder and going back into sync. */
export type OversizeFile = { path: string; size: number };

/** What weighing a folder found. Present on every include attempt, refused or
    not, so the panel can warn about a large-but-allowed one. */
export type IncludeScan = {
  files: number;
  totalBytes: number;
  oversize: OversizeFile[];
  /** Files whose size could not be read at all. These refuse the include too:
      a file the scan cannot measure is not a file it can call small enough,
      and reading "no answer" as zero bytes is how an oversize file walks past
      a size check. */
  unreadable: string[];
  limitBytes: number;
};

/** The result of a toggle. `applied: false` is a refusal, not an error —
    nothing went wrong, the folder is simply too heavy — and `scan.oversize`
    names why. */
export type SyncFolderToggle = { applied: boolean; scan: IncludeScan | null };

/** One file inside an excluded folder, as the devices that do not hold it see
    it. `path` is relative to the FOLDER, not to the vault; `mtime` is Unix
    milliseconds, `0` where the platform wouldn't say. */
export type GhostEntry = { path: string; size: number; mtime: number };

/** What one excluded folder holds, as the device that holds it last reported.
    `capped` means the listing stopped at the engine's per-folder limit and the
    count is a floor. */
export type GhostFolder = {
  updated: number;
  entries: GhostEntry[];
  capped?: boolean;
};

/** `.vault/files-index.json` — every excluded folder any device has looked at,
    keyed by vault-relative folder path. This is what lets a surface show the
    files of a folder this device does not have. */
export type GhostIndex = { version: number; folders: Record<string, GhostFolder> };

/** Bytes as a person reads them. Deliberately coarse: this labels a warning
    about whether something is worth uploading, not a file manager. */
export function howBig(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Above this an include is worth a sentence before it happens: it is allowed,
    but it is the difference between a sync that finishes and one that runs all
    evening. */
const LOUD_INCLUDE_BYTES = 1024 * 1024 * 1024;

/** What to say under a folder's name. One line, and it answers the question the
    row actually raises: excluded rows say where the files are, syncing rows say
    nothing unless there is something to warn about. */
export function folderSummary(folder: SyncFolder): string {
  if (!folder.excluded) {
    return folder.onDisk ? "Syncs to your other devices" : "Not on this device";
  }
  // A folder that is neither here nor described by any other device is one
  // nobody has put anything in yet — saying "other devices keep their copies"
  // about it would be claiming copies that do not exist.
  if (!folder.onDisk && folder.knownFiles === 0) return "Doesn't sync — nothing here yet";
  const where = folder.onDisk
    ? "Stays on this device"
    : "Not on this device — other devices keep their copies";
  if (folder.knownFiles === 0) return where;
  const count = `${folder.knownCapped ? "over " : ""}${folder.knownFiles} file${
    folder.knownFiles === 1 ? "" : "s"
  }`;
  return `${where} · ${count} known`;
}

/** The warning for an include that was allowed but is large enough to be worth
    knowing about, or null when there is nothing to say. */
export function includeWarning(scan: IncludeScan | null): string | null {
  if (!scan || scan.totalBytes < LOUD_INCLUDE_BYTES) return null;
  return `${howBig(scan.totalBytes)} across ${scan.files} file${
    scan.files === 1 ? "" : "s"
  } will now upload — the next sync will take a while.`;
}

/* The path trim itself lives in the leaf grammar module, so a pure browse model
   can normalize a folder path without importing the IPC layer. It is named here
   because this is where the folder-list vocabulary reads. */
export { normalizeFolder } from "./embedtarget.ts";
