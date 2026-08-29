import { isVaultAssetName, isVaultRelativeTarget } from "./embedtarget.ts";
import { vaultSyncStatus } from "./ipc.ts";
import { excludedFolders, isExcludedPath } from "./syncexclusion.ts";

/** Why an embed has no file behind it.
 *
 * `broken` — the target is genuinely gone: deleted, renamed, or a
 * link-in-place path that no longer resolves.
 *
 * `unsynced` — the file stayed on the device that has it, by design. Two
 * targets can be in that state. A bare `.assets/` name is one: vault sync
 * deliberately excludes `.assets/` and `.trash/` from the git transport
 * (`src-tauri/src/gitsync.rs:233-236`), so notes travel between devices while
 * their binaries stay put. A vault-relative target inside a folder this vault
 * leaves off the sync leg is the other, and is the same story one folder out —
 * a note showing a heavy file that lives in a folder chosen not to travel.
 * Either way a phone that pulled the vault sees the embed as absent, and that
 * is the design working, not damage: it must not read like a broken link. */
export type MissingEmbedKind = "broken" | "unsynced";

/** Pure classifier — the piece worth testing. `syncConfigured` comes from
 * `vault_sync_status`; on a vault with no remote there is nothing that could
 * have failed to arrive, so everything missing is broken. `exclude` is the
 * folder list from `.vault/sync-folders.json`, and it only decides the
 * vault-relative case: a path in a folder that travels is missing because it
 * is missing.
 *
 * A link-in-place target is broken whatever the config says — it names a file
 * outside the vault, which no exclusion has anything to do with. So is a
 * target the vault's grammar refuses: `Files/../Notes/x.pdf` is inside the
 * excluded folder by naive prefix and nowhere at all by the rules that decide
 * what opens, and "not on this device" would be a promise no device can keep. */
export function classifyMissingEmbed(
  name: string,
  syncConfigured: boolean,
  exclude: readonly string[] = []
): MissingEmbedKind {
  if (!syncConfigured) return "broken";
  if (isVaultAssetName(name)) return "unsynced";
  if (isVaultRelativeTarget(name) && isExcludedPath(name, exclude)) return "unsynced";
  return "broken";
}

let configured: Promise<boolean> | undefined;
const listeners = new Set<() => void>();

/** Cached `vault_sync_status().configured`. Read once per session — the
 * status only changes when the user saves a remote, which calls
 * `resetSyncConfigured()`. Never rejects: an unavailable status degrades to
 * "no sync", i.e. the pre-change broken-embed behaviour. */
export function syncConfigured(): Promise<boolean> {
  if (!configured) {
    configured = vaultSyncStatus().then(
      (s) => s.configured,
      () => false
    );
  }
  return configured;
}

/** Hear about every `resetSyncConfigured()`. The cache drop is the one moment
 * the app knows the remote may have changed under it, so anything holding its
 * own copy of the answer — `useAutoSync`'s arming gate — re-reads here rather
 * than waiting for a reload. Returns the unsubscribe. */
export function subscribeSyncConfigured(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Drop the cached status — called after a remote is saved so existing
 * missing embeds reclassify without a reload, and so the auto-sync lane arms
 * against the remote that just landed. */
export function resetSyncConfigured() {
  configured = undefined;
  for (const fn of listeners) fn();
}

/** The kind to render for a missing embed, resolved against live sync state
 * and the vault's excluded folders. Both reads are cached per session and
 * neither rejects, so this settles on every vault. */
export function missingEmbedKind(name: string): Promise<MissingEmbedKind> {
  return Promise.all([syncConfigured(), excludedFolders()]).then(([ok, exclude]) =>
    classifyMissingEmbed(name, ok, exclude)
  );
}

/** Placeholder text. Matches the existing `missing <noun> · <name>` idiom so
 * the two states read as one family, quiet and lowercase. */
export function missingEmbedLabel(kind: MissingEmbedKind, noun: string, name: string): string {
  return kind === "unsynced" ? `not on this device · ${name}` : `missing ${noun} · ${name}`;
}

/** Why the file isn't here, for the hover. The placeholder is one sentence
 * either way — only the reason differs, because the two absences have
 * different remedies: nothing configures the `.assets/` exclusion, while a
 * folder left off the sync leg is a choice someone made and can unmake. */
export function unsyncedEmbedReason(name: string): string {
  return name.includes("/")
    ? "This file lives in a folder this vault keeps off sync — it stays on the device that holds it."
    : "This vault syncs notes only — assets stay on the device that made them.";
}
