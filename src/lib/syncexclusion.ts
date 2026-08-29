/** Which vault folders stay on the device that holds them, as the missing-embed
 * classifier needs to ask it.
 *
 * A folder can be left off the sync leg so the notes that travel don't drag
 * every heavy binary with them. That makes "the file isn't here" an ordinary,
 * designed state rather than damage — but only for a target inside one of
 * those folders, which is the question this module answers.
 *
 * Rust owns the decision; `syncfolders.ts` holds the shapes and the settings
 * panel's display helpers. This is only the reader the rest of the app asks,
 * kept apart from both so a pure browse model can normalize a path without
 * pulling the IPC layer in behind it.
 *
 * ONE HONEST LIMIT. The list comes from `sync_folders_list`, which enumerates
 * the vault's top-level folders plus any excluded folder the ghost index has
 * heard of — not the config file verbatim. So a folder that is excluded in the
 * config, is nested rather than top-level, and no device has indexed yet is not
 * in this answer, and a missing embed under it classifies as broken rather than
 * as left behind. That window closes as soon as any device with the folder
 * writes the index, which is the same moment the surface has anything to show
 * for it. It is the conservative direction — damage reported for a designed
 * absence, never the reverse — and it is worth the single reader: two readers
 * of one config is how the two halves of a feature drift apart.
 */

import { syncFoldersList } from "./ipc.ts";
import { normalizeFolder } from "./embedtarget.ts";
import { onVaultLeft } from "./vaultcaches.ts";

/** Whether a vault-relative path sits inside one of `exclude` — the folder
 * itself counts, and so does everything under it. A prefix that is not a
 * folder boundary does not: `Filesystem/x.pdf` is not inside `Files`.
 *
 * Case-SENSITIVE, while macOS resolves `files/x.pdf` to a folder named
 * `Files`. So on a case-insensitive disk `![[files/x.pdf]]` opens and, if it
 * ever goes missing, reads as broken rather than as left behind. Conservative
 * in the same direction as the limit above, and it stays until the engine and
 * this agree on one folding.
 *
 * Pure, so the interesting half is testable without a backend. */
export function isExcludedPath(rel: string, exclude: readonly string[]): boolean {
  const path = normalizeFolder(rel);
  return exclude.some((raw) => {
    const folder = normalizeFolder(raw);
    return folder.length > 0 && (path === folder || path.startsWith(`${folder}/`));
  });
}

let cached: Promise<readonly string[]> | undefined;

/** The excluded folders, read once per session. The list changes when the user
 * moves the switch in settings or a sync pass rewrites the config —
 * `resetSyncExclusions()` drops the cache. Never rejects: a read that fails
 * degrades to "nothing is excluded", which classifies a missing embed as
 * damage rather than quietly reassuring somebody about a file that is gone. */
export function excludedFolders(): Promise<readonly string[]> {
  if (!cached) {
    cached = syncFoldersList().then(
      (folders) => folders.filter((f) => f.excluded).map((f) => f.path),
      () => []
    );
  }
  return cached;
}

/** Drop the cached list — after a vault switch, or after anything rewrites the
 * config, so the next missing embed is classified against what is there now. */
export function resetSyncExclusions() {
  cached = undefined;
}

/* Another vault's config is not this one's, and the list decides whether a
   missing file reads as damage — a stale answer here mislabels every embed in
   the new vault until something else happens to drop it. */
onVaultLeft(resetSyncExclusions);

/** Whether this vault leaves the folder holding `rel` behind, resolved against
 * the live config. */
export function pathIsSyncExcluded(rel: string): Promise<boolean> {
  return excludedFolders().then((exclude) => isExcludedPath(rel, exclude));
}
