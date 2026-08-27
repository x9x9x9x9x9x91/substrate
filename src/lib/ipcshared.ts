/* Helpers both sides of the IPC boundary share — the transport shell
   (tauri.ts) and the mock backend (mockBackend.ts) import DOWN from here,
   never from each other: `rawInvoke` and the mock's module-scope
   initializers run at module-eval time, so a two-file split would be a
   real import cycle. The down-only rule binds VALUES; the `window.__mock*`
   types used here are ambient (mockBackend.ts's `declare global` applies
   program-wide), which is not an import edge. */
import type { MountScanStats } from "./types.ts";

export const isTauri = "__TAURI_INTERNALS__" in window;

/** The stem of a `.vault/templates/<type>.md` path, null for any other path —
    mirrors the engine's template_rel exception. */
export function templateStem(p: unknown): string | null {
  return /^\.vault\/templates\/([^/]+)\.md$/.exec(String(p ?? ""))?.[1] ?? null;
}

/* the engine never emits vault:changed from its commands — the OS
   watcher observes the write and, once the vault goes quiet for 300ms
   (vault.rs debounce), emits ONE vault:changed for the whole burst. With the
   flag on the mock mirrors that cadence: each completed note-mutating command
   (re)arms a 300ms timer and a quiet gap flushes a single echo, so a burst of
   writes coalesces exactly like the real watcher. Commands the watcher can't
   see never echo: template writes (templates live outside the
   watcher), trash purges/empties and asset writes (dot-paths), config writes
   (.vault/*.json ride vault:config-changed instead), history
   snapshots/purges (.git-internal).

   The four database/property bulk sweeps ARE watched: they rewrite
   ordinary vault notes through edit_props → write_atomic, so the OS watcher
   sees them exactly like any other note write. They classify with unnamed
   reach — a `BulkSweep` returns counts only, never the swept paths — the same
   honest answer a folder op gives, and it keeps a sweep's own echo from being
   read as somebody else's edit and flattening the undo stack. */
export const WATCHED_WRITE_COMMANDS = new Set([
  "vault_write_body",
  "vault_fm_write",
  "vault_set_prop",
  // a sheet column's notification setting is a frontmatter write like any
  // other prop edit
  "sheet_set_column_notify",
  // acting inside a tag folder writes the note's `tags:` prop like any other
  // prop edit, so the watcher sees it
  "vault_note_add_tags",
  "vault_seal_note",
  "vault_seal_scope",
  "vault_confirm_seal_scope",
  "vault_remove_seal_scope",
  "vault_unseal_note",
  "vault_create",
  "url_capture",
  "vault_rename",
  "vault_delete",
  "vault_delete_many",
  "vault_delete_folder",
  "vault_trash_restore",
  "vault_trash_restore_folder",
  "vault_move",
  "vault_create_folder",
  "vault_rename_folder",
  "mount_rescan",
  "mount_annotate",
  "history_restore",
  "vault_rename_type",
  "vault_delete_type",
  "vault_rename_prop",
  "vault_clear_prop",
]);
let mockEchoTimer: number | undefined;
let mockEchoPaths = new Set<string>();
/** a command in this burst had unnameable reach — the whole burst echoes with
    the engine's empty "unknown" payload rather than a half-named list */
let mockEchoUnknown = false;

/** Engine parity: the watcher's event names the rel paths
    that changed in the burst, deduped and sorted (`Engine::apply_changes`
    returns a BTreeSet's order). An empty vec is the engine's "I lost track and
    rescanned" — a command whose reach the mock can't name lands there too, by
    contributing no paths to a burst that still fires. */
export function scheduleMockEcho(paths: string[] | null) {
  if (paths === null) mockEchoUnknown = true;
  else for (const p of paths) mockEchoPaths.add(p);
  window.clearTimeout(mockEchoTimer);
  mockEchoTimer = window.setTimeout(() => {
    mockEchoTimer = undefined;
    const changed = mockEchoUnknown ? [] : [...mockEchoPaths].sort();
    mockEchoPaths = new Set();
    mockEchoUnknown = false;
    window.__mockEmit?.("vault:changed", changed);
  }, 300);
}

