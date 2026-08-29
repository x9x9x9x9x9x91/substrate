/* The IPC transport shell: the real Tauri bridge on one side, the mock
   backend (mockBackend.ts) on the other, picked once by `isTauri`. The
   typed facade over `invoke` lives in ipc.ts; the both-sides helpers live
   in ipcshared.ts. */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { noteIndexWrite, noteOwnWrite } from "./ownwrites.ts";
import {
  INDEX_WRITE_COMMANDS,
  isTauri,
  templateStem,
  WATCHED_WRITE_COMMANDS,
  writtenPathsFor,
} from "./ipcshared.ts";
/* Module-scope import ON PURPOSE, beyond the two names: loading the shell
   must evaluate the mock backend's side effects (the window.__mock* e2e
   surface) whenever the app runs outside Tauri — src/lib/tauri.test.ts
   imports this file for exactly that, and the e2e suite talks to
   window.__mock* without importing anything. It stays plain and stays here:
   a release build resolves it to mockBackend.stub.ts instead (see the swap
   plugin in vite.config.ts), so the shipped bundle carries none of it while
   dev, `node --test` and e2e keep reading the real thing. */
import { mockInvoke, mockListen } from "./mockBackend.ts";

export { isTauri } from "./ipcshared.ts";
export type { MockContextSnapshot } from "./mockBackend.ts";

/* Whole-vault time travel is a frontend read projection over one git tree.
   Keep the safety boundary below every component: old dashboards and editors
   may still render controls, but no vault mutation crosses IPC while the
   projection is active. `history_restore` is the one intentional exception —
   restoring the open historical note is the feature's explicit write. */
let historyReadOnly = false;
export const setHistoryReadOnly = (active: boolean) => {
  historyReadOnly = active;
};
export const isHistoryReadOnly = () => historyReadOnly;

/* The guard is an ALLOW-list, not a deny-list. The first shape only
   denied `history_*`/`vault_*` plus three names, so every other family passed
   by default — a dashboard's control verb could push the historical projection
   to a remote or run a scheduled job against it, term_spawn could open a shell in a
   vault whose on-screen state is a lie, share_upload could publish a past body
   as if it were current. A new command family is a write until it is listed
   here on purpose. Everything below is a pure read, a projection fetch, or the
   one intentional write (`history_restore` — restoring the open historical
   note IS the feature). */
const HISTORY_MODE_COMMANDS = new Set([
  /* the projection itself */
  "history_status",
  "history_list",
  "history_diff",
  "history_points",
  "history_vault_snapshot",
  "history_restore",
  /* the time-travel query reads: pure git revwalks, no working-tree
     touch — a sheet scrubbed into the past may still ask what a fact was */
  "history_facts",
  "history_freshness",
  "history_sheets",
  /* vault reads — served either from the projection (ipc.ts) or live */
  "vault_root",
  "vault_list",
  "vault_read",
  "vault_fm_raw",
  "vault_template_read",
  "vault_template_list",
  /* what is installed and what was consented to — both pure reads; enabling
     is a decision about live code and has no meaning against a past snapshot */
  "kinds_list",
  "vault_search",
  "vault_search_full",
  "vault_backlinks",
  "vault_related",
  "vault_resolve",
  "vault_read_asset",
  "vault_asset_info",
  "vault_assets_orphaned",
  "vault_doctor",
  "vault_folders",
  "vault_views_read",
  "vault_schema_read",
  "vault_saved_views_read",
  /* Reads one line of device-local config (where a pin exports to);
     touches no vault, writes nothing. The export/forget writes stay blocked. */
  "view_export_target",
  "vault_sidebar_order",
  "vault_folder_meta_read",
  "vault_tag_folders_read",
  "vault_sync_status",
  "vault_sync_conflicts",
  "vault_trash_list",
  /* app-shell reads with no vault side effect */
  "onboarding_status",
  "path_exists",
  "drop_shift_down",
  /* dashboard reads (external state, never vault writes) — these render live
     numbers while browsing the past, which is honest: they are not vault
     content and the projection has never claimed to cover them */
  "curator_runs",
]);

function blockedByHistoryMode(cmd: string): boolean {
  if (!historyReadOnly) return false;
  return !HISTORY_MODE_COMMANDS.has(cmd);
}

/* Own-write attribution lives here, at the one place every vault
   mutation passes through. The alternative was tagging each of the ~30
   `refresh()` call sites in App.tsx with the paths it just wrote, which is the
   same knowledge derived twice and drifts the first time a call site forgets.
   Here the command and its result are already in hand, and the reach of a
   write is exactly what `writtenPathsFor` reads off them. */
const rawInvoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = isTauri
  ? tauriInvoke
  : (mockInvoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>);

/* "This app just wrote the vault", said synchronously at the invoke return —
   not a watcher's debounce later. The auto-sync push debounce rides this for
   our own writes (plus vault:changed for everyone else's), because the mock
   lane has no watcher to echo them back, and waiting on the real one's
   attribution dance would couple the scheduler to its timing. */
type VaultWriteListener = () => void;
const vaultWriteListeners = new Set<VaultWriteListener>();
export const onVaultWrite = (fn: VaultWriteListener): (() => void) => {
  vaultWriteListeners.add(fn);
  return () => {
    vaultWriteListeners.delete(fn);
  };
};

export const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  if (blockedByHistoryMode(cmd)) {
    throw new Error("viewing the past is read-only — return to the present to make changes");
  }
  const result = await rawInvoke<T>(cmd, args);
  // only watcher-visible mutations echo back as vault:changed, so only they
  // need attributing; a template or asset write never returns to us at all
  if (WATCHED_WRITE_COMMANDS.has(cmd) && !templateStem(args?.path)) {
    noteOwnWrite(writtenPathsFor(cmd, args, result));
    for (const fn of vaultWriteListeners) fn();
  } else if (INDEX_WRITE_COMMANDS.has(cmd)) {
    // not our echo to claim, but the note list still has to be told the
    // index moved — see INDEX_WRITE_COMMANDS
    noteIndexWrite(writtenPathsFor(cmd, args, result));
  }
  return result;
};

export const listen: typeof tauriListen = isTauri ? tauriListen : mockListen;
