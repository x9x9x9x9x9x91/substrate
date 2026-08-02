import { vaultSyncStatus } from "./ipc.ts";

/** Why an embed has no file behind it (SUB-444).
 *
 * `broken` — the target is genuinely gone: deleted, renamed, or a
 * link-in-place path that no longer resolves.
 *
 * `unsynced` — the target is a bare `.assets/` name on a vault that syncs.
 * Vault sync deliberately excludes `.assets/` and `.trash/` from the git
 * transport (`src-tauri/src/gitsync.rs:233-236`), so notes travel between
 * devices while their binaries stay put. A phone that pulled the vault will
 * see every audio/image/file embed as absent — that is the design working,
 * not damage, and it must not read like a broken link. */
export type MissingEmbedKind = "broken" | "unsynced";

/** Link-in-place embeds (`/…`, `~/…`) point outside `.assets/` and were never
 * covered by the sync exclusion, so a missing one is always genuinely broken. */
function isVaultAssetName(name: string): boolean {
  return !/^(\/|~\/)/.test(name);
}

/** Pure classifier — the piece worth testing. `syncConfigured` comes from
 * `vault_sync_status`; on a vault with no remote there is nothing that could
 * have failed to arrive, so everything missing is broken. */
export function classifyMissingEmbed(name: string, syncConfigured: boolean): MissingEmbedKind {
  return syncConfigured && isVaultAssetName(name) ? "unsynced" : "broken";
}

let configured: Promise<boolean> | undefined;

/** Cached `vault_sync_status().configured`. Read once per session — the
 * status only changes when the user saves a remote, which calls
 * `resetSyncConfigured()`. Never rejects: an unavailable status degrades to
 * "no sync", i.e. the pre-SUB-444 broken-embed behaviour. */
export function syncConfigured(): Promise<boolean> {
  if (!configured) {
    configured = vaultSyncStatus().then(
      (s) => s.configured,
      () => false
    );
  }
  return configured;
}

/** Drop the cached status — called after a remote is saved so existing
 * missing embeds reclassify without a reload. */
export function resetSyncConfigured() {
  configured = undefined;
}

/** The kind to render for a missing embed, resolved against live sync state. */
export function missingEmbedKind(name: string): Promise<MissingEmbedKind> {
  return syncConfigured().then((ok) => classifyMissingEmbed(name, ok));
}

/** Placeholder text. Matches the existing `missing <noun> · <name>` idiom so
 * the two states read as one family, quiet and lowercase. */
export function missingEmbedLabel(kind: MissingEmbedKind, noun: string, name: string): string {
  return kind === "unsynced" ? `not on this device · ${name}` : `missing ${noun} · ${name}`;
}