/** e2e opt-out hook (`__mockSetEchoOnWrites(false)`): a pending echo dies
    with the flag. Only the timer is cleared — the burst state stays, exactly
    like the pre-split clearTimeout did; the next scheduled write re-arms it. */
export function cancelMockEcho() {
  window.clearTimeout(mockEchoTimer);
}

/** The rel paths a completed command changed on disk, or `null` when its reach
    isn't nameable from the call (a folder op sweeps every note under it, a
    rescan touches whatever it stamped). Real and mock commands return the same
    shapes, so this serves both: the mock echoes these paths as its watcher
    event, and the app records them as its own write. `null` means
    "we wrote, can't say where", which is what the engine's own unknown-payload
    emit means too. */
export function writtenPathsFor(
  cmd: string,
  args: Record<string, unknown> | undefined,
  result: unknown
): string[] | null {
  const path = typeof args?.path === "string" ? args.path : undefined;
  const metaPath = (v: unknown): string | undefined => {
    const p = (v as { path?: unknown } | null)?.path;
    return typeof p === "string" ? p : undefined;
  };
  switch (cmd) {
    case "vault_write_body":
    case "vault_fm_write":
    case "vault_set_prop":
    case "vault_note_add_tags":
    case "sheet_set_column_notify":
      // set_prop returns { meta, prior }; the others return the meta itself
      return [path ?? metaPath((result as { meta?: unknown })?.meta ?? result)].filter(
        (p): p is string => !!p
      );
    case "vault_seal_note":
      return [path ?? metaPath((result as { meta?: unknown })?.meta)].filter(
        (p): p is string => !!p
      );
    case "vault_unseal_note":
      return [path ?? metaPath(result)].filter((p): p is string => !!p);
    case "vault_create":
    case "url_capture":
    case "history_restore":
      return [metaPath(result)].filter((p): p is string => !!p);
    case "vault_move":
      // the engine renames on disk and the watcher emits BOTH rels — name the
      // vacated path too, or its echo reads external and the move kills its
      // own undo entry
      return [path, metaPath(result)].filter((p): p is string => !!p);
    case "vault_rename": {
      // every note the link sweep rewrote, not just the renamed one
      // — plus the vacated path, which `touched` never names
      const touched = (result as { touched?: unknown })?.touched;
      const named = Array.isArray(touched)
        ? touched.filter((p): p is string => typeof p === "string")
        : [];
      return [path, ...named].filter((p): p is string => !!p);
    }
    case "vault_delete":
      // the file left this path; the watcher sees the removal there
      return path ? [path] : [];
    case "vault_delete_many": {
      // same removal, once per selected note. The result is one entry per
      // input path in order, so a partial failure names only what really
      // moved; the .trash/ destination is a dot-path the watcher ignores
      const asked = Array.isArray(args?.paths) ? (args.paths as unknown[]) : [];
      const per = Array.isArray(result) ? (result as { Ok?: unknown }[]) : [];
      return asked.filter(
        (p, i): p is string => typeof p === "string" && per[i]?.Ok !== undefined
      );
    }
    case "cookbook_install": {
      // every file the recipe wrote — post-rename paths, which is what the
      // watcher will see
      const written = (result as { files?: { path?: unknown }[] })?.files ?? [];
      return written.map((f) => f?.path).filter((p): p is string => typeof p === "string");
    }
    case "vault_trash_restore":
      return [metaPath(result)].filter((p): p is string => !!p);
    default:
      // vault_delete_folder, vault_trash_restore_folder, vault_create_folder,
      // vault_rename_folder, mount_rescan — whole-subtree reach.
      // vault_rename_type/_delete_type/_rename_prop/_clear_prop land here too
      // a `BulkSweep` result carries counts, not paths, so the
      // sweep's reach genuinely isn't nameable from the call.
      return null;
  }
}

/** Mirrors the engine: a mount rescan echoes only when the index actually
    moved (lib.rs emits vault:changed on real change, not per scan). */
export function mockRescanChanged(result: unknown): boolean {
  return (
    Array.isArray(result) &&
    result.some((s: MountScanStats) => s.added + s.updated + s.renamed + s.missing > 0)
  );
}
