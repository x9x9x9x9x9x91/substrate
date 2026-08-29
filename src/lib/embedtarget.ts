/** What an `![[…]]` target is allowed to say, stated once.
 *
 * The engine's resolver is the authority — `vault_relative_embed` in
 * `src-tauri/src/vault/assets.rs` decides what actually opens. This module is
 * the same grammar on the TypeScript side, and it exists because two callers
 * were quietly disagreeing with it:
 *
 * - the mock backend, which answered targets the engine refuses, so the whole
 *   browser lane (and every gate that rides it) stayed green over a break the
 *   packaged app would have shown on the first render;
 * - the missing-embed classifier, which read `Files/../Notes/x.pdf` as a file
 *   that is merely on another device. A target that cannot resolve anywhere is
 *   damage, and calling it "not on this device" sends the reader to go look on
 *   a device where it was never going to be either.
 *
 * Pure and dependency-free, so the mock can import it without dragging the IPC
 * layer in behind it.
 */

/** Trim a vault path to the shape everything here agrees on: `/`-separated,
 * no leading or trailing slash, no empty segments. Lives in this leaf module
 * rather than beside the sync config so the browse model can use it without
 * pulling the IPC layer in behind it. Re-exported from `syncfolders.ts`, which
 * is where the rest of the folder-list vocabulary lives. */
export function normalizeFolder(rel: string): string {
  return rel
    .split("/")
    .filter((s) => s.length > 0)
    .join("/");
}

/** A link-in-place target: absolute, or under the home directory. Points
 * outside the vault by construction, so no vault rule applies to it. */
export function isLinkInPlace(name: string): boolean {
  return /^(\/|~\/)/.test(name);
}

/** A bare `.assets/` name. No separator in either direction and no climb —
 * the engine refuses all three for this form. */
export function isVaultAssetName(name: string): boolean {
  return (
    !isLinkInPlace(name) && !name.includes("/") && !name.includes("\\") && !name.includes("..")
  );
}

/** A well-formed path inside the vault: `Files/Guides/setup.pdf`.
 *
 * Every segment must be non-empty and must not start with a dot. The empty
 * rule refuses `Files//x.pdf`; the dot rule does double duty, refusing `..`
 * (which is how a target would climb out) and refusing the vault's hidden
 * folders (`.vault/`, `.assets/`, `.trash/` have their own doors and are not
 * addressable from a note). A backslash is a separator in disguise on the
 * platform this format is read on, so it is refused outright. */
export function isVaultRelativeTarget(name: string): boolean {
  if (isLinkInPlace(name) || name.includes("\\") || !name.includes("/")) return false;
  const segments = name.split("/");
  return segments.length > 1 && segments.every((s) => s.length > 0 && !s.startsWith("."));
}

/** Whether the engine would resolve this target at all — the mock backend's
 * gate, so a fixture cannot answer what the packaged app refuses. A
 * link-in-place target is somebody else's question and passes through. */
export function embedTargetResolvable(name: string): boolean {
  return isLinkInPlace(name) || isVaultAssetName(name) || isVaultRelativeTarget(name);
}
