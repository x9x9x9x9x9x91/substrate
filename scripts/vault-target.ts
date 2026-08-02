/**
 * Shared vault targeting and write rules for the offline importers (SUB-777).
 * The import/backfill scripts write into a vault directly, so a silent default
 * would point a live run at the user's real ~/Vault, and a plain writeFile can
 * strand a half-written note that a dedupe pass then skips forever.
 */

import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The vault an importer writes into. There is no default: an unset target
    would silently mean the real vault, and these scripts write user content,
    so the target is always named explicitly. `vaultEnv` is the in-process
    override (tests pass a temp dir); otherwise VAULT_DIR must be set. */
export function resolveVault(vaultEnv?: string): string {
  const vault = vaultEnv ?? process.env.VAULT_DIR;
  if (!vault) {
    throw new Error(
      "VAULT_DIR is not set — set it explicitly (an unset target would write into the real ~/Vault)",
    );
  }
  return vault;
}

let tmpSeq = 0;

/** Write via a temp file in the same directory, then rename: a crash leaves
    either the old file or the new one, never a truncated note. Same-dir keeps
    the rename atomic — /tmp may be a different filesystem. The dot-stem name
    keeps the temp out of the scripts' own `.md` scans while it exists. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${process.pid}-${tmpSeq++}.tmp`);
  await writeFile(tmp, content);
  await rename(tmp, path);
}
