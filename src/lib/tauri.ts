import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type {
  AggKind,
  CalendarFeedConfig,
  ConflictSide,
  ConflictState,
  DbIcon,
  DiffLine,
  DriveEntry,
  DriveHit,
  DriveInfo,
  FolderMetaMap,
  HistoryEntry,
  MountInfo,
  MountRow,
  MountScanStats,
  NewPropKind,
  NewTypeProp,
  NoteMeta,
  NumberFormat,
  PropKind,
  PropSchema,
  PropValue,
  RelatedEntry,
  SavedView,
  SchemaConfig,
  SelectOption,
  SidebarOrder,
  SyncReport,
  TagFolder,
  TrashEntry,
  RemoteKind,
  ReplacedStoreState,
  VaultSyncStatus,
  ViewsConfig,
} from "./types.ts";
import { foldedPropKey } from "./types.ts";
import { stripMachineFences } from "./fences.ts";
import { foldDiacritics, foldWithMap } from "./fold.ts";
import { noteTags, propTags } from "./tags.ts";
import { MOCK_FX, MOCK_FX_RATES } from "./fx.ts";
import { MOUNT_EXTRACTED, MOUNT_SCHEME } from "./mounts.ts";
import { IMAGE_SCHEME } from "./images.ts";
import { noteOwnWrite } from "./ownwrites.ts";
import { remapSavedQueryProperty } from "./query.ts";
import { resolveUnit } from "./units.ts";
import { isSystemPropName } from "./schemalookup.ts";
import { canonicalReviewWindow } from "./shelflife.ts";
import { isAppFile } from "./settings.ts";
import { hashKindBundle, parseKindManifest, KIND_API, type KindBundleInfo } from "./kinds.ts";
import { embedTarget, parseWikiLink } from "./wikilinks.ts";
// the mock backend's fixture; the dispatch that serves it stays in this file
import {
  day,
  fixedDay,
  genUpdated,
  mockAssetMtimes,
  mockAssets,
  mockLooseFiles,
  mockLooseMtime,
  mockNotes,
  now,
  MOCK_COOKBOOK,
  PIXEL_PNG,
  type MockNote,
} from "./mockseeds.ts";

export const isTauri = "__TAURI_INTERNALS__" in window;

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

/* e2e hooks into the mock backend, all prefixed `__mock`:
   __mockFail is created by specs themselves; the rest are installed by the
   mock-only block at the bottom of this file, so the shipped app never has
   them. */
declare global {
  interface Window {
    /** command names the mock should reject with `mock failure: <cmd>` */
    __mockFail?: Set<string>;
    /** fire the mock event registry — the vault:changed lane */
    __mockEmit?: (event: string, payload?: unknown) => void;
    /** mutate a mock note's body out-of-band, like an external editor */
    __mockEditNote?: (path: string, body: string) => void;
    /** remove a mock note out-of-band — a file deleted outside the app */
    __mockDeleteNote?: (path: string) => void;
    /** clone a mock note under a new path — focused navigation specs use this
        to stage two dashboards of the same renderer without bloating seeds */
    __mockCloneNote?: (sourcePath: string, path: string) => void;
    /** same, one frontmatter property — what an outside editor changing a
        prop looks like to the undo guard */
    __mockEditProp?: (path: string, key: string, value: unknown) => void;
    /** replace one mock schema entry like a hand edit on disk; public schema
        writes reject the duplicate identities this regression hook stages */
    __mockEditSchema?: (dbType: string, props: Record<string, PropSchema>) => void;
    /** forget the configured remote and any enrollment under it — a fresh
        vault that has never synced. The mock remembers the passphrase the
        first hosted save mints, exactly as the server does, so a spec that
        wants to be the first device has to say so rather than inherit
        whatever an earlier spec in the same process enrolled. */
    __mockResetSyncRemote?: () => void;
    /** the remote URL as STORED, credentials and all — the counterpart to the
        redacted one `vault_sync_status` hands a screen. A spec that means to
        prove a refused save left the credential alone has to read the stored
        string, because the redacted one looks identical either way. */
    __mockStoredSyncRemoteUrl?: () => string | null;
    /** stub the settings pane's terminal-font availability check:
        the real one measures canvas text, and whether an unknown family is
        dropped (CoreText) or substituted (fontconfig) is platform-specific,
        so a spec asserting the hint installs deterministic answers here */
    __mockFontAvailable?: (family: string) => boolean;
    /** stage the context snapshot the capture window would have been armed
        with. The real one reads NSWorkspace and the Accessibility API at
        summon time — neither exists in a browser, and asking for either is
        exactly what specs must never do — so a spec that wants the chip
        stages the answer here. `null` clears it (the flag-off case). */
    __mockSetContext?: (snap: MockContextSnapshot | null) => void;
    /** whether the mock reports macOS Accessibility as already granted —
        the Settings row's "Grant access…" affordance reads this */
    __mockSetAxTrusted?: (trusted: boolean) => void;
    /** bump a mock asset's mtime — a re-bounce under the same name */
    __mockTouchAsset?: (name: string) => void;
    /** drop an asset straight into the mock .assets store — no app write */
    __mockSaveAsset?: (name: string, data: string) => void;
    /** pretend the saved view named `viewName` has already been exported to
        `dest`. The real first export goes through a native folder
        dialog, which no browser spec can drive, so the remembered-target
        state is staged; the pin is named rather than id'd because ids are
        generated inside the app. */
    __mockSetExportTarget?: (viewName: string, dest: string) => void;
    /** put a `.vault/reflexes.json` in the mock vault. A rules file
        can ARRIVE on a device the app never armed — synced vault, restored
        backup — and that first-seen state is the one the settings section has
        to show as paused behind a switch, so a spec has to be able to stage
        it. `filePaused` stages the file's own kill switch, which is a
        different switch from consent. */
    __mockStageReflexesFile?: (opts?: { filePaused?: boolean }) => void;
    /** opt-in: completed note-mutating commands echo vault:changed, debounced
        like the engine's watcher */
    __mockSetEchoOnWrites?: (on: boolean) => void;
    /** opt-in: command execution defers so IPC completion is never synchronous.
        true → small random timeout (thread-pool reorder);
        "microtask" → minimal defer that out-races React's scheduled
        re-render — the production resolution class behind the restore race,
        restore race, which the random timeout is too slow to reach */
    __mockSetAsync?: (on: boolean | "microtask") => void;
    /** Hold every call to `cmd` open for `ms` before it runs — a
        deterministic slow disk. `__mockHoldCommand` parks a command
        indefinitely; this one lets it land on its own, which is what proving
        "the paint happened BEFORE the write returned" needs. `ms: 0` clears
        the delay for that command. */
    __mockSetLatency?: (cmd: string, ms: number) => void;
    /** Reject the NEXT call to `cmd` and only that one — `__mockFail`
        is a standing set, so with several writes to the same cell in flight it
        refuses all of them. Refusing exactly one is what "a slow write comes
        back refused after the user already retyped" needs. */
    __mockFailOnce?: (cmd: string) => void;
    /** Instrumentation: record write-lane commands plus the FX
        request seam, with args + outcome from now on */
    __mockTraceCommands?: () => void;
    /** Instrumentation: read the recorded command trace */
    __mockReadCommandTrace?: () => unknown[];
    /** hold every call to `cmd` open until `__mockReleaseCommand` — the
        deterministic form of an IPC still in flight while the user navigates
        away. The random "timeout" mode is too narrow a window to
        race a note switch against reliably. */
    __mockHoldCommand?: (cmd: string) => void;
    /** let a held command through */
    __mockReleaseCommand?: (cmd: string) => void;
    /** bulk-seed `count` loose notes into `folder` — the only way to reach a
        list long enough for ListPane to window */
    __mockSeedNotes?: (folder: string, count: number) => void;
    /** seed `count` notes that all match `token`, optionally typed and
        deliberately ranked below the untyped ones — the only way to
        push a filtered match past the engine's result cap */
    __mockSeedMatching?: (opts: {
      folder: string;
      count: number;
      token: string;
      /** in the title (ranks first) or late in the body (ranks last) */
      where: "title" | "body";
      noteType?: string;
    }) => void;
    /** stage the no-vault first-run state — the mock vault always exists,
        so this is the only way to reach the onboarding screen.
        Boot resolution happens on mount, so a spec staging first-run must
        set this flag from addInitScript, before the module loads; the
        setter is for flipping it afterwards. */
    __mockFirstRun?: boolean;
    __mockSetFirstRun?: (on: boolean) => void;
    /** stage a machine with no device key: sealing reports
        `device_unlock: false` and the Touch ID lane refuses, so a spec can
        reach the vault-password fallback the real app falls back to */
    __mockNoDeviceUnlock?: boolean;
    /** stage a scope seal whose history cleanup fails: the files
        encrypt but the marker stays `pending`, which is the only way to reach
        the "Seal conversion pending" UI */
    __mockSealPending?: boolean;
    /** plant a seal marker the way a sync pull or an external writer would
        — it exists but this device never confirmed it, so it seals
        nothing until the user accepts it in-app */
    __mockPlantSealScope?: (path: string) => void;
    /** stage a build with no demo vault bundled — the
        backend refuses rather than opening an empty folder, so a spec needs
        a way to reach the refusal */
    __mockNoDemoVault?: boolean;
    /** read one prop straight out of the mock store — the disk truth a spec
        needs when the rendered chip can't distinguish a list from a joined
        scalar */
    __mockPropOf?: (path: string, key: string) => unknown;
    /** read one note's body straight out of the mock store — the disk truth a
        spec needs when it must check what landed WITHOUT switching notes,
        since a note switch unmounts the pane and flushes on the way out
 */
    __mockBodyOf?: (path: string) => string;
    /** every note path + body in the mock store, for failure-time dumps: when
        a spec fails it often does NOT know which path the note is under (a
        rename may or may not have landed), so the path-keyed readers above
        can't be used — they throw on a miss */
    __mockNotesDump?: () => { path: string; body: string }[];
    /** which sealed notes the engine still holds an authorization for.
        No UI surface shows this — the lock screen is decided by the
        pane's own state, so a hold the app forgot to release looks identical
        to a released one on screen. This is the only way a spec can prove
        that leaving a note actually relocked it. */
    __mockSealedUnlocked?: () => string[];
    /** did the app ask to relaunch? a browser mock can't actually restart */
    __mockRelaunched?: () => boolean;
    /** the agent command onboarding wrote — null = never called,
        "" = called as skip */
    __mockAgentCommand?: () => string | null;
    /** seed a custom kind bundle into the mock lane. The real ones
        are files in `.vault/kinds/<id>/` served over a Tauri scheme, neither
        of which a browser spec has; this stages the same `kinds_list` row and
        keeps the file text where the pane's mock loader can find it. Omit
        `enabled` to stage a bundle awaiting review; pass a `hash` to stage
        drift against whatever was enabled. */
    __mockWriteKind?: (bundle: {
      id: string;
      /** raw kind.json text — a string so a spec can stage a broken manifest */
      manifest: string;
      files: Record<string, string>;
      enabled?: boolean;
      /** override the recorded consent hash — the hash-drift lane */
      enabledHash?: string;
      /** override the manifest api recorded at enable time */
      enabledApi?: number;
      /** seed the standing "trust updates to this kind" rider */
      trustUpdates?: boolean;
    }) => Promise<void>;
    /** drop every seeded bundle — specs that assert the no-kinds path */
    __mockClearKinds?: () => void;
    /** one seeded bundle file's text, as the pane's loader reads it */
    __mockKindFile?: (id: string, file: string) => string | undefined;
    /** park a conflicted merge in the mock "repository" WITHOUT a pull having
        happened in this session — the state a restart leaves behind, where
        the engine still has the merge but no last result to report */
    __mockParkConflicts?: () => void;
    /** what the next mock `vault_sync_pull` does: park the seeded conflict
        (the default) or land a clean pull listing `changed` paths — which,
        like the engine's announce_pull, re-emits as `vault:pulled` */
    __mockSetPull?: (plan: { conflicted: boolean; changed?: string[] }) => void;
    /** the pull plan a spec needs staged BEFORE the app mounts (an auto-sync
        boot pull fires before page.evaluate can) — set via addInitScript */
    __mockBootPull?: { conflicted: boolean; changed?: string[] };
    /** a hosted (blob+) store that ALREADY holds a vault, so saving that
        remote joins it instead of creating one. This is what makes the two
        refusals a real hosted save can hand back reachable: the wrong service
        token (the server turns the key read away) and the wrong passphrase
        (the wrapped key does not open). Unstaged, the store is empty and a
        save enrolls, which is the path the older specs walk. */
    __mockHostedVault?: (vault: { token: string; passphrase: string } | null) => void;
    /** stage the state a purge or trim leaves behind: an end-to-end-encrypted
        vault whose history no longer matches the server's copy, so every leg
        refuses until that copy is replaced */
    __mockSyncRewriteBlocked?: (blocked: boolean) => void;
    /** stage the other end of that state: another device published a rewritten
        history over the store while this one was holding work it has no line
        to, so pulls are paused until someone here adopts it. `null` clears */
    __mockSyncReplacedStore?: (state: ReplacedStoreState | null) => void;
    /** boot with sync already configured — the state a returning device is
        in. Read once at mock init, so this too is an addInitScript seam */
    __mockSyncConfigured?: boolean;
    /** timing overrides for the auto-sync scheduler — the real debounce is
        two minutes, which no spec should wait out */
    __mockAutoSync?: {
      pushDebounceMs?: number;
      pushMaxDirtyMs?: number;
      pullIntervalMs?: number;
      focusGapMs?: number;
    };
    /** the ordered sync commands the mock has run ("vault_sync_push" /
        "vault_sync_pull") — how a spec proves the auto lane fired (or,
        parked on a conflict, stopped firing) without waiting on network */
    __mockSyncCalls?: () => string[];
    /** leave the sticky privacy notice a failed sealing cleanup leaves —
        the warning that a later successful sync must NOT take back. Pass
        null for the acknowledged state. */
    __mockSetPrivacy?: (notice: { message: string; paths: string[] } | null) => void;
    /** stage what the next hosted push finds when it lists the store: the
        warning that it is approaching the number of objects one sync can work
        through, or null for a store back under the threshold. A warning on a
        sync that worked, not an error, and once set it survives every later
        pull — only a push clears it. */
    __mockSetSyncNotice?: (notice: string | null) => void;
    /** unbind a mount on "this machine" without touching its index — the
        other-machine board a dashboard has to keep charting from.
        Pass a folder path to bind it somewhere instead; a path containing
        "missing" is the folder-went-away case. */
    __mockUnbindMount?: (name: string, path?: string) => void;
    /** give a mount the ignore list a person would hand-write into
        `.vault/mounts.json` — nothing in the app writes one, so this is the
        only seam a spec has for the pruned-subtree board. Takes effect on the
        next rescan, exactly as editing the file does. Naming a mount that does
        not exist yet is the other half of the file's reality: the list is held
        and applied when a mount of that name is added, so its FIRST scan
        already prunes and the ignored rows never enter the index at all. */
    __mockSetMountIgnore?: (name: string, patterns: string[]) => void;
  }
}

/* onboarding mock state: the mock vault is always present, so
   first-run is opt-in via __mockSetFirstRun before the app boots. */
let mockVaultRoot = "/Users/demo/Vault (mock)";
let mockFirstRun =
  typeof window !== "undefined" && (window as Window).__mockFirstRun === true;
let mockRelaunched = false;
let mockAgentCommand: string | null = null;
let mockSealedPassword: string | null = null;
/// Mirrors `sealed::MIN_PASSWORD_CHARS` in the backend — the browser mock must
/// refuse exactly what the real vault refuses.
/** Where the browser mock parks the everywhere palette's opening query: the
    pivot out of quick capture is a page navigation here, and sessionStorage
    is what survives one. */
const PALETTE_SEED_KEY = "mock:palette-seed";
const MOCK_MIN_SEALED_PASSWORD = 12;
const mockUnlockedSealed = new Set<string>();
const mockSealScopes = new Set<string>();
/** scopes whose marker is `pending` — encrypted, history cleanup unfinished */
const mockPendingSealScopes = new Set<string>();
/** Scopes whose marker arrived from outside this device and has not been
    confirmed here. They seal nothing and purge nothing until confirmed.
    `__mockPlantSealScope` plants one the way a sync pull would,
    which is the only way to get into this state. */
const mockUnconfirmedSealScopes = new Set<string>();
const mockDeviceUnlock =
  typeof window === "undefined" || (window as Window).__mockNoDeviceUnlock !== true;
const mockSealStaysPending = () =>
  typeof window !== "undefined" && (window as Window).__mockSealPending === true;

function mockScopeApplies(path: string): boolean {
  if (path === "Settings.md" || path === "AGENTS.md" || path === "CLAUDE.md") return false;
  const folder = mockFolderOf(path);
  // an unconfirmed marker seals nothing
  return [...mockSealScopes].some(
    (scope) =>
      !mockUnconfirmedSealScopes.has(scope) &&
      (scope === "" || folder === scope || folder.startsWith(`${scope}/`))
  );
}

function mockEnforceSealScope(note: MockNote): void {
  if (!mockScopeApplies(note.path)) return;
  note.sealed = true;
  mockUnlockedSealed.delete(note.path);
}
let mockMcpGrants: {
  client: string;
  prefix: string;
  access: "read" | "write";
}[] = [];





/** The mock lane's in-flight recording — a stem and a start time, no audio. */
let mockVoice: { stem: string; startedMs: number } | null = null;
/** What `context_pending` reports — the shape `ContextSnapshot` serializes to.
    Exported because the `__mockSetContext` seam takes one. */
export interface MockContextSnapshot {
  app: string;
  doc: string | null;
  file: string | null;
}
/** No capture is ever armed with context until a spec stages one: the flag is
    off by default, and the browser has no frontmost-app notion anyway. */
let mockContext: MockContextSnapshot | null = null;
/** …and the mock Mac has not granted Accessibility, which is the state a new
    install is in. */
let mockAxTrusted = false;

/** The mock lane starts with no speech model, so the settings row opens in the
    state a new install actually has: an offer to download, not a done tick. */
let mockVoiceModel = false;


/** A mock disk path for a loose file — what the real engine returns as
    `FolderFile.path` and what the shared player keys on. */
function mockLoosePath(rel: string): string {
  return `${mockVaultRoot}/${rel}`;
}

/** The loose file a `FolderFile.path` names, or null. `vault_asset_info`
    consults this before its broken-path branch: folder rows resolve, while
    every OTHER absolute name keeps failing, which is what demos the broken
    link-in-place embed state. */
function mockLooseByPath(path: string): { rel: string; name: string } | null {
  for (const [folder, names] of mockLooseFiles) {
    for (const name of names) {
      const rel = folder ? `${folder}/${name}` : name;
      if (mockLoosePath(rel) === path) return { rel, name };
    }
  }
  return null;
}

function meta(n: MockNote): NoteMeta {
  const { body: _body, unreadable: _unreadable, fm: _fm, ...m } = n;
  // a sealed note projects no props, no excerpt, and no tags: tags are derived
  // from the body's inline `#hashtags`, so publishing them would leak
  // the ciphertext's content through the tag sidebar and tag folders
  if (n.sealed) return { ...m, props: {}, excerpt: "", tags: [], sealed: true };
  // mirrors Engine::index_file: a note's tags are computed at index
  // time from body + props, never stored on the fixture
  return { ...m, sealed: false, tags: noteTags(n.props, n.body) };
}

/* Frontmatter health for the fm lanes, mirroring vault.rs's
   fm_diagnosis: duplicate top-level keys (same column-0 scan — serde_yaml
   accepts them last-wins, the write lanes refuse), a non-map block, invalid
   YAML. The mock has no YAML parser; the seeded blocks are plain
   `key: value` shapes, so a line scan stands in for the parse. */
type MockFmFault = "duplicate top-level keys" | "not a property map" | "not valid YAML";

function mockFmDiagnosis(fm: string): MockFmFault | null {
  const seen = new Set<string>();
  for (const line of fm.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (/^\s/.test(line)) continue; // indented lines belong to values
    if (t === "-" || t.startsWith("- ")) return "not a property map";
    const i = line.indexOf(":");
    if (i <= 0) return "not valid YAML";
    const key = line.slice(0, i).trim();
    if (!key) continue;
    if (seen.has(key)) return "duplicate top-level keys";
    seen.add(key);
    // unbalanced flow brackets — the engine's YAML parse fails on these
    const v = line.slice(i + 1);
    if (v.split("[").length !== v.split("]").length) return "not valid YAML";
  }
  return null;
}

/** The write-lane refusal wording, mirroring FmFault::refusal. */
function mockFmRefusal(path: string, fault: MockFmFault): string {
  const what = fault === "duplicate top-level keys" ? "has duplicate keys" : `is ${fault}`;
  return `frontmatter in ${path} ${what} — fix it in the editor before editing properties`;
}

/** Healthy block → props, like the engine's reindex after fm_write. Values
    stay strings — the mock's plain `key: value` lane has no YAML typing. */
function mockRecord<T>(initial?: Readonly<Record<string, T>>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (initial) Object.assign(out, initial);
  return out;
}

/** `"quoted"` → quoted; anything else is the trimmed text. The mock has no
    YAML typing beyond this — numbers and dates stay strings. */
function mockFmScalar(raw: string): string {
  const v = raw.trim();
  return /^"(.*)"$/s.test(v) ? v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : v;
}

function mockFmProps(fm: string): Record<string, unknown> {
  const out = mockRecord<unknown>();
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith("#") || /^[\s-]/.test(line)) continue;
    const c = line.indexOf(":");
    if (c <= 0) continue;
    const key = line.slice(0, c).trim();
    const inline = line.slice(c + 1).trim();
    if (inline) {
      out[key] = mockFmScalar(inline);
      continue;
    }
    /* A key with nothing after the colon opens a block list — `pages:` and
       `cards:` are lists of maps, `tags:` a list of scalars, and the fm lanes
       write both back through fm_write. Parsed here so the mock's reindex
       keeps them instead of flattening the key to "". */
    const items: unknown[] = [];
    let map: Record<string, string> | null = null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      // a zero-indent `- item` is still this key's list; a bare key is not
      if (!/^[\s-]/.test(l)) break;
      const dash = l.match(/^\s*- ?(.*)$/);
      const text = dash ? dash[1] : l.trim();
      const k = text.indexOf(":");
      if (k > 0 && !/^\s*-/.test(text)) {
        const pair = [text.slice(0, k).trim(), mockFmScalar(text.slice(k + 1))] as const;
        if (dash) items.push((map = { [pair[0]]: pair[1] }));
        else if (map) map[pair[0]] = pair[1];
      } else if (dash) {
        map = null;
        items.push(mockFmScalar(text));
      }
    }
    if (j > i + 1) i = j - 1;
    out[key] = items;
  }
  return out;
}

/** Prop equality for the undo guard — the engine compares
    serde_json::Values, so lists compare element-wise, not by identity. */
function mockPropEq(a: PropValue, b: PropValue): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => x === b[i])
    );
  return a === b;
}

/** Props → block after a set_prop on an fm-tracked note, like the engine's
    re-serialization; an empty map drops the block (set_prop_value). */
function mockFmSerialize(props: Record<string, unknown>): string | undefined {
  const item = (x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? // a list of maps (pages:, cards:) — the dash carries the first pair
        Object.entries(x as Record<string, unknown>)
          .map(([k, v], i) => `${i === 0 ? "- " : "  "}${k}: ${v}`)
          .join("\n")
      : `- ${x}`;
  const lines = Object.entries(props).map(([k, v]) =>
    Array.isArray(v) ? `${k}:\n${v.map(item).join("\n")}` : `${k}: ${v}`
  );
  return lines.length ? `${lines.join("\n")}\n` : undefined;
}

/* Mock version history: three fake snapshots per note, seeded lazily from the
   current body so restore/purge/trim behave like the real engine. */
interface MockSnap {
  id: string;
  ts_ms: number;
  subject: string;
  body: string;
}


const mockHistory = new Map<string, MockSnap[]>(); // newest first
let mockSnapSeq = 0;

function snapsFor(n: MockNote): MockSnap[] {
  let snaps = mockHistory.get(n.path);
  if (!snaps) {
    const lines = n.body.split("\n");
    const v1 = lines.slice(0, Math.max(1, Math.ceil(lines.length / 3))).join("\n") + "\n";
    const v2 = lines.slice(0, Math.max(2, Math.ceil((lines.length * 2) / 3))).join("\n") + "\n";
    snaps = [
      { id: `snap${++mockSnapSeq}`, ts_ms: n.updated_ms, subject: "snapshot", body: n.body },
      { id: `snap${++mockSnapSeq}`, ts_ms: n.updated_ms - 3 * 3_600_000, subject: "snapshot", body: v2 },
      { id: `snap${++mockSnapSeq}`, ts_ms: n.updated_ms - 27 * 3_600_000, subject: "snapshot", body: v1 },
    ];
    mockHistory.set(n.path, snaps);
  }
  return snaps;
}


function mockDiff(oldBody: string, newBody: string): DiffLine[] {
  const a = oldBody.replace(/\n$/, "").split("\n");
  const b = newBody.replace(/\n$/, "").split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (
    post < a.length - pre &&
    post < b.length - pre &&
    a[a.length - 1 - post] === b[b.length - 1 - post]
  )
    post++;
  const out: DiffLine[] = [];
  if (a.length - pre - post === 0 && b.length - pre - post === 0) return out;
  out.push({ kind: "hunk", text: `@@ -${pre + 1} +${pre + 1} @@` });
  if (pre > 0) out.push({ kind: "ctx", text: a[pre - 1] });
  for (const t of a.slice(pre, a.length - post)) out.push({ kind: "del", text: t });
  for (const t of b.slice(pre, b.length - post)) out.push({ kind: "add", text: t });
  if (post > 0) out.push({ kind: "ctx", text: a[a.length - post] });
  return out;
}

function mockEntries(path: string, snaps: MockSnap[]): HistoryEntry[] {
  return snaps.map((s, i) => {
    const prev = snaps[i + 1];
    const d = mockDiff(prev ? prev.body : "", s.body);
    return {
      id: s.id,
      ts_ms: s.ts_ms,
      subject: s.subject,
      file: path,
      adds: d.filter((l) => l.kind === "add").length,
      dels: d.filter((l) => l.kind === "del").length,
    };
  });
}

const mockViews = mockRecord<ViewsConfig[string]>() as ViewsConfig;

/* Mock folder meta: vault-relative folder path → icon, mirroring
   the `$folders` key in views.json. One seed so the read path shows on boot;
   rename retargets keys, trash drops them, like the engine. */
const mockFolderMeta: FolderMetaMap = {
  Projects: { icon: { emoji: "🌱" } },
};

/* Mock tag folders, mirroring `.vault/tagfolders.json`. Empty on
   boot: a vault's first tag folder is built, never seeded, so specs exercise
   the builder from the same empty state a new vault has. Specs that need
   tagged notes write them with __mockEditNote/__mockEditProp. */
let mockTagFolders: TagFolder[] = [];

/* Folder registry mirrors the real dirs on disk: seeded from note locations
   plus one empty nested branch so the tree has something collapsible, and
   kept in sync by create/rename/move below. */
const mockFolders = new Set<string>();
function mockAddFolder(path: string) {
  let f = path;
  while (f) {
    mockFolders.add(f);
    const i = f.lastIndexOf("/");
    f = i === -1 ? "" : f.slice(0, i);
  }
}
for (const n of mockNotes) mockAddFolder(n.folder);
mockAddFolder("Projects/Active");
mockAddFolder("Projects/Archive");

function mockFolderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

let mockSidebarOrder: SidebarOrder = { dashboards: [], databases: [], keys: {} };

/** Mirrors Engine::move_sidebar_pin: a pinned note path follows its
    note on rename/move (`newPath` given) and leaves the sidebar on trash
    (`null`). No-op when the note isn't pinned. */
function mockMoveSidebarPin(oldPath: string, newPath: string | null): void {
  const pins = mockSidebarOrder.pins;
  if (!pins?.includes(oldPath)) return;
  mockSidebarOrder = {
    ...mockSidebarOrder,
    pins: newPath ? pins.map((p) => (p === oldPath ? newPath : p)) : pins.filter((p) => p !== oldPath),
  };
}

/** Mirrors Engine::retarget_sidebar_keys: `f` maps one target token
    to its replacement, or to None to drop the binding. Key tokens never move —
    the user assigned ⌘5, ⌘5 is what they keep. */
function mockRetargetSidebarKeys(f: (target: string) => string | null | undefined): void {
  const cur = mockSidebarOrder.keys;
  if (!cur) return;
  let touched = false;
  const keys: Record<string, string> = {};
  for (const [k, target] of Object.entries(cur)) {
    const next = f(target);
    if (next === undefined) keys[k] = target;
    else if (next === null) touched = true;
    else {
      touched = true;
      keys[k] = next;
    }
  }
  if (touched) mockSidebarOrder = { ...mockSidebarOrder, keys };
}

/** Mirrors Engine::move_sidebar_keys: a key assigned to a note follows that
    note on rename/move and leaves on trash. Both note-shaped targets ride
    along — a pinned note (`note:`) and a dashboard (`dash:`). */
function mockMoveSidebarKeys(oldPath: string, newPath: string | null): void {
  mockRetargetSidebarKeys((target) => {
    const prefix = target === `note:${oldPath}` ? "note:" : target === `dash:${oldPath}` ? "dash:" : null;
    if (!prefix) return undefined;
    return newPath ? `${prefix}${newPath}` : null;
  });
}

/** Move one note into the mock trash at a caller-supplied stamp — the mock's
    Engine::trash_at. `vault_delete` passes its own `Date.now()`; a bulk
    delete passes ONE stamp for the whole selection. Throws like the
    engine when the path isn't a live note. */
function mockTrashNote(path: string, at: number): string {
  const idx = mockNotes.findIndex((n) => n.path === path);
  if (idx === -1) throw new Error("note not found");
  const [n] = mockNotes.splice(idx, 1);
  // a trashed note leaves the sidebar with it (engine move_sidebar_pin)
  mockMoveSidebarPin(n.path, null);
  // …and its assigned key frees up
  mockMoveSidebarKeys(n.path, null);
  // engine Engine::trash bumps the stamp until the id is free, so two
  // deletions of the same path never collide
  let deleted_ms = at;
  while (mockTrash.some((t) => t.id === `${deleted_ms}/${n.path}`)) deleted_ms += 1;
  const id = `${deleted_ms}/${n.path}`;
  mockTrash.unshift({
    id,
    path: n.path,
    title: n.title,
    deleted_ms,
    kind: "note",
    notes: [],
    note: n,
  });
  return id;
}

/** Mirrors the `db:` arm of Engine::remap_sidebar_entry: a key bound to a
    database row follows a type rename and dies with the delete. */
function mockMoveSidebarKeysDb(oldType: string, newType: string | null): void {
  mockRetargetSidebarKeys((target) => {
    const type = target.startsWith("db:") ? target.slice(3) : undefined;
    return type?.toLowerCase() === oldType.toLowerCase()
      ? (newType === null ? null : `db:${newType}`)
      : undefined;
  });
}

/** Mirrors Engine::move_sidebar_keys_folder: a renamed folder carries its own
    key and every key assigned to something inside it; trashing drops them all. */
function mockMoveSidebarKeysFolder(oldRel: string, newRel: string | null): void {
  mockRetargetSidebarKeys((target) => {
    const i = target.indexOf(":");
    if (i === -1) return undefined;
    const kind = target.slice(0, i);
    const path = target.slice(i + 1);
    if (kind !== "folder" && kind !== "note" && kind !== "dash") return undefined;
    if (path !== oldRel && !path.startsWith(`${oldRel}/`)) return undefined;
    return newRel === null ? null : `${kind}:${newRel}${path.slice(oldRel.length)}`;
  });
}

/** Rewrite every path-keyed record when a folder moves from `oldRel` to
    `newRel` — the subtree included. Mirrors what the engine's rename_folder /
    move_folder do through move_folder_meta, move_schema_homes,
    move_sidebar_folders and move_sidebar_keys_folder. */
function mockRelocateFolder(oldRel: string, newRel: string): void {
  const retarget = (p: string) => newRel + p.slice(oldRel.length);
  const inside = (p: string) => p === oldRel || p.startsWith(`${oldRel}/`);
  for (const f of [...mockFolders]) {
    if (inside(f)) {
      mockFolders.delete(f);
      mockAddFolder(retarget(f));
    }
  }
  for (const n of mockNotes) {
    if (inside(n.folder)) {
      const moved = retarget(n.path);
      // a pinned note inside the folder keeps its row
      mockMoveSidebarPin(n.path, moved);
      n.path = moved;
      n.folder = mockFolderOf(n.path);
    }
  }
  for (const scope of [...mockSealScopes]) {
    if (inside(scope)) {
      mockSealScopes.delete(scope);
      mockSealScopes.add(retarget(scope));
      if (mockPendingSealScopes.delete(scope)) mockPendingSealScopes.add(retarget(scope));
      // the confirmation travels with its folder; so does the lack
      // of one — a rename must not silently confirm a planted marker
      if (mockUnconfirmedSealScopes.delete(scope))
        mockUnconfirmedSealScopes.add(retarget(scope));
    }
  }
  for (const n of mockNotes) mockEnforceSealScope(n);
  // folder meta follows, subtree included (engine move_folder_meta)
  for (const k of Object.keys(mockFolderMeta)) {
    if (inside(k)) {
      mockFolderMeta[retarget(k)] = mockFolderMeta[k];
      delete mockFolderMeta[k];
    }
  }
  // schema homes follow too, subtree included (engine move_schema_homes)
  for (const [t, h] of Object.entries(mockHomes)) {
    if (inside(h)) mockHomes[t] = retarget(h);
  }
  // …and the sidebar folder + dash-group orders (engine move_sidebar_folders),
  // plus the DASHBOARDS lane, whose entries are full note paths inside the
  // subtree — without this the group's manual dashboard order dies on a move
  mockSidebarOrder = {
    ...mockSidebarOrder,
    ...(mockSidebarOrder.folders
      ? { folders: mockSidebarOrder.folders.map((f) => (inside(f) ? retarget(f) : f)) }
      : {}),
    ...(mockSidebarOrder.dashgroups
      ? { dashgroups: mockSidebarOrder.dashgroups.map((g) => (inside(g) ? retarget(g) : g)) }
      : {}),
    ...(mockSidebarOrder.dashboards
      ? { dashboards: mockSidebarOrder.dashboards.map((d) => (inside(d) ? retarget(d) : d)) }
      : {}),
  };
  // …and every key bound into the subtree, the folder row included.
  // One subtree pass covers the notes too, so the per-note loop above
  // doesn't call the key mirror.
  mockMoveSidebarKeysFolder(oldRel, newRel);
}

let mockSavedViews: SavedView[] = [];
let mockCalendarFeeds: CalendarFeedConfig[] = [];
/** Remembered link-folder targets, per saved view. Device-local in
    the real app (app-config dir), in-memory here. */
const mockExportTargets = new Map<string, string>();

/** the consent state the reflexes settings section reads and writes.
    There is no rules file until a spec stages one — which is exactly the
    default the section hides itself on. `enabled` is the one-time per-vault
    arm; `paused` is the separate switch it becomes afterwards. */
/** Deep Recall in the mock lane: the switch and the numbers are real state,
    the history behind them is a fixture. Indexing a git history is exactly
    the part the mock backend has none of, so `recall_index` reports a
    finished walk over the fixture instead of pretending to walk. */
const mockRecall: { enabled: boolean; indexed: boolean } = { enabled: false, indexed: false };

/** Snippet parts for a mock recall hit: the plain substring split, which is
    all the fixture bodies need — the real index highlights through the same
    FTS offsets the live search uses. */
function mockSnippetParts(text: string, q: string): { text: string; hit: boolean }[] {
  const at = text.toLowerCase().indexOf(q);
  if (at < 0 || !q) return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  if (at > 0) parts.push({ text: text.slice(0, at), hit: false });
  parts.push({ text: text.slice(at, at + q.length), hit: true });
  if (at + q.length < text.length) parts.push({ text: text.slice(at + q.length), hit: false });
  return parts;
}

/** Two past versions of one note plus a deleted one — enough to exercise the
    grouping, the lifespan line, the collapsed-versions tail and the jump into
    the scrubber. Bodies are the source of the snippets below. */
const MOCK_RECALL_PAST: {
  path: string;
  oid: string;
  first_id: string;
  first_ts_ms: number;
  last_id: string;
  last_ts_ms: number;
  deleted: boolean;
  line: number;
  text: string;
  older: number;
}[] = [
  {
    path: "Masters/veilwork.md",
    oid: "a1b2c3d4",
    first_id: "3f9a1c2",
    first_ts_ms: Date.parse("2026-03-04T10:12:00Z"),
    last_id: "77c0de1",
    last_ts_ms: Date.parse("2026-06-18T09:03:00Z"),
    deleted: false,
    line: 12,
    text: "the low end sits under the vocal, not beside it",
    older: 3,
  },
  {
    path: "Drafts/second pass.md",
    oid: "e5f6a7b8",
    first_id: "1d4e88a",
    first_ts_ms: Date.parse("2025-11-21T16:40:00Z"),
    last_id: "9ab77f0",
    last_ts_ms: Date.parse("2026-01-09T12:00:00Z"),
    deleted: true,
    line: 4,
    text: "cut the intro, the room does that work already",
    older: 0,
  },
];

const mockReflexes: { hasFile: boolean; enabled: boolean; paused: boolean; filePaused: boolean } = {
  hasFile: false,
  enabled: false,
  paused: false,
  filePaused: false,
};

/** Keep mock pins in the same state Engine::remap_saved_view_prop writes.
    Database and property identities are case-folded; query operator keys are
    case-insensitive for the same reason through parseQuery. */
function mockRemapSavedViewProp(
  dbType: string,
  oldName: string,
  newName: string | null,
  numberKind: boolean
): void {
  mockSavedViews = mockSavedViews.map((view) => {
    if (view.db.toLowerCase() !== dbType.toLowerCase()) return view;
    const next: SavedView = { ...view };
    if (view.query !== undefined) {
      const query = remapSavedQueryProperty(view.query, oldName, newName, numberKind);
      if (query === null) delete next.query;
      else next.query = query;
    }
    for (const key of ["group_by", "table_group_by"] as const) {
      if (view[key]?.toLowerCase() !== oldName.toLowerCase()) continue;
      if (newName === null) delete next[key];
      else next[key] = newName;
    }
    if (view.sort?.key.toLowerCase() === oldName.toLowerCase()) {
      if (newName === null) delete next.sort;
      else next.sort = { ...view.sort, key: newName };
    }
    if (view.sorts) {
      const sorts =
        newName === null
          ? view.sorts.filter((sort) => sort.key.toLowerCase() !== oldName.toLowerCase())
          : view.sorts.map((sort) =>
              sort.key.toLowerCase() === oldName.toLowerCase() ? { ...sort, key: newName } : sort
            );
      if (sorts.length === 0) delete next.sorts;
      else next.sorts = sorts;
    }
    if (view.columns) {
      const oldFolded = oldName.toLowerCase();
      const newFolded = newName?.toLowerCase();
      const hasDistinctNew =
        newFolded !== undefined &&
        newFolded !== oldFolded &&
        view.columns.some((column) => column.toLowerCase() === newFolded);
      let wroteNew = false;
      const columns = view.columns.flatMap((column) => {
        if (column.toLowerCase() !== oldFolded) return [column];
        if (newName === null || hasDistinctNew || wroteNew) return [];
        wroteNew = true;
        return [newName];
      });
      if (columns.length === 0) delete next.columns;
      else next.columns = columns;
    }
    return next;
  });
}

const mockSchemaSeed: SchemaConfig = {
  // event: calendar-born entries get the date chip plus the schema's empty
  // location chip (template default "Studio" wins) — the demo lane
  event: {
    date: { options: [], kind: "date" },
    location: { options: [] },
  },
  task: {
    status: {
      options: [
        { value: "todo", color: "yellow" },
        { value: "doing", color: "blue" },
        { value: "done", color: "green" },
      ],
    },
    // notify flag = the tray agenda's deadline / due-date notification opt-in
    due: { options: [], kind: "date", notify: true },
    // the tasks board pills priority in the schema's own colors;
    // an unschema'd vault falls back to the same roster in tasksDashboard.ts
    priority: {
      options: [
        { value: "High", color: "red" },
        { value: "Medium", color: "yellow" },
        { value: "Low", color: "gray" },
      ],
    },
  },
  release: {
    status: {
      options: [
        { value: "live", color: "green" },
        { value: "in review", color: "yellow" },
        { value: "mastering", color: "blue" },
        { value: "parked", color: "gray" },
      ],
    },
    // multi: several values per release — Notion multi_select parity
    format: {
      options: [
        { value: "Vinyl", color: "violet" },
        { value: "Digital", color: "teal" },
        { value: "Tape", color: "orange" },
      ],
      kind: "multi",
    },
    released: { options: [], kind: "date" },
    contract: { options: [], kind: "file" },
    contact: { options: [], kind: "relation", type: "contact" },
  },
  // the generated pipeline: `released` is kind text ON PURPOSE — a
  // date-kind (or schema-unruled ISO) prop would put catalog entries on the
  // calendar, and the calendar's create-type list is e2e-asserted as exactly
  // [event, release, task]
  catalog: {
    status: {
      options: [
        { value: "live", color: "green" },
        { value: "in review", color: "yellow" },
        { value: "mastering", color: "blue" },
        { value: "parked", color: "gray" },
      ],
    },
    format: {
      options: [
        { value: "Vinyl", color: "violet" },
        { value: "Digital", color: "teal" },
        { value: "Tape", color: "orange" },
      ],
      kind: "multi",
    },
    released: { options: [], kind: "text" },
    contract: { options: [], kind: "file" },
    contact: { options: [], kind: "relation", type: "contact" },
  },
  gear: {
    manual: { options: [], kind: "file" },
  },
  // zhome: mirrors a REAL schema.json entry — the reserved db-level `icon`
  // (DbIcon) and `home` (folder path) keys ride the same record as the prop
  // schemas; anything iterating a type's entries must skip them (0.8.0 crash:
  // DatabasePane's filterHint did `schema.options[0]` on the icon entry)
  zhome: {
    icon: { emoji: "🧪" } as unknown as PropSchema,
    home: "ZHome" as unknown as PropSchema,
    status: {
      options: [
        { value: "Active", color: "green" },
        { value: "Ended", color: "gray" },
      ],
    },
  },
  // url kind: product-page links on the gear inventory — the demo
  // lane for clickable link cells; a few rows carry values (below)
  // checkbox kind: `in use` flags the gear in the live rig — a few
  // rows carry `true` (below), the rest demo the unchecked lane
  // number kind: `price` is the euro-formatted money column — most
  // rows carry a value (below), one carries junk, some stay empty; it also
  // carries the fixture property description
  inventory: {
    link: { options: [], kind: "url" },
    "in use": { options: [], kind: "checkbox" },
    price: { options: [], kind: "number", format: "euro", description: "Approximate is fine — current resale value." },
  },
  // email/phone kinds: the contacts book is the demo lane — every
  // row carries an email, two carry a phone (the empty-cell lane). The role
  // select is the grouped table's "By Type" lane — options in a
  // deliberate non-alphabetical order to prove schema-order sections.
  contact: {
    // review windows: a contact's reachable details are the mock's shelf-life
    // material — a phone number is worth re-checking about once a year, an
    // address that bounces sooner than that
    email: { options: [], kind: "email", review: "90d" },
    phone: { options: [], kind: "phone", review: "1y" },
    role: {
      options: [
        { value: "mix engineer", color: "blue" },
        { value: "artwork", color: "violet" },
        { value: "booking", color: "teal" },
        { value: "radio plugger", color: "orange" },
      ],
    },
  },
  "finance-doc": {
    file: { options: [], kind: "file" },
    year: {
      options: [{ value: "2024" }, { value: "2025" }, { value: "2026" }],
    },
    category: {
      options: [
        { value: "invoice", color: "blue" },
        { value: "statement", color: "teal" },
        { value: "contract", color: "violet" },
        { value: "tax", color: "orange" },
        { value: "receipt", color: "pink" },
      ],
    },
    status: {
      options: [
        { value: "new", color: "yellow" },
        { value: "booked", color: "green" },
        { value: "archived", color: "gray" },
      ],
    },
  },
  /* ledger: the wide royalty-statement fixture — 16 props + title +
     `created` = an 18-column table, the mock's densest, so the audit harness
     can judge header truncation / cell crowding / scroll affordance at real
     width. `period` is kind text ON PURPOSE (quarter labels, ISO months): a
     date-kind prop would put ledger in the calendar's create-as picker, which
     e2e pins as exactly [event, release, task] — the catalog.released trick. */
  ledger: {
    period: { options: [], kind: "text" },
    "statement no": { options: [], kind: "text" },
    platform: {
      options: [
        { value: "Bandcamp", color: "teal" },
        { value: "Spotify", color: "green" },
        { value: "Apple Music", color: "pink" },
        { value: "Beatport", color: "blue" },
        { value: "Juno Download", color: "orange" },
        { value: "YouTube Content ID", color: "violet" },
      ],
    },
    gross: { options: [], kind: "number", format: "euro" },
    fees: { options: [], kind: "number", format: "euro" },
    net: { options: [], kind: "number", format: "euro" },
    "artist share": { options: [], kind: "number", format: "euro" },
    recoupment: { options: [], kind: "number", format: "euro" },
    "balance carried": { options: [], kind: "number", format: "euro" },
    "digital rate": { options: [], kind: "number", format: "percent" },
    "physical rate": { options: [], kind: "number", format: "percent" },
    paid: { options: [], kind: "checkbox" },
    "statement url": { options: [], kind: "url" },
    contact: { options: [], kind: "relation", type: "contact" },
    notes: { options: [], kind: "text" },
    method: {
      options: [
        { value: "bank transfer", color: "blue" },
        { value: "paypal", color: "teal" },
        { value: "label credit", color: "violet" },
      ],
    },
  },
};

// User-authored database and property identities must not fall through to
// Object.prototype. Seed through null-prototype records so later writes of
// `__proto__`/`constructor` behave exactly like ordinary own keys.
const mockSchema = mockRecord(
  Object.fromEntries(
    Object.entries(mockSchemaSeed).map(([type, props]) => [type, mockRecord(props)])
  )
) as SchemaConfig;

/* ── Perf fixture (gated) ──────────────────────────────────────────
   `?perfdb=1400` on the dev-server URL (or VITE_PERF_DB=1400 in the env) grows
   a `plugin` database of N rows — the stand-in for a real ~1400-row plugin
   list behind the big-table lazy-paint work. OFF by default: with the gate
   unset not a single note or schema key is added, so the default mock keeps
   its exact seeded counts and every e2e assertion stands. When ON, the notes
   still follow the generated-fixture discipline above: typed rows,
   genUpdated-aged, no schema-unruled ISO dates, none of the search-pinned
   words (lisbon/inbox/vessel/rondo/static/capture/Umbra/Overview). */
const PERF_DB_COUNT = (() => {
  // window.location is absent under node --test (tauri.test.ts imports the mock)
  if (isTauri || typeof window === "undefined" || !window.location) return 0;
  const q = new URLSearchParams(window.location.search).get("perfdb");
  const n = Number(q ?? import.meta.env.VITE_PERF_DB ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50_000) : 0;
})();

if (PERF_DB_COUNT > 0) {
  const PLUGIN_DEVS = [
    "FabFilter", "Valhalla", "Soundtoys", "UAD", "Waves", "Arturia",
    "oeksound", "Tokyo Dawn", "Brainworx", "Softube", "Eventide", "iZotope",
    "Celemony", "Xfer", "Korg", "Audified", "Acustica", "Kazrog",
    "Black Salt", "Three Body", "Boz Digital", "Leapwing", "Sonimus", "Voxengo",
  ];
  const PLUGIN_PRODUCTS = [
    "Pro-Q", "Decapitator", "Supermassive", "VintageVerb", "Soothe", "Diva",
    "Ozone", "Neutron", "Spire", "EchoBoy", "Little Plate", "Saturn",
    "Limiter No 6", "TDR Nova", "Molotok", "Britson", "Sand", "True Iron",
    "Nebula", "Harmonics", "ClipShifter", "Density", "Fresh Air", "Gullfoss",
    "Inflator", "TransModulator", "Reel Bus", "PreFix", "PhaseScope", "MonoMaker",
    "Drift Choir", "Glass Rooms", "Iron VCA", "Paper Folds", "Night Bus",
    "Silver Spring", "Copper Band", "Velvet Comp", "Amber Drive", "Mistral Delay",
    "Granular Wash",
  ];
  const PLUGIN_CATS: { value: string; color?: string }[] = [
    { value: "EQ", color: "blue" },
    { value: "Compressor", color: "teal" },
    { value: "Reverb", color: "violet" },
    { value: "Delay", color: "orange" },
    { value: "Saturation", color: "pink" },
    { value: "Synth", color: "green" },
    { value: "Modulation", color: "yellow" },
    { value: "Utility", color: "gray" },
    { value: "Mastering", color: "blue" },
  ];
  const PLUGIN_FORMATS: { value: string; color?: string }[] = [
    { value: "VST3", color: "blue" },
    { value: "AU", color: "teal" },
    { value: "CLAP", color: "violet" },
  ];
  const PLUGIN_STATUS: { value: string; color?: string }[] = [
    { value: "active", color: "green" },
    { value: "trial", color: "yellow" },
    { value: "parked", color: "gray" },
  ];
  mockSchema.plugin = mockRecord({
    developer: { options: [] },
    category: { options: PLUGIN_CATS },
    format: { options: PLUGIN_FORMATS, kind: "multi" },
    status: { options: PLUGIN_STATUS },
    price: { options: [], kind: "number", format: "euro" },
    "in use": { options: [], kind: "checkbox" },
    version: { options: [] },
    link: { options: [], kind: "url" },
  });
  const combos = PLUGIN_DEVS.length * PLUGIN_PRODUCTS.length; // 984 unique names
  for (let i = 0; i < PERF_DB_COUNT; i++) {
    const base = i % combos;
    const dev = PLUGIN_DEVS[base % PLUGIN_DEVS.length];
    const product = PLUGIN_PRODUCTS[Math.floor(base / PLUGIN_DEVS.length)];
    const title = `${dev} ${product}${i >= combos ? ` ${Math.floor(i / combos) + 1}` : ""}`;
    const props: Record<string, unknown> = {
      type: "plugin",
      developer: dev,
      category: PLUGIN_CATS[i % PLUGIN_CATS.length].value,
      status: PLUGIN_STATUS[i % PLUGIN_STATUS.length].value,
      created: fixedDay(1 + ((i * 7) % 900)),
    };
    if (i % 5 !== 4) props.format = i % 3 === 0 ? ["VST3", "AU"] : [PLUGIN_FORMATS[i % 3].value];
    if (i % 4 !== 3) props.price = 29 + ((i * 37) % 220) + (i % 2 === 0 ? 0.99 : 0.49);
    if (i % 3 === 0) props["in use"] = true;
    if (i % 6 !== 5) props.version = `${1 + (i % 4)}.${(i * 3) % 9}.${i % 7}`;
    if (i % 5 === 0) props.link = `https://www.example.dev/${product.toLowerCase().replace(/\s+/g, "-")}`;
    const excerpt = `${PLUGIN_CATS[i % PLUGIN_CATS.length].value} by ${dev}.`;
    mockNotes.push({
      path: `Plugins/${title}.md`,
      stem: title,
      title,
      folder: "Plugins",
      props,
      updated_ms: genUpdated(),
      excerpt,
      body: `${excerpt}\n`,
    });
  }
  mockAddFolder("Plugins");
}

/* Reality-mounts mock: one mount, "finance-doc", bound on this
   machine to ~/Personal/Finance, whose "disk" is a dozen fake files. Rows come
   from the index, NOT from stub notes — the only note here is the pre-seeded
   sidecar above, bound to a file that is no longer on disk, so its row renders
   missing exactly like the engine's.

   Two halves on purpose, mirroring the engine: `mockMounts` is the portable
   registry (`.vault/mounts.json`, no path), `mockMountBindings` is what THIS
   machine knows (app config). Unbinding leaves the mount and its index intact
   — that is the "not on this machine" board, not an error state.

   The registry is mutable state: rename_type carries the mount and delete_type
   unmounts it too, so neither can leave a mount answering to a
   name nothing else uses. */
interface MockMount {
  id: string;
  name: string;
  globs: string[];
  /** Paths this mount doesn't see. No dialog writes one — it is hand-authored
      in `.vault/mounts.json`, so the mock's own seam for it is
      `__mockSetMountIgnore`. */
  ignore?: string[];
  watch?: boolean;
  /** Set on a mount the app made for an external volume — a drive. Carrying
      the volume's identity on the mount is what the engine does, so the mock
      does it too: a drive is not a second registry. */
  volume?: { id: string; label: string; total: number; first_seen: string; last_seen: string };
}
interface MockMountFile {
  rel: string;
  size: number;
  modified: string;
  created: string;
  identity: string;
  missing: boolean;
  /** What the file said about itself. The engine fills this behind a
      scan; the mock has no bytes, so a PDF's page count is simply part of the
      fake file — enough for the board to prove extracted columns render. */
  extracted?: Record<string, unknown>;
  /** The file's body text as the engine read it. Stored
      beside the columns, never as one — the mock keeps it here for the same
      reason the engine keeps it off `MountFile`. Absent for a file nothing
      could be read out of. */
  text?: string;
  /** The read stopped at its page or byte cap, so the text above is the front
      of the document and not the whole of it. */
  text_truncated?: boolean;
}
let mockMounts: MockMount[] = [{ id: "mount-finance", name: "finance-doc", globs: [] }];
const mockMountBindings: Record<string, string> = { "mount-finance": "~/Personal/Finance" };
/* ignore lists named before their mount exists — `.vault/mounts.json` can
   already carry one when a folder is mounted for the first time, and that is
   the only way an ignored file is absent from the board rather than greyed
   out on it (the engine keeps rows it has already indexed). */
const mockPendingIgnore = new Map<string, string[]>();
const mockMountIndex: Record<string, { scanned: string; files: MockMountFile[] }> = {};
/** Pictures in the mock vault whose text was read on this machine. Two, so a
    result set can hold more than one, and worded the way a screenshot of a
    receipt reads. */
const mockImages: { rel: string; text: string; truncated?: boolean }[] = [
  {
    rel: "Screenshots/invoice-4711.png",
    text: "Invoice 4711\nAcme Mastering GmbH\nTotal 19,00 EUR\nPaid 2026-03-04",
  },
  {
    rel: "Screenshots/studio-whiteboard.png",
    text: "Album order\n1. Halfway Signal\n2. Paper Weather\n3. Long Shore\nmixdown by Friday",
  },
];

const mockFolderFiles: {
  name: string;
  size: number;
  modified: string;
  extracted?: Record<string, unknown>;
  text?: string;
  text_truncated?: boolean;
}[] = [
  {
    name: "2026-01 Invoice Acme Mastering.pdf",
    size: 184211,
    modified: "2026-01-31 10:02",
    extracted: { pages: 2 },
    // read whole: two pages are well inside the engine's cap
    text: "Rechnung 2026-01\nAcme Mastering GmbH\nLeistung: Mastering von vier Titeln\nBetrag: 480,00 EUR",
  },
  { name: "2026-02 Invoice Acme Mastering.pdf", size: 186004, modified: "2026-02-27 09:41", extracted: { pages: 2 } },
  { name: "2026-03 Invoice Acme Mastering.pdf", size: 183557, modified: "2026-03-31 11:15", extracted: { pages: 2 } },
  { name: "2026-07 Rechnung Umbra.pdf", size: 92814, modified: "2026-07-02 14:48", extracted: { pages: 1 } },
  {
    name: "2025 Steuererklärung.pdf",
    size: 1204551,
    modified: "2026-05-11 16:22",
    extracted: { pages: 34, media_title: "Einkommensteuererklärung 2025" },
    // thirty-four pages, read to the cap: what a search covers here is the
    // opening, and the row has to say so
    text: "Einkommensteuererklärung 2025\nAngaben zur Person\nEinkünfte aus selbständiger Arbeit\nSonderausgaben und außergewöhnliche Belastungen",
    text_truncated: true,
  },
  { name: "2026-05 Kontoauszug.pdf", size: 88109, modified: "2026-06-03 08:30", extracted: { pages: 4 } },
  { name: "2026-06 Kontoauszug.pdf", size: 89012, modified: "2026-07-03 08:31", extracted: { pages: 4 } },
  { name: "Mietvertrag 2025.pdf", size: 245880, modified: "2025-11-20 13:05", extracted: { pages: 11 } },
  { name: "Versicherung Haftpflicht 2026.pdf", size: 154302, modified: "2026-01-04 12:00", extracted: { pages: 6 } },
  { name: "Depot Jahresabrechnung 2025.pdf", size: 301455, modified: "2026-02-14 09:12", extracted: { pages: 18 } },
  // not extractable: an image and a spreadsheet carry no columns, and their
  // rows stay blank in the extracted columns rather than dropping out
  { name: "Quittung Rondo Service.png", size: 488203, modified: "2026-04-19 17:40" },
  { name: "Ausgaben 2026.csv", size: 4210, modified: "2026-07-15 21:03" },
];
/** The other "disk": a folder of Ableton projects, which is what the second
    kind of mounted folder looks like. Nested one folder per set, with the
    dated copies Live writes beside each one — the rows an `ignore` list
    exists to keep off the board — and one bounce, so the audio columns and
    the project columns are on the same table at the same time. */
const mockProjectFiles: typeof mockFolderFiles = [
  {
    name: "Bleed Cycle/Bleed Cycle.als",
    size: 2841004,
    modified: "2026-08-11 22:14",
    extracted: {
      als_tempo: 132,
      als_key: "D# Minor",
      als_tracks: 24,
      als_version: "Ableton Live 12.1.5",
    },
    text: "Drums Sub Bass Vox Chops Granulator III Operator Reverb Serum",
  },
  {
    name: "Bleed Cycle/Backup/Bleed Cycle [2026-08-10 191204].als",
    size: 2794551,
    modified: "2026-08-10 19:12",
    extracted: { als_tempo: 132, als_tracks: 22, als_version: "Ableton Live 12.1.5" },
  },
  {
    name: "Bleed Cycle/Bleed Cycle rough.wav",
    size: 61204880,
    modified: "2026-08-11 22:31",
    extracted: { duration: 341, sample_rate: 48000, channels: 2 },
  },
  {
    name: "Nightwater/Nightwater.als",
    size: 1904221,
    modified: "2026-07-29 15:48",
    extracted: {
      als_tempo: 84.5,
      als_tracks: 11,
      als_version: "Ableton Live 11.3.13",
    },
    text: "Pad Field Recording Tape Delay Corpus Auto Filter",
  },
  {
    name: "Nightwater/Backup/Nightwater [2026-07-28 104402].als",
    size: 1880110,
    modified: "2026-07-28 10:44",
    extracted: { als_tempo: 84.5, als_tracks: 10, als_version: "Ableton Live 11.3.13" },
  },
];
/** Which folder a bound path is: the mock has two, and a mount shows the one
    it points at. Anything not obviously a project pool is the paper pile the
    seeded mount uses, so every existing spec keeps the disk it had. */
const mockDiskFor = (path?: string) =>
  path && /music|album|project/i.test(path) ? mockProjectFiles : mockFolderFiles;
/** Stand-in for the engine's content hash — the mock has no bytes to read, and
    every consumer only ever compares identities for equality. */
const mockIdentity = (name: string) => `id-${mockSanitizeFilename(name).toLowerCase()}`;
/** The mock's "disk", filtered the way `walk_folder_files` filters a real
    tree: the mount's globs decide what is included, its `ignore` list decides
    what is pruned — a pattern without a slash matching the file's own name at
    any depth, one with a slash matching the path relative to the root. */
function mockDiskFiles(globs: string[], ignore?: string[], path?: string): MockMountFile[] {
  const exts = globs.map((g) => g.trim().replace(/^\*/, "").toLowerCase()).filter(Boolean);
  const rx = (p: string) =>
    new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
  const ignored = (rel: string) =>
    (ignore ?? []).some((p) =>
      p.includes("/")
        ? rx(p).test(rel)
        : rel.split("/").some((segment) => rx(p).test(segment))
    );
  return mockDiskFor(path)
    .filter((f) => !exts.length || exts.some((e) => f.name.toLowerCase().endsWith(e)))
    .filter((f) => !ignored(f.name))
    .map((f) => ({
      rel: f.name,
      size: f.size,
      modified: f.modified,
      created: f.modified.slice(0, 10),
      identity: mockIdentity(f.name),
      missing: false,
      ...(f.extracted ? { extracted: f.extracted } : {}),
      ...(f.text ? { text: f.text } : {}),
      ...(f.text_truncated ? { text_truncated: true } : {}),
    }));
}
/** Mirrors Engine::scan_mount: match the prior index by identity first, then
    by relative path; anything the index knew and the scan didn't find is kept
    and flagged missing, never dropped — its sidecar keeps every annotation. */
function mockScanMount(mount: MockMount): MountScanStats {
  const prior = mockMountIndex[mount.id]?.files ?? [];
  const found = mockDiskFiles(mount.globs, mount.ignore, mockMountBindings[mount.id]);
  const claimed = new Set<MockMountFile>();
  const stats: MountScanStats = {
    id: mount.id,
    name: mount.name,
    scanned: found.length,
    added: 0,
    updated: 0,
    renamed: 0,
    missing: 0,
  };
  for (const f of found) {
    const was =
      prior.find((p) => !claimed.has(p) && p.identity && p.identity === f.identity) ??
      prior.find((p) => !claimed.has(p) && p.rel === f.rel);
    if (!was) {
      stats.added++;
      continue;
    }
    claimed.add(was);
    if (was.rel !== f.rel) stats.renamed++;
    else if (was.size !== f.size || was.modified !== f.modified || was.missing) stats.updated++;
  }
  const gone = prior.filter((p) => !claimed.has(p)).map((p) => ({ ...p, missing: true }));
  stats.missing = gone.length;
  mockMountIndex[mount.id] = {
    scanned: new Date().toISOString(),
    files: [...found, ...gone].sort((a, b) => a.rel.localeCompare(b.rel)),
  };
  return stats;
}
/* The seeded mount's index: everything on disk plus the one file the seeded
   sidecar points at, which is NOT there — so the board opens with a real
   missing row instead of needing a scan to produce one. */
mockMountIndex["mount-finance"] = {
  scanned: new Date().toISOString(),
  files: [
    ...mockDiskFiles([]),
    {
      rel: "2025-11 Invoice Old Vendor.pdf",
      size: 90210,
      modified: "2026-06-01 10:12",
      created: "2026-06-01",
      identity: mockIdentity("2025-11 Invoice Old Vendor.pdf"),
      missing: true,
      // last-known extraction survives the file going away, the same way the
      // rest of its row does — the index is what remembers
      extracted: { pages: 3 },
    },
  ].sort((a, b) => a.rel.localeCompare(b.rel)),
};

/* The Drive Shelf's mock: three external disks, one of each state the shelf
   exists to render honestly. "Backup Silver" is plugged in right now;
   "Sessions 2019" has been in a drawer for over a year and its catalog says
   so; "Sample Vault" was cataloged up to the cap, so it knows it is
   incomplete. They are ordinary mounts carrying a `volume` — the same thing
   the engine makes when a disk appears — which is why they answer
   `mounts_list` too. */
const MOCK_DRIVE_TREE: Record<string, [string, number][]> = {
  "drive-backup-silver": [
    ["Masters/2026/Glass Anchor - Meridian.wav", 412_336_044],
    ["Masters/2026/Glass Anchor - Meridian (instr).wav", 410_112_880],
    ["Masters/2026/Paper Kestrel - Low Tide.wav", 388_204_112],
    ["Masters/2025/Fieldnote FN-041 master.wav", 366_120_004],
    ["Masters/2025/Fieldnote FN-042 master.wav", 371_884_552],
    ["Photos/Studio/patchbay-rework.jpg", 6_114_200],
    ["Photos/Studio/500-series-rack.jpg", 5_880_144],
    ["Archive/taxes-2024.pdf", 2_204_880],
    ["Archive/label-contracts.pdf", 1_118_004],
    ["readme.txt", 812],
  ],
  "drive-sessions-2019": [
    ["Ableton/Kettle Drum Study/Kettle Drum Study.als", 24_118_004],
    ["Ableton/Kettle Drum Study/Samples/Recorded/kick-take-3.wav", 88_204_112],
    ["Ableton/Kettle Drum Study/Samples/Recorded/vox-take-1.wav", 122_336_044],
    ["Ableton/Glass Bridge/Glass Bridge.als", 18_884_552],
    ["Ableton/Glass Bridge/Samples/Recorded/bridge-loop.wav", 64_120_004],
    ["Stems/glass-bridge-stems.zip", 1_204_336_044],
    ["notes.txt", 1_204],
  ],
  "drive-sample-vault": [
    ["Libraries/Spectral/impacts/impact-001.wav", 4_118_004],
    ["Libraries/Spectral/impacts/impact-002.wav", 4_204_112],
    ["Libraries/Spectral/textures/texture-glass.wav", 12_336_044],
    ["Libraries/Granular/grains-metal.wav", 8_884_552],
    ["Libraries/Granular/grains-paper.wav", 7_120_004],
    ["Field/harbour-tunnel-2024.wav", 244_336_044],
  ],
};
const MOCK_DRIVES: MockMount[] = [
  {
    id: "drive-backup-silver",
    name: "Backup Silver",
    globs: [],
    volume: {
      id: "Backup Silver:4000787030016",
      label: "Backup Silver",
      total: 4_000_787_030_016,
      first_seen: "2024-11-02T09:14:00Z",
      last_seen: new Date(Date.now() - 4 * 60_000).toISOString(),
    },
  },
  {
    id: "drive-sessions-2019",
    name: "Sessions 2019",
    globs: [],
    volume: {
      id: "Sessions 2019:2000398934016",
      label: "Sessions 2019",
      total: 2_000_398_934_016,
      first_seen: "2019-04-18T11:02:00Z",
      last_seen: "2025-06-09T17:41:00Z",
    },
  },
  {
    id: "drive-sample-vault",
    name: "Sample Vault",
    globs: [],
    volume: {
      id: "Sample Vault:1000204886016",
      label: "Sample Vault",
      total: 1_000_204_886_016,
      first_seen: "2023-02-11T20:30:00Z",
      last_seen: "2026-07-30T08:55:00Z",
    },
  },
];
/** Files the last scan left out at the cap, per drive — the mock's stand-in
    for `MountIndex.capped`, and the reason one shelf row admits to being
    incomplete. */
const mockDriveCapped: Record<string, number> = { "drive-sample-vault": 47_318 };
mockMounts = [...mockMounts, ...MOCK_DRIVES];
/* Only the plugged-in one is bound: a drive in a drawer is a mount this
   machine has no path for, which is exactly the mount half already models. */
mockMountBindings["drive-backup-silver"] = "/Volumes/Backup Silver";
for (const d of MOCK_DRIVES) {
  mockMountIndex[d.id] = {
    scanned: d.volume!.last_seen,
    files: MOCK_DRIVE_TREE[d.id].map(([rel, size]) => ({
      rel,
      size,
      modified: d.volume!.last_seen.slice(0, 10),
      created: d.volume!.first_seen.slice(0, 10),
      // drives are identified by stat, not by hashing four terabytes
      identity: `stat:${size}:1750000000`,
      missing: false,
    })),
  };
}

/** One drive as `drives_list` returns it, totalled from its catalog. */
function mockDriveInfo(m: MockMount): DriveInfo {
  const index = mockMountIndex[m.id] ?? { scanned: "", files: [] };
  const live = mockMountIndex[m.id]?.files.filter((f) => !f.missing) ?? [];
  return {
    id: m.id,
    label: m.volume!.label,
    name: m.name,
    volume: m.volume!.id,
    total: m.volume!.total,
    first_seen: m.volume!.first_seen,
    last_seen: m.volume!.last_seen,
    scanned: index.scanned,
    files: live.length,
    bytes: live.reduce((n, f) => n + f.size, 0),
    capped: mockDriveCapped[m.id] ?? 0,
    online: Boolean(mockMountBindings[m.id]),
    ...(mockMountBindings[m.id] ? { path: mockMountBindings[m.id] } : {}),
  };
}
/** The shelf itself: online first, then by when each disk was last seen. */
const mockDrives = (): DriveInfo[] =>
  mockMounts
    .filter((m) => m.volume)
    .map(mockDriveInfo)
    .sort(
      (a, b) =>
        Number(b.online) - Number(a.online) || b.last_seen.localeCompare(a.last_seen)
    );
/** One level of a catalog, folders rolled up — mirrors Engine::drive_entries,
    which is what makes an unplugged disk browsable at all. */
function mockDriveEntries(id: string, prefix: string): DriveEntry[] {
  const at = prefix ? `${prefix}/` : "";
  const files: DriveEntry[] = [];
  const dirs = new Map<string, DriveEntry>();
  for (const f of mockMountIndex[id]?.files ?? []) {
    if (!f.rel.startsWith(at)) continue;
    const rest = f.rel.slice(at.length);
    const cut = rest.indexOf("/");
    if (cut < 0) {
      files.push({
        name: rest,
        rel: f.rel,
        dir: false,
        size: f.size,
        files: 1,
        modified: f.modified,
        ...(f.missing ? { missing: true } : {}),
      });
      continue;
    }
    const name = rest.slice(0, cut);
    const roll = dirs.get(name) ?? {
      name,
      rel: `${at}${name}`,
      dir: true,
      size: 0,
      files: 0,
      modified: "",
    };
    roll.size += f.size;
    roll.files += 1;
    dirs.set(name, roll);
  }
  return [...dirs.values(), ...files].sort(
    (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)
  );
}
/** "Which disk is this file on?" across every catalog, offline ones included
    — each hit carrying the age of the catalog it came out of. */
function mockDriveSearch(query: string): DriveHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: DriveHit[] = [];
  for (const m of mockMounts.filter((d) => d.volume)) {
    const online = Boolean(mockMountBindings[m.id]);
    for (const f of mockMountIndex[m.id]?.files ?? []) {
      if (!f.rel.toLowerCase().includes(q)) continue;
      hits.push({
        id: m.id,
        label: m.volume!.label,
        rel: f.rel,
        size: f.size,
        modified: f.modified,
        scanned: mockMountIndex[m.id]?.scanned ?? "",
        online,
        ...(f.missing ? { missing: true } : {}),
      });
    }
  }
  return hits
    .sort((a, b) => Number(b.online) - Number(a.online) || a.rel.localeCompare(b.rel))
    .slice(0, 200);
}
/** Volumes this machine was told not to catalog. Machine-local in the engine
    (app config), so machine-local here too — it never rides the vault. */
let mockDrivesIgnored: string[] = [];
/** Every sidecar bound to one mount, keyed by vault path — by the `mount`
    prop, not by folder, so a note filed elsewhere keeps working. */
const mockSidecarsOf = (id: string) => mockNotes.filter((n) => n.props["mount"] === id);
/** Mirrors Engine::make_excerpt (vault/mod.rs): the first non-empty line,
    stripped of leading markdown marks and wiki brackets, capped at 120 chars
    with an ellipsis when it ran longer. */
function mockExcerpt(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const clean = line.replace(/^[#>\-*\s]+/, "").replace(/\[\[|\]\]/g, "");
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
}
/** Mirrors Engine::mount_rows: index rows carrying their sidecar (identity
    first, then the recorded path), plus a row for every sidecar the index has
    never heard of — an annotation is never invisible. */
function mockMountRows(id: string): MountRow[] {
  const index = mockMountIndex[id]?.files ?? [];
  const sidecars = mockSidecarsOf(id);
  const used = new Set<MockNote>();
  const owned = new Set(["mount", "mount_file", "mount_identity", "type"]);
  const rowOf = (f: MockMountFile, note?: MockNote): MountRow => ({
    rel: f.rel,
    name: f.rel.split("/").pop() ?? f.rel,
    extension: (f.rel.split("/").pop() ?? "").split(".").slice(1).pop() ?? "",
    size: f.size,
    modified: f.modified,
    created: f.created,
    identity: f.identity,
    ...(f.missing ? { missing: true } : {}),
    ...(note ? { note: note.path } : {}),
    // the document's opening line as its preview, mirroring the
    // engine's make_excerpt — beside the columns, never one of them
    ...(f.text ? { excerpt: mockExcerpt(f.text) } : {}),
    ...(f.text && f.text_truncated ? { excerpt_partial: true } : {}),
    props: {
      ...(note ? Object.fromEntries(Object.entries(note.props).filter(([k]) => !owned.has(k))) : {}),
      // extracted last, exactly as Engine::row_of merges them: the file is the
      // source of truth for what it says about itself
      ...(f.extracted ?? {}),
    },
  });
  const rows = index.map((f) => {
    const note =
      (f.identity && sidecars.find((n) => !used.has(n) && n.props["mount_identity"] === f.identity)) ||
      sidecars.find((n) => !used.has(n) && n.props["mount_file"] === f.rel);
    if (note) used.add(note);
    return rowOf(f, note || undefined);
  });
  for (const n of sidecars) {
    if (used.has(n)) continue;
    rows.push(
      rowOf(
        {
          rel: String(n.props["mount_file"] ?? n.stem),
          size: 0,
          modified: "",
          created: "",
          identity: String(n.props["mount_identity"] ?? ""),
          missing: true,
        },
        n
      )
    );
  }
  return rows.sort((a, b) => a.rel.localeCompare(b.rel));
}
/** One mount as `mounts_list` returns it: the portable half plus what this
    machine knows. The mock's bound paths always exist, so `missing` is only
    ever true for a binding pointed somewhere the mock disk isn't. */
const mockMountInfo = (m: MockMount): MountInfo => ({
  id: m.id,
  name: m.name,
  globs: m.globs,
  ...(m.ignore?.length ? { ignore: m.ignore } : {}),
  ...(m.watch ? { watch: true } : {}),
  ...(mockMountBindings[m.id] ? { path: mockMountBindings[m.id] } : {}),
  missing: (mockMountBindings[m.id] ?? "").toLowerCase().includes("missing"),
  scanned: mockMountIndex[m.id]?.scanned ?? "",
  files: mockMountIndex[m.id]?.files.length ?? 0,
});
/* Mock `.vault/templates/`: type → template note. `release` and
   `event` have one, so the born-complete create demos both lanes — templated
   types (defaults + body skeleton) and schema-only types (empty chips).
   Explicit-path reads/writes under `.vault/templates/` reach this store like
   the real engine's hidden-path exception. */
const mockTemplates = mockRecord<{ props: Record<string, unknown>; body: string }>({
  release: {
    props: mockRecord({ status: "parked" }),
    body: "## Tracks\n\n- [ ] {{title}} — opener\n\n## Rollout\n\n- announced {{date}}\n- [ ] upload to Bandcamp\n",
  },
  event: {
    props: mockRecord({ location: "Studio" }),
    body: "## Agenda\n\n- [ ] {{title}} prep\n",
  },
});

/* Mock `.vault/kinds/`: custom kind bundles a spec staged. Empty
   until __mockWriteKind runs — a lane that never seeds one sees exactly the
   pre-kinds app. `files` holds the bundle text (kind.json included, since the
   hash covers it) because the mock pane loader reads source from here instead
   of the `substrate-kind:` scheme the browser doesn't have. */
const mockKinds: { row: KindBundleInfo; files: Record<string, string> }[] = [];

/* Mock Settings.md: the ⌘, sheet reads/writes the root settings
   note by path. In the real engine it's a normal indexed note; here it lives
   outside mockNotes — like the template store above — so the seeded list
   counts every spec asserts stay put (concealed by default,
   `vault_list` serves it so the reveal toggle can be exercised; only a spec
   that flips `show-agent-files` ever sees the row). Parity covers the
   read/set_prop IPC the settings sheet uses plus that list membership. */
const mockSettings: { props: Record<string, unknown>; body: string; updated_ms: number } = {
  // `number-locale` is pinned because the fixture has to be a vault that
  // CHOSE a dialect: a vault with no key follows the machine's own locale, so
  // without this every asserted `1.234,56` in the suite would read whichever
  // country the rig — or a developer's laptop — is set to.
  props: {
    "capture-hotkey": "alt+space",
    "close-to-tray": "false",
    "number-locale": "de-DE",
  },
  body: "Substrate settings — edit and save; changes apply within a second (⌘, opens the settings form).\n",
  // stable like the other seeds (a Date.now() here would float the row to the
  // top of every list once revealed); writes bump it like real notes
  updated_ms: now - 5 * 86_400_000,
};

function mockSettingsMeta(): NoteMeta {
  return {
    path: "Settings.md",
    stem: "Settings",
    title: "Settings",
    folder: "",
    props: { ...mockSettings.props },
    updated_ms: mockSettings.updated_ms,
    excerpt: mockMakeExcerpt(mockSettings.body),
    sealed: false,
  };
}

/* Mock database icons: stored separately and merged under each
   type's reserved `icon` key at read time — the same shape schema.json has
   on disk (SchemaConfig here stays the props-only view; the reserved key is
   a DbIcon, not a PropSchema, so the merge casts). Seeds demo all three
   kinds: tinted glyph, plain glyph, emoji. */
const mockIcons = mockRecord<DbIcon>({
  release: { glyph: "music", tint: "violet" },
  gear: { glyph: "wrench" },
  task: { emoji: "🎵" },
});

/* Mock database home folders: stored separately and merged under
   each type's reserved `home` key at read time, like the icons above. One
   seed — the task db lives in its Tasks/ folder — so the read path shows on
   boot; rename retargets, trash clears, like the engine. */
const mockHomes = mockRecord<string>({
  task: "Tasks",
});

/* Mock sub-item parent links: type → the relation prop naming a row's parent
   row, merged under the reserved `parent` key at read time like the homes
   above. Unset by default — a database only grows tree rows once its parent
   relation is marked. */
const mockParents = mockRecord<string>();

/** schema.json as the real backend serves it: props plus the reserved
    per-type `icon`, `home` and `parent` keys merged in (all three survive
    even when a type has no props configured). */
function mockSchemaRead(): SchemaConfig {
  const out = mockRecord<Record<string, unknown>>();
  for (const [type, props] of Object.entries(mockSchema)) {
    out[type] = mockRecord(JSON.parse(JSON.stringify(props)) as Record<string, unknown>);
  }
  for (const [type, icon] of Object.entries(mockIcons)) {
    (out[type] ??= mockRecord()).icon = { ...icon };
  }
  for (const [type, home] of Object.entries(mockHomes)) {
    (out[type] ??= mockRecord()).home = home;
  }
  for (const [type, parent] of Object.entries(mockParents)) {
    (out[type] ??= mockRecord()).parent = parent;
  }
  return out as SchemaConfig;
}

/** The stem of a `.vault/templates/<type>.md` path, null for any other path —
    mirrors the engine's template_rel exception. */
function templateStem(p: unknown): string | null {
  return /^\.vault\/templates\/([^/]+)\.md$/.exec(String(p ?? ""))?.[1] ?? null;
}

/** Mirrors Engine::make_excerpt (vault.rs): the first line that is non-empty
    after stripping leading `# > - * ` markup and [[ ]] brackets, trimmed and
    truncated to 120 chars with an ellipsis. The mock's one excerpt rule —
    create, template meta, and write_body all run through here. */
function mockMakeExcerpt(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.replace(/^[#>\-* ]+/, "").replace(/\[\[|\]\]/g, "").trim();
    if (t) return t.length > 120 ? `${t.slice(0, 120)}…` : t;
  }
  return "";
}

/** NoteMeta for a template path — the real engine builds it fresh from disk
    (unindexed): folder is the hidden dir, title the type stem. */
function templateMeta(
  stem: string,
  t: { props: Record<string, unknown>; body: string }
): NoteMeta {
  const excerpt = mockMakeExcerpt(t.body);
  return {
    path: `.vault/templates/${stem}.md`,
    stem,
    title: stem,
    folder: ".vault/templates",
    props: { ...t.props },
    updated_ms: Date.now(),
    excerpt,
    sealed: false,
  };
}

/* Trash mirrors the real `.trash/<deleted_ms>/<rel>` scheme: the note keeps
   its body so restore round-trips. Folder entries hold the whole subtree
   (`folderNotes` + `folderDirs`) — same unit restore as the engine. */
const mockTrash: (TrashEntry & {
  note?: MockNote;
  folderNotes?: MockNote[];
  folderDirs?: string[];
  folderSealScopes?: string[];
  /** which of those scopes were unconfirmed: the engine parks a marker and its
      (lack of) confirmation under `.trash/<id>/` together, so a restore must
      not quietly promote a planted marker to confirmed */
  folderSealUnconfirmed?: string[];
  /** asset entries: the base64 payload, so restore round-trips bytes */
  asset?: string;
  /** template entries: the template's content, so restore round-trips */
  template?: { props: Record<string, unknown>; body: string };
})[] = [];

// Phone-first vault sync — the git-backed feature, not a dashboard kind.
// This state mirrors VaultSyncState's last-result/last-error record and is
// page scoped, like the rest of the browser mock store.
// `conflicted` is not stored here: the engine derives it from the repository
// on every status call, so the mock derives it from the parked
// conflict state instead of from the last command's result.
let mockVaultSyncStatus: Omit<
  VaultSyncStatus,
  | "conflicted"
  | "privacy_error"
  | "privacy_paths"
  | "notice"
  | "remote_kind"
  | "remote_url"
  | "rewrite_blocked"
  | "replaced_store"
> = {
  // a returning device boots configured; a spec stages that with
  // addInitScript, before the app (and its auto-sync lane) mounts
  configured: window.__mockSyncConfigured === true,
  last_result: null,
  last_error: null,
};

/** Where the mock vault syncs to, kept OUTSIDE `mockVaultSyncStatus` because
    every command below replaces that record wholesale while the remote itself
    survives a push, a pull, and a failure alike — the engine reads it from
    `.git/config` on every status call. A device that boots configured boots on
    a plain Git remote; a `blob+` save moves it. */
let mockSyncRemote: { kind: RemoteKind; url: string | null } =
  window.__mockSyncConfigured === true
    ? { kind: "git", url: "https://sync.example.com/vault.git" }
    : { kind: "none", url: null };

/** What the engine puts where a remote URL's `user:password@` was, before the
    URL leaves for a screen. Engine parity matters here more than usual: the
    pane refills its URL field from the status URL, so a mock that handed back
    the credentials verbatim would let a redaction regression through
    unnoticed. */
const MOCK_REDACTED_USERINFO = "•••";

/** Strip `user:password@` from a remote URL, like `redact_url_userinfo` does:
    only the authority carries userinfo, so an `@` further down the path is a
    path character and survives. */
function mockRedactUserinfo(url: string | null): string | null {
  if (url === null) return null;
  const split = url.indexOf("://");
  if (split < 0) return url;
  const scheme = url.slice(0, split);
  const rest = url.slice(split + 3);
  const authorityEnd = rest.indexOf("/") < 0 ? rest.length : rest.indexOf("/");
  const authority = rest.slice(0, authorityEnd);
  const tail = rest.slice(authorityEnd);
  const at = authority.lastIndexOf("@");
  if (at < 0) return url;
  return `${scheme}://${MOCK_REDACTED_USERINFO}@${authority.slice(at + 1)}${tail}`;
}

/** The passphrase the SERVER's key document is wrapped under, or null when no
    hosted vault has ever been enrolled here. The mock cannot do Argon2, but it
    can hold the one fact the change flow turns on: which phrase is current.

    Server-side, deliberately: the engine's key document lives in the blob
    store and outlives any one device. Saving a plain remote drops this
    device's LOCAL copy of the key and nothing else — the ciphertext and the
    key document that opens it stay where they are, which is why coming back
    to the hosted remote is a join and not a fresh enrollment. */
let mockVaultKeyDocument: string | null = null;

/** Whether THIS device holds the vault key in its credential slot — the
    engine's `hosted_key_service` entry. Leaving the hosted transport clears
    it; re-enrolling under the current passphrase restores it. */
let mockVaultKeyHeldLocally = false;

/** The sticky privacy notice, kept OUTSIDE `mockVaultSyncStatus` for the same
    reason the engine keeps it outside `VaultSyncLast::error`: every command
    below replaces that record wholesale, and this warning is precisely the one
    a later success must not replace. Only an acknowledgement clears it. */
let mockPrivacyNotice: { message: string; paths: string[] } | null = null;

/** The hosted store's existing enrollment, when a test staged one. Null is an
    empty store: the first save mints a key and any credentials work, which is
    exactly what a first device sees. With one staged, the save has to join it,
    and the mock answers with the backend's own words — the token check fails
    at the key read, the passphrase check fails when the wrap will not open. */
let mockHostedVault: { token: string; passphrase: string } | null = null;

/** What the next push will find when it lists the hosted store: a warning that
    the store is approaching the number of objects one sync can work through,
    or nothing. Staged by a spec; read only by `vault_sync_push`. */
let mockSyncNotice: string | null = null;

/** A purge or trim rewrote this vault's history, so an end-to-end-encrypted
    remote refuses every leg until the server's copy is replaced. Kept OUTSIDE
    `mockVaultSyncStatus` because the engine reads it from the repository on
    every status call, and it outlives the commands that replace that record.
    Staged by a spec; only the replacement clears it. */
let mockRewriteBlocked = false;

/** The pause a replacement leaves on a device that consented to nothing.
    Outside `mockVaultSyncStatus` for the same reason as the marker above: the
    engine reads it from the repository on every status call, and it outlives
    the commands that replace that record. Staged by a spec; only adopting
    clears it. */
let mockReplacedStore: ReplacedStoreState | null = null;

/** Engine parity for the wording both the refusal and the adoption use: the
    cost this device carries, in the words the pane and the error share. */
function mockReplacedStoreCost(state: ReplacedStoreState): string {
  const snapshots =
    state.discarded_snapshots === null || state.discarded_snapshots === 0
      ? null
      : state.discarded_snapshots === 1
        ? "1 snapshot taken here"
        : `${state.discarded_snapshots} snapshots taken here`;
  if (snapshots && state.unsaved_edits) return `${snapshots}, and edits no snapshot holds yet`;
  if (snapshots) return snapshots;
  // Engine parity for the branch measuring against the replacement head made
  // reachable: a device the new history already contains carries no cost.
  return state.unsaved_edits === false
    ? "nothing the server's history is missing"
    : "edits no snapshot holds yet";
}

/** Engine parity: the notice opens the cost as a sentence, the refusal folds
    it into one. */
function mockCapitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function mockReplacedStorePause(state: ReplacedStoreState): string {
  return (
    "hosted sync is paused: another device rewrote this vault's history (a purge or trim) and " +
    "published it over the copy on the server, and this device holds work that new history has " +
    `no line to: ${mockReplacedStoreCost(state)}. Adopting the server's history, from the Vault ` +
    "sync pane, discards that work and starts sync again."
  );
}

/** The sticky half, kept OUTSIDE `mockVaultSyncStatus` for the same reason the
    privacy notice is: every command below replaces that record wholesale, and
    the auto lane pulls every few minutes. Engine parity — only the push leg
    writes this slot, and only a push finding the store back under the
    threshold clears it. */
let mockStoreNotice: string | null = null;

/** What the next `vault_sync_pull` does. The seed default stays conflicted
    so the existing sync-pane specs keep their three-way material; a spec
    that needs a clean pull (the auto-sync lane's steady state) stages one. */
let mockPullPlan: { conflicted: boolean; changed?: string[] } = window.__mockBootPull ?? {
  conflicted: true,
};

/** Sync commands run, in order — the observable the auto-sync specs assert
    on, since the lane's whole job is firing (or not firing) these. */
const mockSyncCalls: string[] = [];

/** A parked conflicted pull, in the shape gitsync::sync_conflicts returns.
    Rebuilt whenever the mock pull conflicts, so the resolution surface has
    real three-way material to render without a Rust backend. */
function mockConflictSeed(): ConflictState {
  const side = (present: boolean, text: string | null, oid: string): ConflictSide => ({
    present,
    text,
    oid,
    mode: present ? 0o100644 : 0,
  });
  return {
    active: true,
    head: "91c0f17ab4d2",
    remote: "4a7f22e0c8d1",
    resolved: 0,
    files: [
      {
        path: "Journal/2026-07-22.md",
        base: side(true, "---\nmood: ok\n---\n\nMorning pages.\n", "aaa1111"),
        ours: side(
          true,
          "---\nmood: focused\n---\n\nMorning pages.\nFinished the sync spike on the Mac.\n",
          "bbb2222",
        ),
        theirs: side(
          true,
          "---\nmood: tired\n---\n\nMorning pages.\nJotted the sync idea on the phone.\n",
          "ccc3333",
        ),
        diff: [
          { kind: "hunk", text: "@@ -1,5 +1,5 @@" },
          { kind: "ctx", text: "---" },
          { kind: "del", text: "mood: focused" },
          { kind: "add", text: "mood: tired" },
          { kind: "ctx", text: "---" },
          { kind: "ctx", text: "" },
          { kind: "ctx", text: "Morning pages." },
          { kind: "del", text: "Finished the sync spike on the Mac." },
          { kind: "add", text: "Jotted the sync idea on the phone." },
        ],
        props: [
          { key: "mood", base: "ok", ours: "focused", theirs: "tired" },
        ],
        resolution: null,
        both_path: "Journal/2026-07-22 (conflict 2026-07-22).md",
      },
      {
        path: "Projects/Release plan.md",
        base: side(true, "---\nstatus: draft\n---\n\nShip in August.\n", "ddd4444"),
        ours: side(true, "---\nstatus: active\n---\n\nShip in August.\nCut the beta on the 12th.\n", "eee5555"),
        theirs: side(
          true,
          "---\nstatus: active\nowner: Ada\n---\n\nShip in August.\nCut the beta on the 9th.\n",
          "fff6666",
        ),
        diff: [
          { kind: "hunk", text: "@@ -1,5 +1,6 @@" },
          { kind: "ctx", text: "---" },
          { kind: "ctx", text: "status: active" },
          { kind: "add", text: "owner: Ada" },
          { kind: "ctx", text: "---" },
          { kind: "ctx", text: "" },
          { kind: "ctx", text: "Ship in August." },
          { kind: "del", text: "Cut the beta on the 12th." },
          { kind: "add", text: "Cut the beta on the 9th." },
        ],
        props: [{ key: "owner", base: null, ours: null, theirs: "Ada" }],
        resolution: null,
        both_path: "Projects/Release plan (conflict 2026-07-22).md",
      },
    ],
  };
}

let mockConflicts: ConflictState = { active: false, head: "", remote: "", files: [], resolved: 0 };

function mockConflictView(): ConflictState {
  const view = structuredClone(mockConflicts);
  // engine parity: gitsync::sync_conflicts sorts `path ASC` before
  // returning (gitsync.rs, `files.sort_by(|a, b| a.path.cmp(&b.path))`), and
  // conflict_paths collects into a BTreeSet, so both lists arrive sorted.
  // The seed happens to be alphabetical; sorting here means it stays parity
  // even if someone appends a file out of order. Sort the COPY — resolve_set
  // finds by path in `mockConflicts`, whose own order must stay put.
  view.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return view;
}

/** Engine semantics: a live note re-seeds as a fresh v1; an off-disk path
    (trashed/deleted) loses its snapshots outright. Unknown paths no-op. */
function mockPurgeHistory(path: string) {
  const n = mockNotes.find((m) => m.path === path);
  if (n) {
    mockHistory.set(n.path, [
      { id: `snap${++mockSnapSeq}`, ts_ms: Date.now(), subject: "snapshot", body: n.body },
    ]);
  } else {
    mockHistory.delete(path);
  }
}

function mockFoldedKey<T>(obj: Record<string, T>, want: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(obj, want)) return want;
  const folded = want.toLowerCase();
  return Object.keys(obj).find((key) => key.toLowerCase() === folded);
}

function mockPropKey(props: Record<string, unknown>, want: string): string | undefined {
  return mockFoldedKey(props, want);
}

function mockPropString(props: Record<string, unknown>, want: string): string | undefined {
  const key = mockPropKey(props, want);
  const value = key === undefined ? undefined : props[key];
  return typeof value === "string" ? value : undefined;
}

/** Every database type the mock knows: schema keys ∪ note `type` values —
    mirrors Engine::known_types. */
function mockKnownTypes(): Set<string> {
  const out = new Set<string>(Object.keys(mockSchema));
  for (const n of mockNotes) {
    const t = mockPropString(n.props, "type");
    if (typeof t === "string" && t.trim()) out.add(t.trim());
  }
  return out;
}

/** Mirrors Engine::check_type_name: non-empty, outside the reserved
    `$`/`dashboard` namespace, no case-insensitive clash with a *different*
    type or sanitized template identity (`allow` exempts the old folded type
    for case-only renames). */
function mockCheckTypeName(name: string, allow: string | null) {
  if (!name) throw new Error("database name cannot be empty");
  if (name.startsWith("$")) throw new Error("database names cannot start with $");
  if (name.toLowerCase() === "dashboard") throw new Error("“dashboard” is a reserved name");
  const lower = name.toLowerCase();
  for (const t of mockKnownTypes()) {
    if (allow !== null && t.toLowerCase() === allow.toLowerCase()) continue;
    if (t.toLowerCase() === lower) {
      throw new Error(`a database named “${t}” already exists`);
    }
    if (mockSanitizeFilename(t).toLowerCase() === mockSanitizeFilename(name).toLowerCase())
      throw new Error(
        `database “${name}” would share template file “${mockSanitizeFilename(name)}.md” with “${t}”`
      );
  }
  if (mockTemplateNamesForIdentity(name).length > 1)
    throw new Error(`template identity “${mockSanitizeFilename(name)}.md” is ambiguous`);
}

/** Mirrors sanitize_filename (vault.rs): illegal filename chars become
    spaces, whitespace runs collapse to one, empty falls back to "Untitled".
    Create and rename both run titles through this so they always agree. */
function mockSanitizeFilename(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
}

function mockTemplateNamesForIdentity(noteType: string): string[] {
  const identity = mockSanitizeFilename(noteType).toLowerCase();
  return Object.keys(mockTemplates).filter((name) => name.toLowerCase() === identity);
}

/** Template ownership is intentionally fail-closed. Distinct database names
    that sanitize to one stem are a legacy ambiguity, not permission for
    either database to move or delete the shared file. */
function mockExistingTemplateName(noteType: string): string | undefined {
  const identity = mockSanitizeFilename(noteType).toLowerCase();
  if (
    [...mockKnownTypes()].some(
      (known) =>
        known.toLowerCase() !== noteType.toLowerCase() &&
        mockSanitizeFilename(known).toLowerCase() === identity
    )
  )
    return undefined;
  const matches = mockTemplateNamesForIdentity(noteType);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Mirrors validate_note_title (vault.rs): a dot-stem would land
    the note outside the index and `[`/`]` would corrupt every rewritten
    link — refuse before any mutation, in create and rename alike. */
function mockValidateNoteTitle(title: string, slug: string) {
  if (slug.startsWith(".")) throw new Error("titles cannot start with a dot");
  if (title.includes("[") || title.includes("]"))
    throw new Error("titles cannot contain [ or ]");
  // the engine's third refusal: a control char isn't
  // whitespace, so it survives the slug collapse and only fails at the
  // filesystem. Same Cc set as Rust char::is_control: C0, DEL, C1.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(slug))
    throw new Error("titles cannot contain control characters");
}

/** Ages the mock history reports for the windowed facts, keyed
    `path#lowercased prop` — days since a person set the value, or `null` for
    a value no person is recorded behind. Anything absent here keeps the
    mock's ordinary "set a few hours ago". */
const mockFactAges: Record<string, { days: number | null; onlyBulk?: boolean }> = {
  "Gero.md#phone": { days: 500 },
  "Gero.md#email": { days: 80 },
  "Noa.md#email": { days: 200 },
  "Tess Almeida.md#phone": { days: 30 },
  // an import wrote it and nobody has looked since: counted, never listed
  "Tess Almeida.md#email": { days: null, onlyBulk: true },
  "Annelies Verbeek.md#email": { days: 95 },
};

/** newest-first, ties broken by id — engine parity: the Rust
    registries are HashMaps, so `runs()` sorts `started_ms DESC` then `id ASC`
    to keep same-millisecond runs from swapping between polls. Array-stable
    order here would agree only by luck. */
function byStartedThenId<T extends { started_ms: number; id: string }>(a: T, b: T): number {
  return b.started_ms - a.started_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}



/* Feed-curator mock: the feed dashboard's refresh button. One run
   at a time like the Rust bridge; a run completes MOCK_CURATOR_RUN_MS after
   it starts, and completion does what a real curator does through the fs —
   prepends a fresh row to the News Items sheet, bumps News.md's `curated:`
   stamp, and lets the (mock) watcher carry the change into the UI. */
interface MockCuratorRun {
  id: string;
  state: string;
  started_ms: number;
  finished_ms: number | null;
  summary: string | null;
  error: string | null;
  /** mock-only: wall-clock when the running entry completes on the tick */
  finishAt?: number;
}
const mockCuratorRuns: MockCuratorRun[] = [];
let mockCuratorSeq = 0;
const MOCK_CURATOR_RUN_MS = 1_500;

/** what the agent's fs writes look like from inside the mock vault */
function mockCuratorLand() {
  const day = new Date();
  const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const sheet = mockNotes.find((n) => n.path === "News Items.md");
  const changed: string[] = [];
  if (sheet) {
    const row = `${iso},plugins,"Freshly curated: GrainFrame 2 public beta",CDM,https://cdm.link/example/grainframe,"Granular resynthesis with spectral masking.","Curated by the refresh you just clicked.",`;
    sheet.body = sheet.body.replace(/(```csv\ndate,topic,title,source,url,blurb,why,fb\n)/, `$1${row}\n`);
    sheet.updated_ms = Date.now();
    changed.push(sheet.path);
  }
  const dash = mockNotes.find((n) => n.path === "Dashboards/News.md");
  if (dash) {
    const hh = String(day.getHours()).padStart(2, "0");
    const mm = String(day.getMinutes()).padStart(2, "0");
    dash.props = { ...dash.props, curated: `${iso} ${hh}:${mm}` };
    dash.updated_ms = Date.now();
    changed.push(dash.path);
  }
  // the real change arrives via the OS watcher, not a command echo
  window.__mockEmit?.("vault:changed", changed.sort());
}

/** close out a running curation past its finishAt; linger like the bridge */
function mockCuratorTick() {
  const t = Date.now();
  for (const r of mockCuratorRuns) {
    if (r.state !== "running" || r.finishAt === undefined) continue;
    if (t >= r.finishAt) {
      r.state = "done";
      r.finished_ms = t;
      r.summary = "curated 1 item";
      mockCuratorLand();
    }
  }
  for (let i = mockCuratorRuns.length - 1; i >= 0; i--) {
    const f = mockCuratorRuns[i].finished_ms;
    if (f !== null && t - f > 60 * 60_000) mockCuratorRuns.splice(i, 1);
  }
}

/* Opt-in fidelity flags, both OFF by default. Like the rest
   of the mock's state they are page-load scoped — a spec's page.goto starts
   fresh, so no cross-spec reset plumbing is needed. */
let mockEchoOnWrites = false;
// false | "timeout" (random 1–25ms reorder) | "microtask" (
// resolves before React's scheduled re-render, like production thread-pool
// IPC can — the ordering the restore race loses on)
let mockAsyncDispatch: false | "timeout" | "microtask" = false;
// instrumentation: opt-in command trace (null = off)
type MockTraceEntry = {
  ms: number;
  cmd: string;
  path?: string;
  bodyTail?: string;
  expectedNull?: boolean;
  /** create-time props, as the caller passed them — what a spec asserting
      "the note was filed WITH its context" (or without) has to see */
  props?: [string, string][];
  /** a capture's page-title flag, as the caller passed it — the seam a spec
      asserting "the switch reached the command" has to see */
  enrich?: boolean;
  doneMs?: number;
  ok?: boolean;
  err?: string;
};
let mockCmdTrace: MockTraceEntry[] | null = null;
let mockCmdTraceT0 = 0;
// commands parked open until their release fn runs — the in-flight
// IPC a spec needs to still be pending while it navigates elsewhere
const mockHeldCommands = new Map<string, Promise<void>>();
const mockHoldReleases = new Map<string, () => void>();
/* per-command artificial latency, in ms. The hold map above parks a
   command until a spec releases it; this one makes a command simply SLOW, so
   an optimistic paint can be asserted while the write is still in flight and
   the write still lands by itself. Empty by default — no spec, no cost. */
const mockLatency = new Map<string, number>();
/* one-shot refusals, per command, counted down as calls are made.
   __mockFail is a STANDING set: with three writes to the same cell in flight
   it refuses all three, which can't express "the slow first write comes back
   refused after the user already retyped". */
const mockFailOnce = new Map<string, number>();

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
const WATCHED_WRITE_COMMANDS = new Set([
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
function scheduleMockEcho(paths: string[] | null) {
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

/** The rel paths a completed command changed on disk, or `null` when its reach
    isn't nameable from the call (a folder op sweeps every note under it, a
    rescan touches whatever it stamped). Real and mock commands return the same
    shapes, so this serves both: the mock echoes these paths as its watcher
    event, and the app records them as its own write. `null` means
    "we wrote, can't say where", which is what the engine's own unknown-payload
    emit means too. */
function writtenPathsFor(
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
function mockRescanChanged(result: unknown): boolean {
  return (
    Array.isArray(result) &&
    result.some((s: MountScanStats) => s.added + s.updated + s.renamed + s.missing > 0)
  );
}

/* Engine parity: both search commands cap their result set, so the
   mock must too — otherwise "search truncates" is untestable and a mock-mode
   query over a large database returns a list production would never produce.
   `vault_search`: `LIMIT 30` (vault.rs:2572, and `.take(30)` on the non-FTS
   fallback). `vault_search_full`: `LIMIT FULL_SEARCH_MAX_NOTES` = 200
   (vault.rs:94, :2636).

   Ordering is a deterministic stand-in, not an approximation of the engine's
   score. The engine sorts by FTS5 `rank` (BM25) and its no-FTS fallback
   returns raw map order (vault.rs:2688, :2712), so there is no single contract
   to copy, and re-implementing BM25 here would be a second scoring engine to
   keep in step that still wouldn't agree. What a spec needs is that order is a
   property of the MATCH rather than of the fixture array — insertion order
   passes just as happily against a backwards ranker. So: title matches before
   body-only ones, then the earliest match offset, then path ascending so two
   equal notes never swap between runs. Both commands rank the full match set
   and cap afterwards — capping first would truncate by insertion order and
   then rank only the survivors. */
const SEARCH_MAX_HITS = 30;
const FULL_SEARCH_MAX_NOTES = 200;

/** The word runs a text splits into, the way the FTS tokenizer sees it:
    alphanumeric runs, lowercased, punctuation dropped, accents folded — the
    index is built with `remove_diacritics 2`, so "cafe" and "café" are one
    word to it and have to be here too. */
function mockSearchWords(s: string): string[] {
  return foldDiacritics(s.toLowerCase()).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Does `field`'s run sequence contain `runs` consecutively, with the last run
    matched as a prefix? The engine quotes every whitespace query token
    (fts_match_expr), so `bc-2025q4-00352` is the prefix PHRASE `bc 2025q4
    00352*` rather than one opaque word — a plain token is just a one-run
    phrase, and a punctuation-only token has no runs and so matches nothing. */
function mockHasPhrase(field: string[], runs: string[]): boolean {
  if (runs.length === 0) return false;
  const last = runs.length - 1;
  for (let i = 0; i + last < field.length; i++) {
    let ok = true;
    for (let j = 0; j < last; j++)
      if (field[i + j] !== runs[j]) {
        ok = false;
        break;
      }
    if (ok && field[i + last].startsWith(runs[last])) return true;
  }
  return false;
}

/** Char offset of the first word-start match of any token, or `Infinity`.
    `starts` is the matcher's own word-boundary class, so each command ranks
    by exactly the rule it filtered with. Both sides fold, like the index: a
    note that matched on "café" ranks by where that word sits, instead of
    falling to the bottom as an offset-less miss. */
function mockFirstHit(text: string, tokens: string[], starts: string): number {
  if (tokens.length === 0) return Infinity;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const { folded, map } = foldWithMap(text);
  const m = new RegExp(
    `(?<!${starts})(?:${tokens.map((t) => esc(foldDiacritics(t))).join("|")})`,
    "iu",
  ).exec(folded);
  return m ? map[m.index] : Infinity;
}

/** Sort key for both mock search commands — see the note above. */
function mockRank(a: MockSearchRank, b: MockSearchRank): number {
  if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
  if (a.offset !== b.offset) return a.offset - b.offset;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The frontmatter prop VALUES a note is searchable by — the engine's
    props_search_text twin: scalars (strings, numbers, bools) + their lists,
    space-joined; keys, `type`, `title` and `notion_id` stay out (the last is
    hidden from every surface, so a hit on it is a result the user cannot see
    the reason for). Objects and nested lists stay out — nothing renders them. */
function mockPropsSearchText(props: Record<string, unknown>): string {
  const out: string[] = [];
  const scalar = (v: unknown) =>
    typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  for (const [k, v] of Object.entries(props)) {
    const kl = k.toLowerCase();
    if (kl === "type" || kl === "title" || kl === "notion_id") continue;
    if (scalar(v)) out.push(String(v));
    else if (Array.isArray(v)) for (const item of v) if (scalar(item)) out.push(String(item));
  }
  return out.join(" ");
}

type MockSearchRank = { titleHit: boolean; offset: number; path: string };

function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  // a one-shot refusal is claimed HERE, when the call is made — not
  // where __mockFail is read, which is after the latency gate. With three
  // writes to one cell in flight, "the first one is refused" is only
  // expressible if the refusal binds in call order.
  if (mockFailOnce.get(cmd)) {
    mockFailOnce.set(cmd, mockFailOnce.get(cmd)! - 1);
    const wait = mockLatency.get(cmd);
    const fail = () => {
      // engine parity: a sync leg that fails writes the reason into the status
      // record, where it stays until a later leg succeeds — without it the mock
      // forgets a failed push the moment the pane re-reads the status, and a
      // retry after a failure cannot be told from a first attempt
      if (cmd === "vault_sync_push" || cmd === "vault_sync_pull")
        mockVaultSyncStatus = { ...mockVaultSyncStatus, last_error: `mock failure: ${cmd}` };
      return Promise.reject(new Error(`mock failure: ${cmd}`));
    };
    return wait ? mockDelay(wait).then(fail) : fail();
  }
  // instrumentation: an opt-in ring of write-lane commands plus the
  // FX request seam, with args and outcomes. No effect unless a spec installed
  // the trace hook; including FX lets privacy regressions prove call counts,
  // and the two hand-off commands let a spec prove a row action reached the OS
  // seam — the opening itself happens outside the app, where nothing can look.
  if (
    mockCmdTrace &&
    (/^vault_(write_body|rename|create|read)$/.test(cmd) ||
      cmd === "fx_rates" ||
      cmd === "url_capture" ||
      cmd === "file_open" ||
      cmd === "file_reveal")
  ) {
    const entry: MockTraceEntry = {
      ms: Date.now() - mockCmdTraceT0,
      cmd,
      path: typeof args?.path === "string" ? args.path : undefined,
      bodyTail:
        typeof args?.body === "string" ? (args.body as string).slice(-40) : undefined,
      expectedNull: args && "expectedBody" in args ? args.expectedBody === null : undefined,
      props: Array.isArray(args?.props) ? (args.props as [string, string][]) : undefined,
      enrich: typeof args?.enrich === "boolean" ? args.enrich : undefined,
    };
    mockCmdTrace.push(entry);
    return mockInvokeTraced(cmd, args, entry);
  }
  // an explicitly held command waits for its release before running
  const held = mockHeldCommands.get(cmd);
  if (held) return held.then(() => mockInvoke(cmd, args));
  // …and a slowed one waits out its latency first
  const wait = mockLatency.get(cmd);
  if (wait) return mockDelay(wait).then(() => mockDispatchAfterLatency(cmd, args));
  // both flags off: straight dispatch — resolution timing byte-identical to
  // the pre-flag mock (the whole suite's baseline is the blast-radius proof)
  if (!mockAsyncDispatch && !mockEchoOnWrites) return mockDispatch(cmd, args);
  return mockInvokeFidelity(cmd, args);
}


/** the tail of mockInvoke, past the hold and latency gates — kept
    separate so the latency path can't re-enter its own gate. */
function mockDispatchAfterLatency(
  cmd: string,
  args?: Record<string, unknown>
): Promise<unknown> {
  if (!mockAsyncDispatch && !mockEchoOnWrites) return mockDispatch(cmd, args);
  return mockInvokeFidelity(cmd, args);
}

const mockDelay = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// instrumentation: run the traced command through the normal pipeline
// (hold gate + fidelity flags untouched) and record how it ended.
async function mockInvokeTraced(
  cmd: string,
  args: Record<string, unknown> | undefined,
  entry: MockTraceEntry
): Promise<unknown> {
  const held = mockHeldCommands.get(cmd);
  if (held) await held;
  const wait = mockLatency.get(cmd);
  if (wait) await mockDelay(wait);
  try {
    const r =
      !mockAsyncDispatch && !mockEchoOnWrites
        ? await mockDispatch(cmd, args)
        : await mockInvokeFidelity(cmd, args);
    entry.doneMs = Date.now() - mockCmdTraceT0;
    entry.ok = true;
    return r;
  } catch (err) {
    entry.doneMs = Date.now() - mockCmdTraceT0;
    entry.ok = false;
    entry.err = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

async function mockInvokeFidelity(
  cmd: string,
  args?: Record<string, unknown>
): Promise<unknown> {
  // opt-in: real IPC handlers run on a thread pool — completion is
  // never synchronous and back-to-back commands carry no ordering guarantee.
  // "timeout" defers execution by a small random delay so ordering-sensitive
  // flows (the write-then-rename class) can actually race.
  // "microtask" defers only to a microtask: still never synchronous,
  // but fast enough to resolve before React's scheduled re-render — the
  // production ordering behind the restore race, which the random timeout
  // loses to (React's render wins and the stale remount is masked).
  if (mockAsyncDispatch === "timeout") {
    await new Promise<void>((resolve) =>
      window.setTimeout(resolve, 1 + Math.random() * 24)
    );
  } else if (mockAsyncDispatch === "microtask") {
    await Promise.resolve();
  }
  const result = await mockDispatch(cmd, args);
  // opt-in: echo a completed note mutation like the engine watcher.
  // Template paths are excluded even for the write commands (watcher-blind).
  if (
    mockEchoOnWrites &&
    WATCHED_WRITE_COMMANDS.has(cmd) &&
    !templateStem(args?.path) &&
    (cmd !== "mount_rescan" || mockRescanChanged(result))
  ) {
    scheduleMockEcho(writtenPathsFor(cmd, args, result));
  }
  return result;
}

async function mockDispatch(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  // e2e hook: a spec-listed command rejects, reaching the UI error
  // surfaces (boot-error bar, save-failed pill, capture error) that an
  // always-succeeding mock leaves untestable
  if (window.__mockFail?.has(cmd)) throw new Error(`mock failure: ${cmd}`);
  const find = () => mockNotes.find((n) => n.path === args?.path);
  switch (cmd) {
    case "vault_root":
      return mockVaultRoot;

    /* first-run onboarding. The mock vault always exists, so the
       no-vault state is staged by the spec through __mockSetFirstRun. */
    case "onboarding_status":
      return {
        first_run: mockFirstRun,
        root: mockVaultRoot,
        suggested: "/Users/demo/Vault",
        config_path:
          "/Users/demo/Library/Application Support/substrate/config.json",
        env_pinned: false,
      };
    case "vault_inspect": {
      const path = String(args?.path ?? "");
      // deterministic fixtures, keyed by what the path says it is — the mock
      // has no filesystem to inspect. `is_vault` is the backend's STRICT
      // answer (.vault/ or ≥2 top-level .md): a checkout carrying one stray
      // README.md is not a vault, so it reaches the consent step instead of
      // opening silently (review).
      const isVault = /vault/i.test(path) && !/new|fresh|empty|checkout/i.test(path);
      const exists = !/new|fresh|missing/i.test(path);
      return {
        path,
        exists,
        is_vault: isVault,
        empty: !exists || /empty/i.test(path),
        // a folder-organised notes vault — markdown only in
        // subfolders — still needs consent but earns the friendlier wording
        nested_markdown: exists && /obsidian|nested/i.test(path),
        // `.vault/` already on disk — a returning Substrate vault,
        // where the add-set line would be false. A folder of loose notes
        // (`two-notes`) reads as a vault too but has no marker, so adopting it
        // really does write the set.
        has_marker: isVault && !/two-notes|loose/i.test(path),
      };
    }
    case "vault_choose": {
      const path = String(args?.path ?? "");
      if (!path.trim()) throw new Error("no folder chosen");
      // mirrors the backend refusal: a non-empty non-vault folder needs consent
      if (/downloads/i.test(path) && !args?.consent) {
        throw new Error(`${path} already holds other files — confirm initializing a vault here`);
      }
      mockVaultRoot = path;
      mockFirstRun = false;
      return path;
    }
    case "vault_demo":
      if (typeof window !== "undefined" && (window as Window).__mockNoDemoVault) {
        // mirrors the backend: nothing bundled is an error, not an empty vault
        throw new Error(
          "This build has no demo vault bundled. Create a new vault or open an existing folder instead."
        );
      }
      mockVaultRoot = "/Users/demo/Documents/Substrate Demo";
      mockFirstRun = false;
      return mockVaultRoot;
    case "onboarding_set_agent": {
      // mirrors the backend: writes only into the vault just chosen; empty =
      // skip. Specs read the recorded command back via __mockAgentCommand.
      if (!mockVaultRoot || mockFirstRun) throw new Error("no vault chosen yet");
      mockAgentCommand = String(args?.command ?? "").trim();
      return null;
    }
    case "app_relaunch":
      // a browser mock cannot restart a process; specs assert the call landed
      mockRelaunched = true;
      return null;
    // the mock is a browser, which has no share extension behind it — the
    // hook's whole lane stays disarmed, exactly as on desktop
    case "share_capture_supported":
      return false;
    case "share_capture_sweep":
      return { landed: 0, quarantined: 0 };
    case "widget_summary_supported":
      return false;
    case "widget_configured_ids":
      return [];
    case "widget_summary_write":
      return null;

    case "mcp_grants_list":
      return mockMcpGrants.map((grant) => ({ ...grant }));
    case "mcp_grant_pick": {
      const client = String(args?.client ?? "").trim();
      const access = args?.access === "write" ? "write" : "read";
      if (!client) throw new Error("client name must not be empty");
      const prefix = "Projects";
      const existing = mockMcpGrants.find(
        (grant) => grant.client === client && grant.prefix === prefix
      );
      if (existing) existing.access = access;
      else mockMcpGrants.push({ client, prefix, access });
      return mockMcpGrants.map((grant) => ({ ...grant }));
    }
    case "mcp_grant_revoke":
      mockMcpGrants = mockMcpGrants.filter(
        (grant) =>
          !(grant.client === args?.client && grant.prefix === args?.prefix)
      );
      return mockMcpGrants.map((grant) => ({ ...grant }));
    case "mcp_grants_revoke_all":
      mockMcpGrants = [];
      return [];
    case "mcp_last_seen":
      // The demo backend fakes a door that has already been talked to, like it
      // fakes an installed sidecar — a fixed stamp so specs can assert on it.
      return { name: "Claude Desktop", at: "2026-01-01T09:00:00+01:00" };
    case "mcp_setup": {
      const binary = "/Applications/Substrate.app/Contents/MacOS/substrate-mcp";
      return {
        binary_path: binary,
        binary_available: true,
        client_config_path:
          "/Users/demo/Library/Application Support/Claude/claude_desktop_config.json",
        claude_desktop_snippet: JSON.stringify(
          { mcpServers: { substrate: { command: binary } } },
          null,
          2
        ),
      };
    }
    case "vault_list":
      // Settings.md is indexed like the real engine indexes it —
      // the App-side app-file filter is what conceals it by default
      return [...mockNotes.map(meta), mockSettingsMeta()].sort(
        (a, b) => b.updated_ms - a.updated_ms
      );
    case "vault_sealed_configured":
      return mockSealedPassword !== null;
    case "vault_seal_scopes":
      return [...mockSealScopes]
        .sort()
        .map((path) => ({
          path,
          state: mockPendingSealScopes.has(path) ? ("pending" as const) : ("active" as const),
          confirmed: !mockUnconfirmedSealScopes.has(path),
        }));
    case "vault_seal_scope": {
      const scope = String(args?.path ?? "").replace(/^[/\\]+|[/\\]+$/g, "");
      if (scope && !mockFolders.has(scope)) throw new Error("folder not found");
      if (mockSealScopes.has(scope)) throw new Error("this location already has a persistent seal");
      const password = typeof args?.password === "string" ? args.password : null;
      if (mockSealedPassword === null) {
        if (!password) throw new Error("choose a vault password first");
        if (password.length < MOCK_MIN_SEALED_PASSWORD)
          throw new Error(
            `password must be at least ${MOCK_MIN_SEALED_PASSWORD} characters — this file syncs to your remotes, where an attacker can grind it offline`,
          );
        mockSealedPassword = password;
      } else if (password && password !== mockSealedPassword) {
        throw new Error("wrong vault password");
      }
      mockSealScopes.add(scope);
      let sealed = 0;
      let already_sealed = 0;
      for (const n of mockNotes) {
        if (!mockScopeApplies(n.path)) continue;
        if (n.sealed) already_sealed += 1;
        else {
          n.sealed = true;
          sealed += 1;
        }
        mockUnlockedSealed.delete(n.path);
      }
      // the files are already ciphertext; only the history rewrite failed, so
      // the marker stays pending exactly as the engine leaves it
      if (mockSealStaysPending()) {
        mockPendingSealScopes.add(scope);
        throw new Error(
          "the files are encrypted, but the persistent seal is still pending because old plaintext history could not be removed: version history is unavailable; restart or retry after repairing history"
        );
      }
      return { path: scope, sealed, already_sealed, device_unlock: mockDeviceUnlock };
    }
    // accepting a marker this device did not write: the same conversion the
    // seal command runs, gated on the vault password / device unlock
    case "vault_confirm_seal_scope": {
      const scope = String(args?.path ?? "").replace(/^[/\\]+|[/\\]+$/g, "");
      if (!mockSealScopes.has(scope)) throw new Error("this location has no seal marker");
      if (!mockUnconfirmedSealScopes.has(scope))
        throw new Error("this seal is already confirmed on this device");
      const password = typeof args?.password === "string" ? args.password : null;
      if (mockSealedPassword === null) {
        if (!password) throw new Error("choose a vault password first");
        if (password.length < MOCK_MIN_SEALED_PASSWORD)
          throw new Error(
            `password must be at least ${MOCK_MIN_SEALED_PASSWORD} characters — this file syncs to your remotes, where an attacker can grind it offline`,
          );
        mockSealedPassword = password;
      } else if (password && password !== mockSealedPassword) {
        throw new Error("wrong vault password");
      }
      mockUnconfirmedSealScopes.delete(scope);
      let sealed = 0;
      let already_sealed = 0;
      for (const n of mockNotes) {
        if (!mockScopeApplies(n.path)) continue;
        if (n.sealed) already_sealed += 1;
        else {
          n.sealed = true;
          sealed += 1;
        }
        mockUnlockedSealed.delete(n.path);
      }
      if (mockSealStaysPending()) {
        mockPendingSealScopes.add(scope);
        throw new Error(
          "the files are encrypted, but the persistent seal is still pending because old plaintext history could not be removed: version history is unavailable; restart or retry after repairing history"
        );
      }
      return { path: scope, sealed, already_sealed, device_unlock: mockDeviceUnlock };
    }
    case "vault_remove_seal_scope": {
      const scope = String(args?.path ?? "").replace(/^[/\\]+|[/\\]+$/g, "");
      if (!mockSealScopes.has(scope)) throw new Error("this location has no seal marker");
      // Both guards are about opting out of a seal this device applied. For an
      // unconfirmed marker this call *is* the reject action: there is no
      // conversion of ours to finish, and deleting a marker that was never
      // applied opts out of nothing. The engine skips them the same way, so
      // rejecting a planted marker inside a sealed folder must succeed here
      // too — otherwise the denial-of-service half of the attack has no spec.
      if (!mockUnconfirmedSealScopes.has(scope)) {
        if (mockPendingSealScopes.has(scope))
          throw new Error("finish the pending seal conversion before removing it");
        if (
          scope &&
          [...mockSealScopes].some(
            (outer) =>
              outer !== scope &&
              (outer === "" || scope.startsWith(`${outer}/`)) &&
              // an ancestor that enforces nothing wins nothing
              !mockUnconfirmedSealScopes.has(outer)
          )
        ) {
          throw new Error("a sealed ancestor wins; remove that outer seal first");
        }
      }
      mockSealScopes.delete(scope);
      mockPendingSealScopes.delete(scope);
      mockUnconfirmedSealScopes.delete(scope);
      return null;
    }
    case "vault_seal_note": {
      const n = find();
      if (!n) throw new Error("not found");
      if (n.sealed) throw new Error("note is already sealed");
      const password = typeof args?.password === "string" ? args.password : null;
      if (mockSealedPassword === null) {
        if (!password) throw new Error("choose a vault password first");
        if (password.length < MOCK_MIN_SEALED_PASSWORD)
          throw new Error(
            `password must be at least ${MOCK_MIN_SEALED_PASSWORD} characters — this file syncs to your remotes, where an attacker can grind it offline`,
          );
        mockSealedPassword = password;
      } else if (password && password !== mockSealedPassword) {
        throw new Error("wrong vault password");
      }
      n.sealed = true;
      mockUnlockedSealed.delete(n.path);
      n.updated_ms = Date.now();
      return { meta: meta(n), device_unlock: mockDeviceUnlock };
    }
    case "vault_unlock_sealed_note": {
      const n = find();
      if (!n?.sealed) throw new Error("note is not sealed");
      const password = typeof args?.password === "string" ? args.password : null;
      if (password !== null && password !== mockSealedPassword) throw new Error("wrong vault password");
      // no password = the device-key lane; without a stored key it refuses and
      // the dialog falls back to the vault password
      if (password === null && (!mockDeviceUnlock || mockSealedPassword === null))
        throw new Error("Touch ID or device unlock was cancelled or unavailable");
      mockUnlockedSealed.add(n.path);
      return { body: n.body, props: n.props };
    }
    case "vault_lock_sealed_note":
      mockUnlockedSealed.delete(String(args?.path ?? ""));
      return null;
    case "vault_unseal_note": {
      const n = find();
      if (!n?.sealed) throw new Error("note is not sealed");
      if (!mockUnlockedSealed.has(n.path)) throw new Error("sealed: locked");
      if (mockScopeApplies(n.path)) {
        throw new Error(
          "this note inherits a persistent seal; remove or move it outside that scope first"
        );
      }
      n.sealed = false;
      mockUnlockedSealed.delete(n.path);
      n.updated_ms = Date.now();
      return meta(n);
    }
    case "vault_read": {
      const stem = templateStem(args?.path);
      if (stem) {
        const t = mockTemplates[stem];
        if (!t) throw new Error("not found");
        return JSON.parse(JSON.stringify({ body: t.body, props: t.props }));
      }
      if (args?.path === "Settings.md") {
        return JSON.parse(JSON.stringify({ body: mockSettings.body, props: mockSettings.props }));
      }
      const n = find();
      if (!n) throw new Error("not found");
      if (n.unreadable) throw new Error("permission denied");
      if (n.sealed && !mockUnlockedSealed.has(n.path)) throw new Error("sealed: locked");
      return { body: n.body, props: n.props };
    }
    case "vault_fm_raw": {
      const n = find();
      if (!n) throw new Error("not found");
      if (n.fmUnterminated)
        return { raw: "", error: "never closed", repairable: false };
      if (n.fm === undefined) return null;
      return { raw: n.fm, error: mockFmDiagnosis(n.fm), repairable: true };
    }
    case "vault_fm_write": {
      // mirrors Engine::fm_write: a missing file errors (never resurrects),
      // a still-broken block is refused by its bare diagnosis, a fence line
      // would leak into the body, empty fm removes the block
      const n = find();
      if (!n) throw new Error("note no longer exists");
      const fm = (args?.fm as string).replace(/[\r\n]+$/, "");
      if (fm.trim()) {
        const fault = mockFmDiagnosis(fm);
        if (fault) throw new Error(fault);
        if (fm.split("\n").some((l) => l.trimEnd() === "---"))
          throw new Error("block contains a --- fence line");
      }
      n.props = fm.trim() ? mockFmProps(fm) : {};
      if (fm.trim()) n.fm = fm;
      else delete n.fm;
      n.updated_ms = Date.now();
      return meta(n);
    }
    case "vault_write_body": {
      const stem = templateStem(args?.path);
      const expectedBody = (args?.expectedBody as string | null) ?? null;
      if (stem) {
        // creates the template when missing, like the real engine
        const t = (mockTemplates[stem] ??= { props: mockRecord(), body: "" });
        // mirrors the engine's conflict guard
        if (expectedBody !== null && t.body !== expectedBody) {
          throw new Error("conflict: file changed on disk");
        }
        t.body = args?.body as string;
        return templateMeta(stem, t);
      }
      if (args?.path === "Settings.md") {
        const expected = (args?.expectedBody as string | null) ?? null;
        if (expected !== null && mockSettings.body !== expected) {
          throw new Error("conflict: file changed on disk");
        }
        mockSettings.body = args?.body as string;
        mockSettings.updated_ms = Date.now();
        return mockSettingsMeta();
      }
      const n = find();
      // mirrors the engine's rule: a missing file is never resurrected
      if (!n) throw new Error("note no longer exists");
      if (expectedBody !== null && n.body !== expectedBody) {
        throw new Error("conflict: file changed on disk");
      }
      n.body = args?.body as string;
      n.updated_ms = Date.now();
      // mirrors the engine's write_body → reindex_one → make_excerpt: lists
      // show the fresh excerpt after an edit, not the stale one
      n.excerpt = mockMakeExcerpt(n.body);
      return meta(n);
    }
    case "vault_set_prop": {
      const key = args?.key as string;
      const value = args?.value as PropValue;
      // mirrors Engine::set_prop_guarded: `expected` present means
      // check, and its `value` is what the caller believes is on disk (null =
      // "expected absent"). A mismatch refuses the write, store untouched.
      const expected = args?.expected as { value: PropValue } | null | undefined;
      // mirrors the engine's write-domain match: strings, numbers, bools,
      // string lists, null. Anything else is refused there, so refuse here —
      // a mock that accepts more than the engine turns e2e into a lane that
      // proves nothing (the class of blind spot).
      if (Array.isArray(value)) {
        if (!value.every((v) => typeof v === "string")) throw new Error("list values must be strings");
      } else if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
        throw new Error("property values must be strings, numbers, bools, or string lists");
      }
      const guard = (props: Record<string, unknown>) => {
        const prior = (props[key] ?? null) as PropValue;
        if (expected && !mockPropEq(prior, expected.value))
          throw new Error("conflict: property changed on disk");
        return prior;
      };
      // mirrors Engine::set_prop_value: null or an empty list removes
      const apply = (props: Record<string, unknown>) => {
        if (value === null || (Array.isArray(value) && value.length === 0)) delete props[key];
        else props[key] = value;
      };
      const stem = templateStem(args?.path);
      if (stem) {
        const t = mockTemplates[stem];
        if (!t) throw new Error("not found");
        const prior = guard(t.props);
        apply(t.props);
        return { meta: templateMeta(stem, t), prior };
      }
      if (args?.path === "Settings.md") {
        const prior = guard(mockSettings.props);
        apply(mockSettings.props);
        mockSettings.updated_ms = Date.now();
        return { meta: mockSettingsMeta(), prior };
      }
      const n = find();
      if (!n) throw new Error("not found");
      // mirrors parse_props_for_write: a present-but-broken block
      // refuses every prop edit until the repair lane fixes it
      if (n.fmUnterminated)
        throw new Error(
          `frontmatter in ${n.path} is never closed — fix it in the editor before editing properties`,
        );
      if (n.fm !== undefined) {
        const fault = mockFmDiagnosis(n.fm);
        if (fault) throw new Error(mockFmRefusal(n.path, fault));
      }
      const prior = guard(n.props);
      apply(n.props);
      // the engine re-serializes the block from the map — keep fm in step
      if (n.fm !== undefined) {
        const ser = mockFmSerialize(n.props);
        if (ser === undefined) delete n.fm;
        else n.fm = ser;
      }
      n.updated_ms = Date.now();
      return { meta: meta(n), prior };
    }
    case "sheet_set_column_notify": {
      // mirrors Engine::set_sheet_column_notify: a nested `columns:`
      // map, both the map key and the column name keeping whatever spelling is
      // already on disk, the lead clamped to 1..365, and an entry that says
      // nothing removed — as is the map once its last entry goes.
      const column = ((args?.column as string) ?? "").trim();
      if (!column) throw new Error("column name is required");
      const notify = args?.notify === true;
      const rawLead = args?.notifyBefore as number | null | undefined;
      const lead =
        typeof rawLead === "number" && rawLead > 0
          ? Math.min(365, Math.max(1, Math.trunc(rawLead)))
          : null;
      const n = find();
      if (!n) throw new Error("not found");
      const mapKey =
        Object.keys(n.props).find((k) => k.toLowerCase() === "columns") ?? "columns";
      const map = { ...((n.props[mapKey] as Record<string, unknown> | undefined) ?? {}) };
      const colKey = Object.keys(map).find((k) => k.toLowerCase() === column.toLowerCase()) ?? column;
      if (!notify && lead === null) delete map[colKey];
      else {
        const entry: Record<string, unknown> = {};
        if (notify) entry.notify = true;
        if (lead !== null) entry.notifyBefore = lead;
        map[colKey] = entry;
      }
      // `n.fm` is deliberately left alone: the mock's serializer only writes
      // scalars and lists, so re-emitting it here would flatten the map
      if (Object.keys(map).length === 0) delete n.props[mapKey];
      else n.props[mapKey] = map;
      n.updated_ms = Date.now();
      return meta(n);
    }
    case "vault_create": {
      // mirrors Engine::create_full: the title is filename-sanitized first,
      // then the create-time filename dedupe is scoped to the target folder —
      // Idea.md, Idea 2.md, Idea 3.md… — and case-insensitive like the
      // engine's exists-check on a case-insensitive filesystem. The note's
      // title/stem follow the deduped filename (create writes no `title:` prop)
      const rawTitle = (args?.title as string) ?? "Untitled";
      const title = mockSanitizeFilename(rawTitle);
      // mirrors Engine::create_full's guard
      mockValidateNoteTitle(rawTitle, title);
      const folder = (args?.folder as string) ?? "Inbox";
      const noteType = (args?.noteType as string | null) ?? null;
      const extraProps = (args?.props as [string, string][] | null) ?? [];
      const seenProps = new Set<string>();
      for (const [rawKey] of extraProps) {
        const key = rawKey.trim();
        if (!key || isSystemPropName(key)) continue;
        const identity = key.toLowerCase();
        if (seenProps.has(identity)) throw new Error(`duplicate property “${key}”`);
        seenProps.add(identity);
      }
      let path = folder ? `${folder}/${title}.md` : `${title}.md`;
      let i = 2;
      while (mockNotes.some((m) => m.path.toLowerCase() === path.toLowerCase()))
        path = folder ? `${folder}/${title} ${i++}.md` : `${title} ${i++}.md`;
      const stem = path.slice(folder ? folder.length + 1 : 0, -".md".length);
      const body = (args?.body as string | null) ?? "";
      const n: MockNote = {
        path,
        stem,
        title: stem,
        folder,
        props: noteType ? { type: noteType, created: day(0) } : { created: day(0) },
        updated_ms: Date.now(),
        excerpt: "",
        body,
      };
      mockAddFolder(folder);
      // extra create-time props: schema-default chips + template
      // defaults; created/type/title stay engine-owned like in vault.rs
      for (const [k, v] of extraProps) {
        const key = k.trim();
        if (!key || isSystemPropName(key)) continue;
        n.props[key] = v;
      }
      n.excerpt = mockMakeExcerpt(body);
      mockNotes.push(n);
      mockEnforceSealScope(n);
      return meta(n);
    }
    case "vault_template_read": {
      const stored = mockExistingTemplateName(((args?.noteType as string) ?? "").trim());
      const t = stored ? mockTemplates[stored] : undefined;
      return t ? JSON.parse(JSON.stringify(t)) : null;
    }
    case "vault_template_list":
      return Object.keys(mockTemplates).sort();
    // Custom kinds are vault-resident code served through a real
    // Tauri scheme; the mock lane has neither, so bundles exist only when a
    // spec stages them through __mockWriteKind — an unseeded lane
    // still answers "none installed". Enable/disable move the in-memory
    // consent record only: no consent file appears anywhere.
    case "kinds_list":
      return mockKinds.map((k) => JSON.parse(JSON.stringify(k.row)) as KindBundleInfo);
    case "kinds_enable": {
      const k = mockKinds.find((b) => b.row.id === args?.id);
      if (!k) throw new Error(`no kind bundle "${String(args?.id)}"`);
      if (String(args?.hash) !== k.row.hash) {
        throw new Error(
          "this kind's files changed since you looked at them — review it again before enabling",
        );
      }
      // the standing rider survives the overwrite, exactly as it does in Rust:
      // it exists for the case where the code DID change.
      const trustUpdates = k.row.record?.trustUpdates === true;
      k.row.record = {
        hash: String(args?.hash ?? k.row.hash),
        api: KIND_API,
        enabledAt: new Date().toISOString(),
        ...(trustUpdates ? { trustUpdates: true } : {}),
      };
      return null;
    }
    case "kinds_set_trust": {
      // a rider on an existing consent, never a way to grant one — no record,
      // nothing to write, and the resulting state is the same either way
      const k = mockKinds.find((b) => b.row.id === args?.id);
      if (k?.row.record) {
        if (args?.trust) k.row.record.trustUpdates = true;
        else delete k.row.record.trustUpdates;
      }
      return null;
    }
    case "kinds_disable": {
      const k = mockKinds.find((b) => b.row.id === args?.id);
      if (k) delete k.row.record;
      return null;
    }
    // Reflexes need a real vault watcher to FIRE, which the mock
    // lane does not have — but the consent switch is a pure frontend decision
    // and is driven here for real. No rules file by default, which is what the
    // settings section hides itself on; `__mockStageReflexesFile` puts one
    // there, and the enable/pause calls move the same state the status arm
    // reports back.
    case "reflexes_status":
      return {
        enabled: mockReflexes.enabled,
        paused: mockReflexes.paused,
        enabledAt: mockReflexes.enabled ? "2026-01-01" : null,
        filePaused: mockReflexes.filePaused,
        hasFile: mockReflexes.hasFile,
        error: null,
        rules: mockReflexes.hasFile
          ? [
              {
                id: "file-drafts",
                event: "note.created",
                path: "Inbox/*",
                actions: ["move to Drafts"],
                enabled: true,
                dryRun: false,
                autoPaused: false,
                lastFired: null,
                lastError: null,
                suppressed: 0,
              },
            ]
          : [],
        invalid: [],
      };
    case "recall_status":
      return {
        enabled: mockRecall.enabled,
        indexing: false,
        commits: mockRecall.indexed ? 1284 : 0,
        blobs: mockRecall.indexed ? 3907 : 0,
        versions: mockRecall.indexed ? 4416 : 0,
        bytes: mockRecall.indexed ? 5_412_864 : 0,
        indexed: mockRecall.indexed,
      };
    case "recall_set_enabled": {
      mockRecall.enabled = Boolean(args?.enabled);
      // off deletes the store, exactly as the real command does
      if (!mockRecall.enabled) mockRecall.indexed = false;
      return mockInvoke("recall_status", {});
    }
    case "recall_index":
      mockRecall.indexed = true;
      return mockInvoke("recall_status", {});
    case "recall_search": {
      const q = String(args?.q ?? "").trim().toLowerCase();
      if (!mockRecall.enabled || !mockRecall.indexed || !q) {
        return { groups: [], truncated: false };
      }
      const groups = MOCK_RECALL_PAST.filter((v) => v.text.toLowerCase().includes(q)).map((v) => ({
        path: v.path,
        versions: [
          {
            oid: v.oid,
            first_id: v.first_id,
            first_ts_ms: v.first_ts_ms,
            last_id: v.last_id,
            last_ts_ms: v.last_ts_ms,
            deleted: v.deleted,
            matches: [
              {
                line: v.line,
                parts: mockSnippetParts(v.text, q),
              },
            ],
            total: 1,
          },
        ],
        total_versions: 1 + v.older,
        first_ts_ms: v.first_ts_ms,
        last_ts_ms: v.last_ts_ms,
        deleted: v.deleted,
      }));
      return { groups, truncated: false };
    }
    case "reflexes_receipts":
      return [];
    case "reflexes_enable":
      mockReflexes.enabled = true;
      mockReflexes.paused = false;
      return null;
    case "reflexes_set_paused":
      mockReflexes.paused = Boolean((args as { paused?: boolean }).paused);
      return null;
    case "reflexes_disable":
      mockReflexes.enabled = false;
      mockReflexes.paused = false;
      return null;
    // the mock lane never reaches the network: it answers with the same
    // historical rate the fixtures carry, so e2e baselines stay stable
    case "fx_usd_eur":
      return { usdEur: MOCK_FX.usdEur, asOf: MOCK_FX.asOf };
    case "fx_rates":
      return { base: MOCK_FX_RATES.base, rates: { ...MOCK_FX_RATES.rates }, asOf: MOCK_FX_RATES.asOf };
    case "calendar_feeds_read": {
      const enabled = mockCalendarFeeds.filter((feed) => feed.enabled);
      return {
        feeds: mockCalendarFeeds.map((feed) => ({
          ...feed,
          fetchedAt: Math.floor(Date.now() / 1000),
          error: null,
          cached: true,
        })),
        events: enabled.map((feed, i) => ({
          id: `${feed.url}:mock-${i}`,
          feedUrl: feed.url,
          feedName: feed.name,
          tint: feed.tint,
          title: `${feed.name} appointment`,
          startDay: day(i + 1),
          startTime: "10:00",
          endDay: day(i + 1),
          endTime: "11:00",
          allDay: false,
          location: null,
        })),
        refreshing: false,
        configError: null,
      };
    }
    case "calendar_feed_save": {
      const feed = args?.feed as CalendarFeedConfig;
      if (!feed?.url?.trim() || !feed?.name?.trim()) throw new Error("Calendar address and name are required.");
      const original = (args?.originalUrl as string | null) ?? null;
      if (original) {
        const index = mockCalendarFeeds.findIndex((item) => item.url === original);
        if (index < 0) throw new Error("Calendar subscription no longer exists.");
        mockCalendarFeeds[index] = { ...feed };
      } else {
        if (mockCalendarFeeds.some((item) => item.url === feed.url))
          throw new Error("That calendar is already subscribed.");
        mockCalendarFeeds.push({ ...feed });
      }
      queueMicrotask(() => window.__mockEmit?.("calendar:feeds-changed"));
      return structuredClone(mockCalendarFeeds);
    }
    case "calendar_feed_delete": {
      const url = String(args?.url ?? "");
      mockCalendarFeeds = mockCalendarFeeds.filter((feed) => feed.url !== url);
      queueMicrotask(() => window.__mockEmit?.("calendar:feeds-changed"));
      return structuredClone(mockCalendarFeeds);
    }
    case "calendar_feeds_refresh":
      queueMicrotask(() => window.__mockEmit?.("calendar:feeds-changed"));
      return null;
    // never uploads: a deterministic id keeps the send-dialog e2e stable,
    // and the same shape guards the real command enforces are mirrored so
    // the mock refuses what the engine would refuse
    case "share_upload": {
      const relay = ((args?.relayUrl as string) ?? "").trim();
      if (!/^https?:\/\//i.test(relay)) throw new Error("bad url");
      const expiry = (args?.expiry as string) ?? "";
      if (!["burn", "1d", "7d", "30d"].includes(expiry)) throw new Error(`unknown expiry (${expiry})`);
      const b64 = (args?.payloadB64 as string) ?? "";
      // decode the real first bytes — a base64-prefix check covers only 3 of
      // the 4 magic bytes and would accept payloads the engine rejects
      let magic = "";
      try {
        magic = atob(b64.slice(0, 8)).slice(0, 4);
      } catch {
        throw new Error("bad payload encoding");
      }
      if (magic !== "SBH1") throw new Error("not a sealed handoff payload");
      return "mock-handoff-id-0001";
    }
    case "url_capture": {
      const url = ((args?.url as string) ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) links can be captured");
      const display = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
      const slug =
        display.replace(/[/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
      // mirrors Engine::create_reference's guard
      mockValidateNoteTitle(display, slug);
      let path = `Inbox/${slug}.md`;
      let i = 2;
      while (mockNotes.some((m) => m.path === path)) path = `Inbox/${slug} ${i++}.md`;
      const n: MockNote = {
        path,
        stem: slug,
        title: display,
        folder: "Inbox",
        props: { created: day(0), type: "reference", url, ...(display !== slug ? { title: display } : {}) },
        updated_ms: Date.now(),
        excerpt: "",
        body: "",
      };
      mockNotes.push(n);
      mockEnforceSealScope(n);
      // `net-link-titles: false` skips the enrichment fetch — the
      // note stays exactly as captured. Mirrors url_capture's `enrich` flag,
      // so the mock can't pass a case the real engine would refuse to.
      // The seal lands first either way: a captured link inside a sealed
      // scope must not sit in plaintext waiting for a fetch that never comes.
      if (args?.enrich === false) return meta(n);
      // simulate the polite background fetch: title + description arrive late
      window.setTimeout(() => {
        if (!mockNotes.includes(n) || n.title !== display) return;
        const host = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/:]/)[0];
        n.title = `Fetched page title (${host})`;
        n.props["title"] = n.title;
        if (!n.body.trim()) {
          n.body = "Mock description fetched from og:description.\n";
          n.excerpt = mockMakeExcerpt(n.body);
        }
        n.updated_ms = Date.now();
      }, 900);
      return meta(n);
    }
    case "vault_rename": {
      const n = find();
      if (!n) throw new Error("not found");
      if (n.sealed && !mockUnlockedSealed.has(n.path))
        throw new Error("unlock the sealed note before renaming it");
      const renamedFrom = n.path;
      const title = ((args?.title as string) ?? "").trim();
      if (!title) throw new Error("title cannot be empty");
      const slug = mockSanitizeFilename(title);
      // mirrors Engine::rename's guard — before any link rewrite
      mockValidateNoteTitle(title, slug);
      const newPath = n.folder ? `${n.folder}/${slug}.md` : `${slug}.md`;
      // case-insensitive like the engine's new_abs.exists() check on a
      // case-insensitive filesystem (and like mock vault_create's dedupe):
      // "Beta"→"ALPHA" collides with an existing "Alpha.md"; a case-only
      // rename of the note itself stays allowed
      if (
        newPath.toLowerCase() !== n.path.toLowerCase() &&
        mockNotes.some((m) => m.path.toLowerCase() === newPath.toLowerCase())
      ) {
        throw new Error(`a note named “${slug}” already exists here`);
      }
      const oldNames = [n.title.toLowerCase(), n.stem.toLowerCase()];
      // mirrors Engine::rename: only relation props aimed at this note's
      // type follow the rename
      const renamedType = (mockPropString(n.props, "type") ?? "").toLowerCase();
      // mirrors Engine::rename_tracked: every note the sweep actually rewrote,
      // the renamed one included, named by where it lands
      const rewritten = new Set<MockNote>();
      for (const m of mockNotes) {
        // mirrors Engine::rename — ![[…]] embeds name assets, stay untouched
        const before = m.body;
        m.body = m.body.replace(/!?\[\[([^[\]]+)\]\]/g, (whole, inner) => {
          if (whole.startsWith("!")) return whole;
          // only the target moves; the anchor and the author's display text
          // ride along untouched
          const { target, anchor, alias } = parseWikiLink(String(inner));
          if (!oldNames.includes(target.toLowerCase())) return whole;
          return `[[${title}${anchor ? `#${anchor}` : ""}${alias ? `|${alias}` : ""}]]`;
        });
        if (m.body !== before) rewritten.add(m);
      }
      // mirrors Engine::relation_rewrites: schema'd relation props follow too
      for (const m of mockNotes) {
        const t = mockPropString(m.props, "type");
        const schemaKey = typeof t === "string" ? mockFoldedKey(mockSchema, t) : undefined;
        const props = schemaKey ? mockSchema[schemaKey] : undefined;
        if (!props) continue;
        for (const [key, ps] of Object.entries(props)) {
          if (ps.kind !== "relation") continue;
          // a prop aimed at another database names a DIFFERENT note that
          // happens to share the title; untargeted props have no declared
          // scope and still follow any rename
          const psTarget = (ps.type ?? "").toLowerCase();
          if (renamedType && psTarget && psTarget !== renamedType) continue;
          const actualKey = mockPropKey(m.props, key);
          if (!actualKey) continue;
          const v = m.props[actualKey];
          if (typeof v === "string" && oldNames.includes(v.trim().toLowerCase())) {
            m.props[actualKey] = title;
            rewritten.add(m);
          } else if (Array.isArray(v)) {
            const next = v.map((x) =>
              typeof x === "string" && oldNames.includes(x.trim().toLowerCase()) ? title : x
            );
            if (next.some((x, i) => x !== v[i])) rewritten.add(m);
            m.props[actualKey] = next;
          }
        }
      }
      mockMoveSidebarPin(n.path, newPath);
      mockMoveSidebarKeys(n.path, newPath);
      n.path = newPath;
      n.stem = slug;
      n.title = title;
      if (slug === title) delete n.props["title"];
      else n.props["title"] = title;
      n.updated_ms = Date.now();
      // a path change is an authorization boundary — the destination reopens
      // locked, like Engine::rename_tracked
      mockUnlockedSealed.delete(renamedFrom);
      mockUnlockedSealed.delete(newPath);
      // post-move paths, renamed note first — same shape as RenameResult
      const touched = [n.path, ...[...rewritten].filter((m) => m !== n).map((m) => m.path)];
      return { meta: meta(n), touched };
    }
    case "vault_delete":
      return mockTrashNote(String(args?.path ?? ""), Date.now());
    /* mirrors Engine::trash_many — ONE stamp for the whole selection,
       so the group shares a deleted_ms and vault_trash_list's `deleted_ms
       DESC, path ASC` orders it by path. Per-note Date.now() let a millisecond
       boundary fall mid-loop under load and split the group. Result shape
       matches the Rust Vec<Result<..>> serde form, in argument order. */
    case "vault_delete_many": {
      const paths = (args?.paths as string[]) ?? [];
      const at = Date.now();
      return paths.map((p) => {
        try {
          return { Ok: mockTrashNote(p, at) };
        } catch (e) {
          return { Err: e instanceof Error ? e.message : String(e) };
        }
      });
    }
    case "vault_delete_folder": {
      // mirrors Engine::trash_folder: the subtree leaves the live vault and
      // lists as ONE folder entry; restore brings it all back at once
      const rel = ((args?.path as string) ?? "").replace(/^[/\\]+|[/\\]+$/g, "");
      if (!rel) throw new Error("cannot trash the vault root");
      if (!mockFolders.has(rel)) throw new Error("folder not found");
      const inside = (p: string) => p === rel || p.startsWith(`${rel}/`);
      const folderNotes: MockNote[] = [];
      for (let i = mockNotes.length - 1; i >= 0; i--) {
        if (inside(mockNotes[i].folder)) folderNotes.unshift(...mockNotes.splice(i, 1));
      }
      const folderDirs = [...mockFolders].filter(inside);
      const folderSealScopes = [...mockSealScopes].filter(inside);
      const folderSealUnconfirmed = [...mockUnconfirmedSealScopes].filter(inside);
      for (const scope of folderSealScopes) {
        mockSealScopes.delete(scope);
        mockPendingSealScopes.delete(scope);
        mockUnconfirmedSealScopes.delete(scope);
      }
      for (const d of folderDirs) mockFolders.delete(d);
      // trashing drops the folder's meta keys (engine move_folder_meta)
      for (const k of Object.keys(mockFolderMeta)) {
        if (inside(k)) delete mockFolderMeta[k];
      }
      // …and clears schema homes pointing into the subtree — the db goes
      // homeless (engine move_schema_homes)
      for (const [t, h] of Object.entries(mockHomes)) {
        if (inside(h)) delete mockHomes[t];
      }
      // …and drops the subtree from the sidebar root-folder order (engine
      // move_sidebar_folders)
      if (mockSidebarOrder.folders) {
        mockSidebarOrder = {
          ...mockSidebarOrder,
          folders: mockSidebarOrder.folders.filter((f) => !inside(f)),
        };
      }
      // …and the note pins inside the subtree
      for (const n of folderNotes) mockMoveSidebarPin(n.path, null);
      // …and every key bound into the subtree, the folder row included
      mockMoveSidebarKeysFolder(rel, null);
      let deleted_ms = Date.now();
      while (mockTrash.some((t) => t.id === `${deleted_ms}/${rel}`)) deleted_ms += 1;
      const id = `${deleted_ms}/${rel}`;
      mockTrash.unshift({
        id,
        path: rel,
        title: rel.split("/").pop()!,
        deleted_ms,
        kind: "folder",
        notes: folderNotes.map((n) => n.path),
        folderNotes,
        folderDirs,
        folderSealScopes,
        folderSealUnconfirmed,
      });
      return id;
    }
    case "vault_trash_list":
      // engine parity: Engine::trash_list sorts `deleted_ms DESC,
      // path ASC` before returning. Sort a COPY — other cases splice into
      // mockTrash by index, so its own order must stay as-is.
      return [...mockTrash]
        .sort((a, b) =>
          b.deleted_ms < a.deleted_ms
            ? -1
            : b.deleted_ms > a.deleted_ms
              ? 1
              : a.path < b.path
                ? -1
                : a.path > b.path
                  ? 1
                  : 0
        )
        .map(({ note: _note, folderNotes: _f, folderDirs: _d, asset: _a, ...t }) => t);
    case "vault_trash_restore": {
      const idx = mockTrash.findIndex((t) => t.id === args?.id && t.kind === "note");
      if (idx === -1) throw new Error("trash entry not found");
      const [t] = mockTrash.splice(idx, 1);
      const n = t.note!;
      if (mockNotes.some((m) => m.path === n.path)) {
        const stem = n.path.replace(/\.md$/, "");
        let i = 2;
        while (mockNotes.some((m) => m.path === `${stem} ${i}.md`)) i += 1;
        n.path = `${stem} ${i}.md`;
        n.stem = `${n.stem} ${i}`;
        n.title = `${n.title} ${i}`;
      }
      n.updated_ms = Date.now();
      mockAddFolder(n.folder);
      mockNotes.push(n);
      mockEnforceSealScope(n);
      return meta(n);
    }
    case "vault_trash_restore_folder": {
      const idx = mockTrash.findIndex((t) => t.id === args?.id && t.kind === "folder");
      if (idx === -1) throw new Error("trash entry not found");
      const [t] = mockTrash.splice(idx, 1);
      // same never-overwrite rule as notes: a reoccupied path dedupes numbered
      let rel = t.path;
      if (mockFolders.has(rel)) {
        let i = 2;
        while (mockFolders.has(`${t.path} ${i}`)) i += 1;
        rel = `${t.path} ${i}`;
      }
      for (const d of t.folderDirs ?? []) mockAddFolder(rel + d.slice(t.path.length));
      const restoredUnconfirmed = new Set(t.folderSealUnconfirmed ?? []);
      for (const scope of t.folderSealScopes ?? []) {
        const restored = rel + scope.slice(t.path.length);
        mockSealScopes.add(restored);
        // `move_scope_trust` retargets a confirmation into `.trash/<id>` and
        // back out again; an unconfirmed marker has no trust entry to move, so
        // it comes back exactly as unconfirmed as it went in. Restoring it
        // confirmed would adopt a planted marker on a round trip through the
        // trash — the one direction the confirmation gate exists to stop.
        if (restoredUnconfirmed.has(scope)) mockUnconfirmedSealScopes.add(restored);
      }
      for (const n of t.folderNotes ?? []) {
        n.path = rel + n.path.slice(t.path.length);
        n.folder = mockFolderOf(n.path);
        n.updated_ms = Date.now();
        mockEnforceSealScope(n);
        mockNotes.push(n);
      }
      return rel;
    }
    case "vault_trash_delete_folder": {
      const idx = mockTrash.findIndex((t) => t.id === args?.id && t.kind === "folder");
      if (idx === -1) throw new Error("trash entry not found");
      mockTrash.splice(idx, 1);
      return null;
    }
    case "vault_trash_restore_template": {
      // a deleted database's template — back into the template
      // store under a numbered stem when the type was recreated with a fresh
      // one, the engine's never-overwrite rule. Returns the stem it landed
      // under, exactly like trash_restore_template.
      const idx = mockTrash.findIndex((t) => t.id === args?.id && t.kind === "template");
      if (idx === -1) throw new Error("trash entry not found");
      const [t] = mockTrash.splice(idx, 1);
      let landed = t.title;
      let n = 2;
      while (mockFoldedKey(mockTemplates, landed)) landed = `${t.title} ${n++}`;
      mockTemplates[landed] = t.template ?? { props: mockRecord(), body: "" };
      return landed;
    }
    case "vault_trash_delete_template": {
      const idx = mockTrash.findIndex((t) => t.id === args?.id && t.kind === "template");
      if (idx === -1) throw new Error("trash entry not found");
      mockTrash.splice(idx, 1);
      return null;
    }
    case "vault_trash_delete": {
      const idx = mockTrash.findIndex((t) => t.id === args?.id);
      if (idx === -1) throw new Error("trash entry not found");
      mockTrash.splice(idx, 1);
      return null;
    }
    case "vault_trash_empty": {
      mockTrash.length = 0;
      return null;
    }
    case "vault_search": {
      // mirrors the engine's FTS5 semantics (fts_match_expr): every whitespace
      // query token becomes a quoted prefix PHRASE — unicode61 splits it into
      // word runs, so `bc-2025q4-00352` means the runs `bc 2025q4 00352`
      // CONSECUTIVE in one field with the last run a prefix. Plain tokens keep
      // the old word-prefix behavior (a one-run phrase); a mid-word substring
      // still misses; phrases never span title/body/props, like FTS columns.
      // machine-fence bodies are stripped like the engine's index
      const tokens = ((args?.q as string) ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return [];
      const bound = "[\\p{L}\\p{N}]";
      const phrases = tokens.map(mockSearchWords);
      // scope: the caller's structured filters, as a path allow-list.
      // Applied before the cap, exactly like the engine's `path IN (…)` clause —
      // otherwise the cap picks from the unfiltered set and filtered matches
      // that rank outside the top 30 vanish.
      const scope = (args?.scope as string[] | undefined) ?? null;
      const inScope = scope ? new Set(scope) : null;
      // conceal parity: the engine drops the app files before its
      // cap when asked, so the mock must too
      const skipAppFiles = (args?.excludeAppFiles as boolean | undefined) ?? false;
      return mockNotes
        .filter((n) => !(skipAppFiles && isAppFile(n.path)))
        .filter((n) => inScope === null || inScope.has(n.path))
        .filter((n) => {
          // prop values answer alongside title/body, like the engine's index —
          // per column, so a phrase never spans the title/body/props seams
          const fields = [
            mockSearchWords(n.title),
            mockSearchWords(stripMachineFences(n.body)),
            mockSearchWords(mockPropsSearchText(n.props)),
          ];
          return phrases.every((runs) => fields.some((f) => mockHasPhrase(f, runs)));
        })
        // rank before capping, or the cap picks by insertion order
        .map((n) => {
          const body = `${stripMachineFences(n.body)}\n${mockPropsSearchText(n.props)}`;
          const titleAt = mockFirstHit(n.title, tokens, bound);
          return {
            note: n,
            titleHit: titleAt !== Infinity,
            offset: titleAt !== Infinity ? titleAt : mockFirstHit(body, tokens, bound),
            path: n.path,
          };
        })
        .sort(mockRank)
        .slice(0, SEARCH_MAX_HITS)
        .map(({ note: n }) => {
          // which column marked, in the engine's own terms: a hit that landed
          // ONLY in the props carries the value it matched, because the body
          // snippet below it marks nothing and explains nothing
          const propsText = mockPropsSearchText(n.props);
          const marked = (text: string) =>
            phrases.some((runs) => mockHasPhrase(mockSearchWords(text), runs));
          const propOnly =
            marked(propsText) && !marked(n.title) && !marked(stripMachineFences(n.body));
          return {
            path: n.path,
            snippet: n.excerpt || n.body.slice(0, 80),
            prop_snippet: propOnly ? propsText : null,
          };
        });
    }
    case "vault_search_full": {
      // approximates the engine: word-prefix tokens, whole word highlighted.
      // A token is the same quoted prefix phrase the quick search reads, so a
      // hyphenated identifier matches its runs consecutively here too — the two
      // commands used to disagree about the same query, and the one the results
      // pane runs was the stricter of the pair.
      const terms = ((args?.q as string) ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      if (terms.length === 0) return { hits: [], total_notes: 0, truncated: false };
      const fullPhrases = terms.map(mockSearchWords);
      // a punctuation-only token has no runs: FTS's empty phrase matches
      // nothing, so the whole query does too rather than matching everything
      if (fullPhrases.some((runs) => runs.length === 0))
        return { hits: [], total_notes: 0, truncated: false };
      // scope: path allow-list applied before the cap, like the engine — and
      // like the engine, it speaks for notes only. A mounted file is in no
      // note list, so the list names none of them: they are ADMITTED past it
      // into the page (the pane applies the filter verdict to a row it can
      // rebuild from its mount) and left OUT of the count, which may only
      // report what the list itself judged.
      const fullScope = (args?.scope as string[] | undefined) ?? null;
      const fullInScope = fullScope ? new Set(fullScope) : null;
      // conceal parity: excluded before the count AND the cap, so
      // total_notes/truncated never speak for files the user can't see
      const fullSkipAppFiles = (args?.excludeAppFiles as boolean | undefined) ?? false;
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // one alternative per phrase: its runs in order, whatever punctuation the
      // text separates them with, and the last run's whole word highlighted.
      // A plain token is a single run, so its highlight is unchanged.
      const alt = (runs: string[]) => runs.map(esc).join("[^\\p{L}\\p{N}]+");
      const res = new RegExp(
        `(?<![\\p{L}\\p{N}_])(?:${fullPhrases.map(alt).join("|")})[\\p{L}\\p{N}_]*`,
        "giu"
      );
      // matching runs on the accent-folded text and the parts are cut out of
      // the ORIGINAL through the index map: the phrases are already folded
      // (mockSearchWords), so "cafe" highlights "café" — accent included — the
      // way `remove_diacritics 2` found it, and the parts still concatenate
      // back to exactly the line that was passed in
      const segment = (text: string): { parts: { text: string; hit: boolean }[]; count: number } => {
        const parts: { text: string; hit: boolean }[] = [];
        const { folded, map } = foldWithMap(text);
        let count = 0;
        let last = 0;
        for (const m of folded.matchAll(res)) {
          const at = map[m.index ?? 0];
          const end = map[(m.index ?? 0) + m[0].length];
          if (at > last) parts.push({ text: text.slice(last, at), hit: false });
          parts.push({ text: text.slice(at, end), hit: true });
          count += 1;
          last = end;
        }
        if (last < text.length) parts.push({ text: text.slice(last), hit: false });
        return { parts, count };
      };
      const bound = "[\\p{L}\\p{N}_]";
      const ranked = [];
      for (const n of mockNotes) {
        if (fullSkipAppFiles && isAppFile(n.path)) continue;
        if (fullInScope !== null && !fullInScope.has(n.path)) continue;
        const title = segment(n.title);
        let total = title.count;
        const matches = [];
        // machine-fence bodies are stripped like the engine's index
        const body = stripMachineFences(n.body);
        const lines = body.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const seg = segment(lines[i]);
          if (seg.count === 0) continue;
          total += seg.count;
          if (matches.length < 12) matches.push({ line: i + 1, parts: seg.parts });
        }
        // prop-value hits count toward the total and bring the marked value
        // with them — a prop has no body line to show, and a count with
        // nothing visible under it never says why the note came back
        const propsText = mockPropsSearchText(n.props);
        const propSeg = segment(propsText);
        total += propSeg.count;
        // AND semantics like FTS: every term must appear somewhere in the note,
        // per column, so a phrase never spans the title/body/props seams
        const fields = [mockSearchWords(n.title), mockSearchWords(body), mockSearchWords(propsText)];
        if (total > 0 && fullPhrases.every((runs) => fields.some((f) => mockHasPhrase(f, runs))))
          ranked.push({
            hit: {
              path: n.path,
              title_parts: title.parts,
              total,
              matches,
              partial: false,
              prop_parts: propSeg.count > 0 ? propSeg.parts : [],
            },
            titleHit: title.count > 0,
            offset:
              title.count > 0
                ? mockFirstHit(n.title, terms, bound)
                : mockFirstHit(`${body}\n${propsText}`, terms, bound),
            path: n.path,
          });
      }
      // mounted files are indexed alongside notes — a vault whose
      // papers live in a mount answers "nothing found" otherwise. Keyed by the
      // virtual path, since a mount row has no note until it is annotated, and
      // carrying `partial` so a document read only to its cap says so.
      for (const [id, idx] of Object.entries(mockMountIndex)) {
        if (!mockMounts.some((m) => m.id === id)) continue;
        for (const f of idx.files) {
          const path = `${MOUNT_SCHEME}${id}/${f.rel}`;
          // no scope check: the allow-list is built from notes and names no
          // mounted file, so testing one against it drops every one of them
          const name = f.rel.split("/").pop() ?? f.rel;
          const title = segment(name);
          let total = title.count;
          const matches = [];
          const lines = (f.text ?? "").split("\n");
          for (let i = 0; i < lines.length; i++) {
            const seg = segment(lines[i]);
            if (seg.count === 0) continue;
            total += seg.count;
            if (matches.length < 12) matches.push({ line: i + 1, parts: seg.parts });
          }
          const fileFields = [mockSearchWords(name), mockSearchWords(f.text ?? "")];
          if (total === 0 || !fullPhrases.every((runs) => fileFields.some((f2) => mockHasPhrase(f2, runs))))
            continue;
          ranked.push({
            hit: {
              path,
              title_parts: title.parts,
              total,
              matches,
              partial: !!f.text_truncated,
              // a mounted file has no frontmatter — nothing to mark
              prop_parts: [],
            },
            titleHit: title.count > 0,
            offset:
              title.count > 0 ? mockFirstHit(name, terms, bound) : mockFirstHit(f.text ?? "", terms, bound),
            path,
          });
        }
      }
      // pictures whose text was read here are in the same index — a
      // screenshot of a receipt answers a search for what is written on it.
      // Keyed by the virtual path, since a picture has no note.
      for (const img of mockImages) {
        const path = `${IMAGE_SCHEME}${img.rel}`;
        // no scope check: the caller's allow-list is built from its NOTE list,
        // which holds no pictures, so honouring it here would delete every
        // picture from any filtered query — `type:image` included. The client
        // re-applies the filters to the row it synthesizes, exactly as the
        // engine's scope clause lets image rows past.
        const name = img.rel.split("/").pop() ?? img.rel;
        const title = segment(name);
        let total = title.count;
        const matches = [];
        const lines = img.text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const seg = segment(lines[i]);
          if (seg.count === 0) continue;
          total += seg.count;
          if (matches.length < 12) matches.push({ line: i + 1, parts: seg.parts });
        }
        const imgFields = [mockSearchWords(name), mockSearchWords(img.text)];
        if (total === 0 || !fullPhrases.every((runs) => imgFields.some((f) => mockHasPhrase(f, runs))))
          continue;
        ranked.push({
          hit: {
            path,
            title_parts: title.parts,
            total,
            matches,
            partial: false,
            // a picture has no frontmatter — nothing to mark
            prop_parts: [],
          },
          titleHit: title.count > 0,
          offset: title.count > 0 ? mockFirstHit(name, terms, bound) : mockFirstHit(img.text, terms, bound),
          path,
        });
      }
      // rank before capping, or the cap picks by insertion order.
      // The count is of the whole match set, not the page — the UI
      // needs it to say "first 200 of 359" and to tell a truncated page apart
      // from an empty result set. Under a scope it is of the match set the
      // ALLOW-LIST spoke for: the admitted rows rode past it unjudged, so
      // neither the total nor the overflow it implies may include them.
      const hits = ranked.sort(mockRank).slice(0, FULL_SEARCH_MAX_NOTES).map((r) => r.hit);
      const counted = (rows: { path: string }[]) =>
        rows.filter(
          (r) =>
            (fullInScope === null || !r.path.startsWith(MOUNT_SCHEME))
        ).length;
      const fullTotal = counted(ranked);
      return { hits, total_notes: fullTotal, truncated: counted(hits) < fullTotal };
    }
    case "vault_backlinks": {
      const n = find();
      if (!n) return [];
      const names = [n.title.toLowerCase(), n.stem.toLowerCase()];
      // mirrors the engine's link index — ![[…]] embeds are not links
      return mockNotes
        .filter(
          (m) =>
            m.path !== n.path &&
            [...m.body.matchAll(/!?\[\[([^[\]]+)\]\]/g)].some(
              (match) =>
                !match[0].startsWith("!") &&
                // …and the edge is the TARGET alone
                names.includes(parseWikiLink(match[1]).target.toLowerCase())
            )
        )
        .map(meta)
        // engine parity: Engine::backlinks sorts by title before
        // returning (vault.rs, `out.sort_by(|a, b| a.title.cmp(&b.title))`)
        .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    }
    case "vault_related": {
      // mirrors Engine::related: schema'd relation props aimed at this note's
      // type whose value names it (untyped targets match any relation)
      const n = find();
      if (!n) return [];
      const names = [n.title.toLowerCase(), n.stem.toLowerCase()];
      const targetType = (mockPropString(n.props, "type") ?? "").toLowerCase();
      const out: RelatedEntry[] = [];
      for (const m of mockNotes) {
        if (m.path === n.path) continue;
        const t = mockPropString(m.props, "type");
        const schemaKey = typeof t === "string" ? mockFoldedKey(mockSchema, t) : undefined;
        const props = schemaKey ? mockSchema[schemaKey] : undefined;
        if (!props) continue;
        for (const [key, ps] of Object.entries(props)) {
          if (ps.kind !== "relation") continue;
          if (targetType && (ps.type ?? "").toLowerCase() !== targetType) continue;
          const actualKey = mockPropKey(m.props, key);
          if (!actualKey) continue;
          const v = m.props[actualKey];
          const hit =
            (typeof v === "string" && names.includes(v.trim().toLowerCase())) ||
            (Array.isArray(v) &&
              v.some((x) => typeof x === "string" && names.includes(x.trim().toLowerCase())));
          if (hit)
            out.push({ path: m.path, title: m.title, db_type: t as string, prop: actualKey });
        }
      }
      // engine parity: byte order like `str::cmp`, not localeCompare
      out.sort((a, b) =>
        a.title < b.title ? -1 : a.title > b.title ? 1 : a.prop < b.prop ? -1 : a.prop > b.prop ? 1 : 0
      );
      return out;
    }
    case "vault_resolve": {
      // engine parity: the anchor and the display alias are not
      // part of the name — `Piranesi#Notes|the book` resolves Piranesi
      const needle = parseWikiLink((args?.name as string) ?? "").target.toLowerCase();
      if (!needle) return null;
      const n = mockNotes.find(
        (m) => m.title.toLowerCase() === needle || m.stem.toLowerCase() === needle
      );
      return n ? meta(n) : null;
    }
    case "vault_save_asset": {
      const raw = ((args?.name as string) ?? "pasted.png").split(/[/\\]/).pop() || "pasted.png";
      const dot = raw.lastIndexOf(".");
      const stem = dot > 0 ? raw.slice(0, dot) : raw;
      const ext = dot > 0 ? raw.slice(dot) : ".png";
      let name = `${stem}${ext}`;
      let n = 2;
      while (mockAssets.has(name)) {
        name = `${stem} ${n}${ext}`;
        n += 1;
      }
      mockAssets.set(name, args?.data as string);
      return name;
    }
    case "vault_read_asset": {
      const data = mockAssets.get(args?.name as string);
      if (data === undefined) throw new Error("asset not found");
      return data;
    }
    case "vault_import_asset": {
      const raw = ((args?.path as string) ?? "").split(/[/\\]/).pop() || "import.bin";
      const dot = raw.lastIndexOf(".");
      const stem = dot > 0 ? raw.slice(0, dot) : raw;
      const ext = dot > 0 ? raw.slice(dot) : ".bin";
      let name = `${stem}${ext}`;
      let n = 2;
      while (mockAssets.has(name)) {
        name = `${stem} ${n}${ext}`;
        n += 1;
      }
      mockAssets.set(name, "");
      return name;
    }
    case "vault_link_asset": {
      // browser lane never has real paths; echo for tests of the plumbing
      const p = ((args?.path as string) ?? "").trim();
      if (!p) throw new Error("not a file");
      return p;
    }
    // Voice capture. No microphone in the e2e lane, so the mock is a
    // stopwatch: it tracks the recording flag and, on stop, files exactly the
    // note the real command would — a `type: voice` note in Inbox embedding an
    // asset. Level meter ticks are the UI's own concern; nothing here emits
    // `voice:level`, so the meter renders its idle state.
    case "voice_supported":
      return true;
    case "voice_start": {
      if (mockVoice) throw new Error("already recording");
      const at = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      mockVoice = {
        stem: `Voice ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`,
        startedMs: Date.now(),
      };
      return mockVoice.stem;
    }
    case "voice_is_recording":
      return mockVoice !== null;
    case "voice_cancel":
      mockVoice = null;
      return null;
    case "voice_stop": {
      if (!mockVoice) throw new Error("not recording");
      const { stem, startedMs } = mockVoice;
      mockVoice = null;
      const voiceAsset = await mockDispatch("vault_import_asset", { path: `${stem}.wav` });
      return await mockDispatch("vault_create", {
        title: stem,
        folder: "Inbox",
        noteType: "voice",
        props: [
          ["captured", new Date(startedMs).toISOString().slice(0, 19)],
          ["duration", String(Math.round((Date.now() - startedMs) / 1000))],
        ],
        body: `![[${voiceAsset as string}]]\n`,
      });
    }
    case "voice_model_state":
      return {
        installed: mockVoiceModel,
        bytes: mockVoiceModel ? 574041195 : 0,
        expected_bytes: 574041195,
      };
    case "voice_model_download": {
      // no 574 MB in a spec: the download is instant here, and emits the same
      // completion tick the real one ends on so the row's wiring is exercised
      mockVoiceModel = true;
      window.__mockEmit?.("voice:model", { received: 574041195, total: 574041195 });
      return null;
    }
    case "voice_transcribe":
      // there is no model and no audio in the mock lane; the command's job in
      // a spec is to be callable and not throw
      return null;
    case "drop_shift_down":
      return false;
    case "vault_asset_info": {
      // audio names resolve to a synthesized WAV (see lib/assets.ts); path
      // embeds always miss, demoing the broken-path state
      const name = (((args?.name as string) ?? "")).trim();
      // A folder row's absolute path is a real file here — the
      // engine stats it through the same link-in-place lane. Checked before
      // the broken-path branch below, which still owns every other path.
      const loose = mockLooseByPath(name);
      if (loose) {
        return { path: name, size: 8 + loose.rel.length, mtime_ms: mockLooseMtime };
      }
      if (name.startsWith("/") || name.startsWith("~/")) throw new Error("file not found");
      const audio = /\.(wav|aiff?|mp3|flac|m4a)$/i.test(name);
      if (!audio && !mockAssets.has(name)) throw new Error("asset not found");
      return {
        path: `mock://${name}`,
        size: 8 + name.length,
        mtime_ms: mockAssetMtimes.get(name) ?? 1,
      };
    }
    case "vault_image_hit": {
      const rel = (args?.rel as string) ?? "";
      const img = mockImages.find((i) => i.rel === rel);
      if (!img) return null;
      return {
        rel,
        source: rel.split("/").pop() ?? rel,
        path: `/mock/vault/${rel}`,
        text: img.text,
        truncated: !!img.truncated,
        label: "machine-read text, never ground truth",
        version: 1,
      };
    }
    case "vault_assets_orphaned": {
      // mirrors Engine::assets_orphaned — case-insensitive `![[name]]` scan
      const referenced = new Set<string>();
      const re = /!\[\[([^[\]]+)\]\]/g;
      for (const n of mockNotes) {
        for (const m of n.body.matchAll(re)) referenced.add(embedTarget(m[1]).toLowerCase());
      }
      return [...mockAssets.keys()]
        .filter((name) => !referenced.has(name.toLowerCase()))
        // engine parity: lowercased byte order (`to_lowercase().cmp`)
        .sort((a, b) => {
          const al = a.toLowerCase();
          const bl = b.toLowerCase();
          return al < bl ? -1 : al > bl ? 1 : 0;
        })
        // the mtime surfaces in the Assets pane — keep it believable, not epoch 0
        .map((name) => ({
          path: name,
          size: mockAssets.get(name)!.length,
          mtime_ms: now - 40 * 86_400_000,
        }));
    }
    // A small fixed report — one finding per kind, so the pane's
    // grouping, severities and copy-as-JSON all have something to render.
    // Read-only in the mock too: nothing here mutates mockNotes.
    /* The bundled cookbook. Two fixture recipes: `portfolio` is
       clear of the mock vault, `tasks-board` collides with the seeded
       Dashboards/Tasks.md, so the browser gate exercises both the plain
       install and the ` (cookbook)` rename without needing a second run. */
    case "cookbook_index":
      return JSON.stringify(MOCK_COOKBOOK);
    case "cookbook_shot":
      // every recipe answers with the same pixel — e2e asserts the thumbnail
      // renders, not what it depicts
      return PIXEL_PNG;
    case "cookbook_install": {
      const files = (args?.files as string[]) ?? [];
      const written: { path: string; renamed_from: string | null }[] = [];
      for (const rel of files) {
        // mirrors free_path in commands/cookbook.rs: never overwrite — a taken
        // path lands beside the existing note under a ` (cookbook)` name
        const taken = (p: string) =>
          mockNotes.some((m) => m.path.toLowerCase() === p.toLowerCase());
        let path = rel;
        if (taken(path)) {
          const dot = rel.lastIndexOf(".");
          const stem = dot > 0 ? rel.slice(0, dot) : rel;
          const ext = dot > 0 ? rel.slice(dot) : "";
          let n = 1;
          do {
            path = `${stem} (cookbook${n === 1 ? "" : ` ${n}`})${ext}`;
            n += 1;
          } while (taken(path));
        }
        const folder = mockFolderOf(path);
        const stem = path.slice(folder ? folder.length + 1 : 0, -".md".length);
        const body = `Installed from the cookbook.\n`;
        mockAddFolder(folder);
        mockNotes.push({
          path,
          stem,
          title: stem,
          folder,
          props: { created: day(0) },
          updated_ms: Date.now(),
          excerpt: mockMakeExcerpt(body),
          body,
        });
        written.push({ path, renamed_from: path === rel ? null : rel });
      }
      const dash = written.find((f) => f.path.startsWith("Dashboards/"));
      return { files: written, open: (dash ?? written[0])?.path ?? null };
    }
    case "vault_doctor":
      return {
        scanned_ms: now,
        notes: mockNotes.length,
        findings: [
          {
            kind: "broken-link",
            severity: "error",
            paths: ["Slow Bloom EP.md"],
            subject: "umbra unreleased",
            detail: "[[umbra unreleased]] matches no note title or filename",
          },
          {
            kind: "broken-relation",
            severity: "error",
            paths: ["Vessel Songs.md"],
            subject: "Chroma Weather",
            detail: "artist points at “Chroma Weather”, which matches no note",
          },
          {
            kind: "broken-embed",
            severity: "error",
            paths: ["Static Bouquet.md"],
            subject: "missing-cover.png",
            detail: "no .assets/missing-cover.png in this vault",
          },
          {
            kind: "broken-view-ref",
            severity: "error",
            paths: ["Welcome.md"],
            subject: "retired-pin",
            detail: "```view fence references saved view “retired-pin”, which no longer exists",
          },
          {
            kind: "ambiguous-target",
            severity: "warn",
            paths: ["Gero.md", "Inbox/Gero.md"],
            subject: "gero",
            detail: "2 notes answer to “gero” — links to it resolve unpredictably",
          },
          {
            kind: "stale-config",
            severity: "warn",
            paths: [".vault/schema.json"],
            subject: "sketch",
            detail: "schema type “sketch” has no notes",
          },
          {
            kind: "invalid-prop",
            severity: "error",
            paths: ["Holdings.md"],
            subject: "soon",
            detail: "due is a date prop, but “soon” is not YYYY-MM-DD[ HH:MM]",
          },
        ],
      };
    /* Asset delete moves into the trash as an `asset` entry keyed
       `<deleted_ms>/.assets/<name>`, mirroring Engine::assets_delete. */
    case "vault_assets_delete": {
      /* One entry per input name, in order — `Ok(id)` for a file that
         moved, `Ok("")` for one already gone, so a partial failure stays
         per-name attributable the way vault_delete_many is. */
      const out: { Ok?: string; Err?: string }[] = [];
      for (const name of (args?.names as string[]) ?? []) {
        const data = mockAssets.get(name);
        if (data === undefined) {
          out.push({ Ok: "" }); // stale sweep result, tolerated
          continue;
        }
        mockAssets.delete(name);
        mockAssetMtimes.delete(name);
        let deleted_ms = Date.now();
        while (mockTrash.some((t) => t.id === `${deleted_ms}/.assets/${name}`)) deleted_ms += 1;
        out.push({ Ok: `${deleted_ms}/.assets/${name}` });
        mockTrash.unshift({
          id: `${deleted_ms}/.assets/${name}`,
          path: `.assets/${name}`,
          title: name,
          deleted_ms,
          kind: "asset",
          notes: [],
          asset: data,
        });
      }
      return out;
    }
    case "vault_assets_restore": {
      const idx = mockTrash.findIndex((t) => t.id === args?.id && t.kind === "asset");
      if (idx === -1) throw new Error("trash entry not found");
      const [t] = mockTrash.splice(idx, 1);
      // same claim_asset_name dedupe as save_asset — restore never overwrites
      const raw = t.title;
      const dot = raw.lastIndexOf(".");
      const stem = dot > 0 ? raw.slice(0, dot) : raw;
      const ext = dot > 0 ? raw.slice(dot) : "";
      let name = `${stem}${ext}`;
      let n = 2;
      while (mockAssets.has(name)) {
        name = `${stem} ${n}${ext}`;
        n += 1;
      }
      mockAssets.set(name, t.asset ?? "");
      return name;
    }
    case "vault_assets_trash_delete": {
      const idx = mockTrash.findIndex((t) => t.id === args?.id && t.kind === "asset");
      if (idx === -1) throw new Error("trash entry not found");
      mockTrash.splice(idx, 1);
      return null;
    }
    case "vault_sync_status":
      return {
        ...mockVaultSyncStatus,
        last_result: mockVaultSyncStatus.last_result
          ? {
              ...mockVaultSyncStatus.last_result,
              conflicted: [...mockVaultSyncStatus.last_result.conflicted],
              changed: [...mockVaultSyncStatus.last_result.changed],
            }
          : null,
        // engine parity: read from the parked merge, not from the
        // session's last result, and sorted like sync_conflicts returns it
        conflicted: mockConflicts.active
          ? mockConflicts.files.map((f) => f.path).sort()
          : [],
        privacy_error: mockPrivacyNotice?.message ?? null,
        privacy_paths: mockPrivacyNotice ? [...mockPrivacyNotice.paths] : [],
        notice: mockStoreNotice,
        // engine parity: read from the configured remote, not from the
        // session's last result — a restart forgets the result, never the URL
        remote_kind: mockSyncRemote.kind,
        // engine parity: the URL leaves here with any embedded credentials
        // replaced by dots, because this is the string a pane shows
        remote_url: mockRedactUserinfo(mockSyncRemote.url),
        // engine parity: hosted remote plus the rewrite marker, read from the
        // repository — true from the moment the rewrite lands, before any leg
        // has run and failed
        rewrite_blocked: mockRewriteBlocked && mockSyncRemote.kind === "hosted",
        // engine parity: the marker a refused pull left in the repository,
        // with its cost re-measured on every call
        replaced_store: mockSyncRemote.kind === "hosted" ? mockReplacedStore : null,
      } satisfies VaultSyncStatus;
    case "vault_sync_set_remote": {
      const url = String(args?.url ?? "").trim();
      const token = String(args?.token ?? "");
      const cert = String(args?.cert ?? "").trim();
      const passphrase = String(args?.passphrase ?? "").trim();
      // Engine parity, and the reason the mock redacts at all: the field is
      // prefilled from the redacted status URL, so pressing Save without
      // retyping would otherwise store dots where the credentials were.
      if (url.includes(MOCK_REDACTED_USERINFO)) {
        throw new Error(
          `the remote URL shown is redacted — ${MOCK_REDACTED_USERINFO} stands in for the ` +
            "credentials embedded in it, and saving it would destroy them. Retype the full URL, " +
            "its credentials included.",
        );
      }
      if (url.startsWith("blob+")) {
        // Hosted (encrypted blob-store) remote — same refusal messages and
        // the same URL rule as hosted_set_remote: plain HTTP only for an
        // exact local host, so a lookalike such as
        // 127.0.0.1.attacker.example never rides the loopback exception.
        const base = url.slice("blob+".length);
        let loopback = false;
        if (base.startsWith("http://")) {
          try {
            const parsed = new URL(base);
            loopback =
              parsed.username === "" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
          } catch {
            loopback = false;
          }
        }
        if (!base.startsWith("https://") && !loopback) {
          throw new Error(
            "hosted sync remote must be blob+https:// (blob+http:// is allowed for loopback tests)",
          );
        }
        if (token.trim().length === 0) {
          throw new Error("vault sync token cannot be empty for a hosted remote");
        }
        if (passphrase.length === 0) {
          throw new Error("hosted sync needs the vault passphrase");
        }
        // Counted in code points after NFC, like hosted_set_remote's
        // `chars().count()` — the backend normalizes before it measures, so a
        // decomposed accent must not buy a character here either.
        if ([...passphrase.normalize("NFC")].length < 12) {
          throw new Error(
            "the vault passphrase must be at least 12 characters — it is the only protection on the encrypted vault",
          );
        }
        // Joining a store that already holds a vault. Order matches the
        // backend's: enrollment reads the key document first, so a bad token
        // never gets far enough for the passphrase to matter — and the token
        // is compared after the same `Bearer ` strip the backend does, since
        // pasting the docs' example is the likeliest way to get it wrong.
        if (mockHostedVault) {
          const bearer = /^bearer /i;
          const sent = token.trim().replace(bearer, "").trim();
          if (sent !== mockHostedVault.token.trim().replace(bearer, "").trim()) {
            throw new Error("hosted sync key read was rejected: check the server token");
          }
          // A staged vault means the server's key document already exists:
          // joining it must be a Joined, never a Created, so the document is
          // seeded from the staged passphrase before enrollment reads it.
          if (mockVaultKeyDocument === null) {
            mockVaultKeyDocument = mockHostedVault.passphrase.normalize("NFC");
          }
        }
        // Enrollment parity: the first save mints the vault's passphrase, and
        // every later one has to repeat whatever is current.
        const created = mockVaultKeyDocument === null;
        if (!created && passphrase.normalize("NFC") !== mockVaultKeyDocument) {
          throw new Error(
            "hosted sync passphrase is wrong — mistyped, or changed on another device since this one learned it (or the key data is damaged)",
          );
        }
        mockVaultKeyDocument = passphrase.normalize("NFC");
        mockVaultKeyHeldLocally = true;
        mockVaultSyncStatus = { configured: true, last_result: null, last_error: null };
        mockSyncRemote = { kind: "hosted", url };
        // engine parity, same as the plain-git tail below: the store warning
        // is a fact about the OLD store, and a hosted remote is the only kind
        // that ever carries one — clearing it only on the other branch would
        // keep the old store's warning on the pane forever.
        mockStoreNotice = null;
        return created ? "created" : "joined";
      }
      if (passphrase.length > 0) {
        throw new Error("a vault passphrase is only used with blob+https:// remotes");
      }
      if (!(url.startsWith("https://") || url.startsWith("file://"))) {
        throw new Error(
          "vault sync remote must use https:// or blob+https:// (file:// is allowed for tests)",
        );
      }
      if (url.startsWith("https://") && token.length === 0) {
        throw new Error("vault sync token cannot be empty for an HTTPS remote");
      }
      if (cert.length > 0 && !cert.includes("-----BEGIN CERTIFICATE-----")) {
        throw new Error("server certificate must be a PEM CERTIFICATE block");
      }
      mockVaultSyncStatus = { configured: true, last_result: null, last_error: null };
      // engine parity: pointing the vault at a new remote clears the whole
      // sync record except the privacy notice, and the store warning is a fact
      // about the OLD store — the next push against this one works out its own.
      mockStoreNotice = null;
      // Leaving the hosted transport drops the master key from THIS device's
      // credential store, which is all the engine does. The server keeps its
      // key document, so a later hosted save joins the same vault under the
      // same passphrase rather than minting a new one.
      mockVaultKeyHeldLocally = false;
      mockSyncRemote = { kind: "git", url };
      return "plain";
    }
    case "vault_sync_change_passphrase": {
      const current = String(args?.oldPassphrase ?? "").trim().normalize("NFC");
      const next = String(args?.newPassphrase ?? "").trim().normalize("NFC");
      if (mockSyncRemote.kind !== "hosted") {
        throw new Error(
          "the vault passphrase belongs to a hosted (blob+https://) remote; this vault does not sync to one",
        );
      }
      // Engine parity: the re-wrap loads this device's own copy of the vault
      // key before it touches the server, and compares against it. A device
      // that has left the hosted transport no longer holds one.
      if (!mockVaultKeyHeldLocally) {
        throw new Error("vault sync credentials unavailable; configure the remote again");
      }
      if (current.length === 0) throw new Error("enter the current vault passphrase");
      if ([...next].length < 12) {
        throw new Error(
          "the vault passphrase must be at least 12 characters — it is the only protection on the encrypted vault",
        );
      }
      if (current !== mockVaultKeyDocument) {
        throw new Error(
          "hosted sync passphrase is wrong — mistyped, or changed on another device since this one learned it (or the key data is damaged)",
        );
      }
      mockVaultKeyDocument = next;
      return null;
    }
    case "vault_sync_push": {
      if (mockRewriteBlocked && mockSyncRemote.kind === "hosted") {
        throw new Error(
          "hosted sync is paused: this vault's history was rewritten here by a purge or " +
            "trim, and the server still holds the history from before it, which this push " +
            "cannot build on. Replacing the server's copy with this vault, from the Vault " +
            "sync pane, starts sync again.",
        );
      }
      // engine parity: the mirror state refuses the uploading leg too, in the
      // pause's own words rather than in the generic line that would send the
      // user to Pull — the leg that is also refusing
      if (mockReplacedStore && mockSyncRemote.kind === "hosted") {
        throw new Error(mockReplacedStorePause(mockReplacedStore));
      }
      if (!mockVaultSyncStatus.configured) throw new Error("vault sync remote is not configured");
      mockSyncCalls.push("vault_sync_push");
      const report: SyncReport = {
        pushed: 2,
        pulled: 0,
        conflicted: [],
        head: "5dc371a8f1b9",
        // a push checks nothing out (engine parity)
        changed: [],
        ...(mockSyncNotice === null ? {} : { notice: mockSyncNotice }),
      };
      // engine parity: the push leg is the only one that writes the sticky
      // slot, and it writes it either way — a store back under the threshold
      // is how the warning goes away.
      mockStoreNotice = mockSyncNotice;
      mockVaultSyncStatus = { configured: true, last_result: report, last_error: null };
      return report;
    }
    case "vault_sync_pull": {
      if (!mockVaultSyncStatus.configured) throw new Error("vault sync remote is not configured");
      if (mockRewriteBlocked && mockSyncRemote.kind === "hosted") {
        throw new Error(
          "hosted sync is paused: this vault's history was rewritten here by a purge or " +
            "trim, so it no longer matches the copy on the server. Pulling would bring the " +
            "removed history back. Replacing the server's copy with this vault, from the " +
            "Vault sync pane, starts sync again.",
        );
      }
      if (mockReplacedStore && mockSyncRemote.kind === "hosted") {
        throw new Error(mockReplacedStorePause(mockReplacedStore));
      }
      mockSyncCalls.push("vault_sync_pull");
      if (mockPullPlan.conflicted) {
        const report: SyncReport = {
          pushed: 0,
          pulled: 3,
          // engine parity: conflict_paths returns a BTreeSet, so this
          // list is sorted, not pull-order
          conflicted: ["Journal/2026-07-22.md", "Projects/Release plan.md"].sort(),
          head: "91c0f17ab4d2",
          // engine parity: this pull conflicts, so it parks the merge
          // instead of checking anything out — nothing on disk moved
          changed: [],
        };
        mockVaultSyncStatus = { configured: true, last_result: report, last_error: null };
        mockConflicts = mockConflictSeed();
        return report;
      }
      const changed = [...(mockPullPlan.changed ?? [])].sort();
      const clean: SyncReport = {
        pushed: 0,
        pulled: changed.length,
        conflicted: [],
        head: "c1ea9d2f4b08",
        changed,
      };
      mockVaultSyncStatus = { configured: true, last_result: clean, last_error: null };
      // engine parity: announce_pull emits vault:pulled for a real checkout —
      // an auto-pull's invalidation rides the same event
      if (changed.length > 0) window.__mockEmit?.("vault:pulled", changed);
      return clean;
    }
    case "vault_sync_replace_hosted": {
      if (!mockVaultSyncStatus.configured) throw new Error("vault sync remote is not configured");
      if (mockSyncRemote.kind !== "hosted") {
        throw new Error(
          "replacing the server's copy is only possible for an end-to-end-encrypted remote",
        );
      }
      if (!mockRewriteBlocked) {
        throw new Error(
          "this vault's history has not been rewritten here, so there is nothing for a " +
            "replacement to repair; use Push",
        );
      }
      mockSyncCalls.push("vault_sync_replace_hosted");
      const report: SyncReport = {
        pushed: 4,
        pulled: 0,
        conflicted: [],
        head: "7b41d0c95e6a",
        // engine parity: a push checks nothing out
        changed: [],
      };
      // engine parity: the push the replacement runs is what clears the
      // marker, so sync is ordinary from the next leg onward
      mockRewriteBlocked = false;
      mockVaultSyncStatus = { configured: true, last_result: report, last_error: null };
      return report;
    }
    case "vault_sync_adopt_replaced": {
      if (!mockVaultSyncStatus.configured) throw new Error("vault sync remote is not configured");
      if (mockSyncRemote.kind !== "hosted") {
        throw new Error(
          "adopting the server's history is only possible for an end-to-end-encrypted remote",
        );
      }
      if (!mockReplacedStore) {
        throw new Error(
          "this vault's sync is not paused on a replaced history, so there is nothing to " +
            "adopt; use Pull",
        );
      }
      mockSyncCalls.push("vault_sync_adopt_replaced");
      const report: SyncReport = {
        pushed: 0,
        pulled: 6,
        conflicted: [],
        head: "3c90ab21d4f7",
        changed: ["Notes/Kept.md"],
        // engine parity: the adoption never reports as an ordinary pull — the
        // whole vault was just replaced, and the report is where that is said
        notice:
          "This vault moved onto a history another device rewrote (a purge or trim). " +
          `${mockCapitalize(mockReplacedStoreCost(mockReplacedStore))} discarded here.`,
      };
      mockReplacedStore = null;
      mockVaultSyncStatus = { configured: true, last_result: report, last_error: null };
      window.__mockEmit?.("vault:pulled", report.changed);
      return report;
    }
    case "vault_sync_ack_privacy":
      mockPrivacyNotice = null;
      return null;
    case "vault_sync_conflicts":
      return mockConflictView();
    case "vault_sync_resolve_set": {
      const path = String(args?.path ?? "");
      const choice = String(args?.choice ?? "");
      if (choice !== "mine" && choice !== "theirs" && choice !== "both") {
        throw new Error(`unknown conflict resolution "${choice}"`);
      }
      const file = mockConflicts.files.find((f) => f.path === path);
      if (!file) throw new Error(`"${path}" is not a conflicted file in this pull`);
      if (choice === "both" && file.both_path.length === 0) {
        throw new Error(`"${path}" was deleted on one side, so there is no second copy to keep`);
      }
      file.resolution = choice;
      mockConflicts.resolved = mockConflicts.files.filter((f) => f.resolution).length;
      return mockConflictView();
    }
    case "vault_sync_resolve_clear": {
      const path = String(args?.path ?? "");
      const file = mockConflicts.files.find((f) => f.path === path);
      if (!file) throw new Error(`"${path}" is not a conflicted file in this pull`);
      file.resolution = null;
      mockConflicts.resolved = mockConflicts.files.filter((f) => f.resolution).length;
      return mockConflictView();
    }
    case "vault_sync_resolve_finish": {
      const undecided = mockConflicts.files.filter((f) => !f.resolution);
      if (!mockConflicts.active) throw new Error("no conflicted pull is waiting to be resolved");
      if (undecided.length > 0) {
        throw new Error(
          `${undecided.length} conflicted file(s) still need a choice: ${undecided
            .map((f) => f.path)
            .join(", ")}`,
        );
      }
      // keep-both lands the remote copy beside mine, like the Rust merge does
      const merged = mockConflicts.files.filter((f) => f.resolution === "both").length;
      // engine parity: finishing checks the merge out, so every
      // conflicted path moved on disk — plus the keep-both copies
      const changed = mockConflicts.files
        .flatMap((f) => (f.resolution === "both" && f.both_path ? [f.path, f.both_path] : [f.path]))
        .sort();
      const report: SyncReport = {
        pushed: 0,
        pulled: mockConflicts.files.length + merged,
        conflicted: [],
        head: "7be40d9a3c26",
        changed,
      };
      mockConflicts = { active: false, head: "", remote: "", files: [], resolved: 0 };
      mockVaultSyncStatus = { configured: true, last_result: report, last_error: null };
      // engine parity: vault_sync_resolve_finish announces its checkout
      if (changed.length > 0) window.__mockEmit?.("vault:pulled", changed);
      return report;
    }
    case "vault_views_read":
      return { ...mockViews };
    case "vault_schema_read":
      return mockSchemaRead();
    case "vault_schema_set": {
      // mirrors Engine::set_schema_prop: trim, case-insensitive dedupe,
      // date/file/relation/url/email/phone/checkbox/number/rollup kinds drop
      // options
      // (multi keeps them), relation needs a target, number validates
      // its display format (plain stores as absent, drops on other kinds), a
      // rollup needs its relation (an existing relation-kind prop
      // of the same database), target prop and agg vocabulary, a
      // description rides any kind trimmed (empty = absent), no
      // kind + no options demotes the prop, notify (null = keep stored flag)
      // only sticks to date-kind props
      const requestedDbType = ((args?.dbType as string) ?? "").trim();
      const requestedProp = ((args?.prop as string) ?? "").trim();
      const dbType = mockFoldedKey(mockSchema, requestedDbType) ?? requestedDbType;
      const prop = mockFoldedKey(mockSchema[dbType] ?? {}, requestedProp) ?? requestedProp;
      if (!dbType || !prop) throw new Error("database and property must be non-empty");
      // a mount's binding props are the engine's — mirrors
      // Engine::check_binding_prop, which trims before it folds, so a padded
      // prop name is caught here too rather than slipping past the mock
      if (
        ["mount", "mount_file", "mount_identity"].includes(prop.trim().toLowerCase()) &&
        mockMounts.some((m) => m.name.trim().toLowerCase() === dbType.toLowerCase())
      )
        throw new Error(`“${prop}” is set by the mount`);
      const kind = ((args?.kind as PropKind | null) ?? undefined) || undefined;
      if (kind && kind !== "text" && kind !== "date" && kind !== "file" && kind !== "relation" && kind !== "multi" && kind !== "url" && kind !== "email" && kind !== "phone" && kind !== "checkbox" && kind !== "number" && kind !== "rollup")
        throw new Error(`unknown property kind “${kind}”`);
      const target = ((args?.target as string | null) ?? "").trim();
      if (kind === "relation" && !target)
        throw new Error("a relation property needs a target database");
      const rawFormat = ((args?.format as string | null) ?? "").trim();
      // The same field names a display format OR a unit code, and the backend
      // matches both case-insensitively and stores the canonical spelling
      // (`usd` writes as `USD`). Word aliases ("dollars") are not codes and
      // stay refused.
      const unit = resolveUnit(rawFormat);
      const unitCode =
        unit && unit.code.toLowerCase() === rawFormat.toLowerCase() ? unit.code : null;
      const named = ["plain", "euro", "percent"].includes(rawFormat.toLowerCase());
      const format = named ? rawFormat.toLowerCase() : (unitCode ?? rawFormat);
      if (kind === "number" && format && !named && !unitCode)
        throw new Error(`unknown number format “${rawFormat}”`);
      // rollup wiring: three flat args like the IPC command sends
      const rollRelation = ((args?.relation as string | null) ?? "").trim();
      const rollProp = ((args?.rollupProp as string | null) ?? "").trim();
      const rollAgg = ((args?.agg as string | null) ?? "").trim();
      if (kind === "rollup") {
        if (!rollRelation) throw new Error("a rollup property needs a relation to follow");
        if (!rollProp) throw new Error("a rollup property needs a target property");
        if (!["sum", "avg", "min", "max", "count"].includes(rollAgg))
          throw new Error(`unknown rollup function “${rollAgg}”`);
        const follows = Object.entries(mockSchema[dbType] ?? {}).find(
          ([k]) => k.toLowerCase() === rollRelation.toLowerCase()
        )?.[1];
        if (follows?.kind !== "relation")
          throw new Error(`“${rollRelation}” is not a relation property of “${dbType}”`);
      }
      const desc = ((args?.description as string | null) ?? "").trim();
      // a review window rides any kind, stored in one spelling however it was
      // typed; absent leaves the stored window alone, blank clears it
      const reviewArg = args?.review as string | null | undefined;
      const review =
        reviewArg === null || reviewArg === undefined ? null : canonicalReviewWindow(reviewArg);
      if (reviewArg !== null && reviewArg !== undefined && reviewArg.trim() && !review)
        throw new Error(`unknown review window “${reviewArg}”`);
      const seen = new Set<string>();
      const options: SelectOption[] = [];
      if (!kind || kind === "multi")
        for (const o of (args?.options as SelectOption[]) ?? []) {
          const value = (o.value ?? "").trim();
          if (!value || seen.has(value.toLowerCase())) continue;
          seen.add(value.toLowerCase());
          options.push(o.color?.trim() ? { value, color: o.color } : { value });
        }
      if (options.length === 0 && !kind) {
        delete mockSchema[dbType]?.[prop];
        // removing the prop the tree hangs off unmarks the parent link too
        const parentKey = mockFoldedKey(mockParents, dbType);
        if (parentKey && mockParents[parentKey].toLowerCase() === prop.toLowerCase())
          delete mockParents[parentKey];
        if (mockSchema[dbType] && Object.keys(mockSchema[dbType]).length === 0)
          delete mockSchema[dbType];
      } else {
        // the parent mark only survives while its prop still QUALIFIES: a
        // kind changed away from relation, or a target retargeted at another
        // database, unmarks the tree here the way removing the prop does
        // above — a mark left behind renders no chevrons and would silently
        // re-arm the day the prop became a self-relation again
        const selfRelation = kind === "relation" && target.toLowerCase() === dbType.toLowerCase();
        const markedKey = mockFoldedKey(mockParents, dbType);
        if (
          !selfRelation &&
          markedKey &&
          mockParents[markedKey].toLowerCase() === prop.toLowerCase()
        )
          delete mockParents[markedKey];
        const keep = mockSchema[dbType]?.[prop]?.notify ?? false;
        const keptReview =
          reviewArg === undefined || reviewArg === null
            ? mockSchema[dbType]?.[prop]?.review
            : (review ?? undefined);
        const notify = ((args?.notify as boolean | null) ?? keep) && kind === "date";
        // lead time rides the same date-only rule: 0 clears it,
        // longer than a year clamps, an absent arg keeps the stored value
        const keepBefore = mockSchema[dbType]?.[prop]?.notifyBefore;
        const before = (args?.notifyBefore as number | null) ?? keepBefore;
        const notifyBefore =
          kind === "date" && before && before > 0 ? Math.min(before, 365) : undefined;
        (mockSchema[dbType] ??= mockRecord())[prop] = kind
          ? { options: kind === "multi" ? options : [], kind, ...(kind === "relation" ? { type: target } : {}), ...(kind === "number" && format && format !== "plain" ? { format: format as NumberFormat } : {}), ...(kind === "rollup" ? { relation: rollRelation, prop: rollProp, agg: rollAgg as AggKind } : {}), ...(notify ? { notify: true } : {}), ...(notifyBefore ? { notifyBefore } : {}), ...(desc ? { description: desc } : {}), ...(keptReview ? { review: keptReview } : {}) }
          : { options, ...(desc ? { description: desc } : {}), ...(keptReview ? { review: keptReview } : {}) };
      }
      return mockSchemaRead();
    }
    case "vault_schema_set_icon": {
      // mirrors Engine::set_schema_icon: trim, emoji wins over glyph, tint
      // only with a mark, no mark removes the icon — whole icon each write
      const requestedDbType = ((args?.dbType as string) ?? "").trim();
      const dbType = mockFoldedKey(mockSchema, requestedDbType) ?? requestedDbType;
      if (!dbType) throw new Error("database must be non-empty");
      const clean = (v: unknown) => {
        const s = typeof v === "string" ? v.trim() : "";
        return s || undefined;
      };
      const emoji = clean(args?.emoji);
      const glyph = emoji ? undefined : clean(args?.glyph);
      const tint = glyph || emoji ? clean(args?.tint) : undefined;
      if (!glyph && !emoji) {
        delete mockIcons[dbType];
      } else {
        mockIcons[dbType] = {
          ...(glyph ? { glyph } : {}),
          ...(emoji ? { emoji } : {}),
          ...(tint ? { tint } : {}),
        };
      }
      return mockSchemaRead();
    }
    case "vault_schema_home_set": {
      // mirrors Engine::set_schema_home: trimmed, path-validated like any
      // folder, null/blank clears
      const requestedDbType = ((args?.dbType as string) ?? "").trim();
      const dbType = mockFoldedKey(mockSchema, requestedDbType) ?? requestedDbType;
      if (!dbType) throw new Error("database must be non-empty");
      const raw = ((args?.home as string | null) ?? "")?.trim() ?? "";
      if (!raw) {
        delete mockHomes[dbType];
      } else {
        const parts = raw.split(/[/\\]/).map((p) => p.trim()).filter(Boolean);
        if (parts.length === 0) throw new Error("folder name cannot be empty");
        if (parts.some((p) => p === "." || p === ".." || p.startsWith("."))) {
          throw new Error("invalid folder path");
        }
        const rel = parts.join("/");
        // one home folder, one database
        const other = Object.entries(mockHomes).find(
          ([t, h]) => t !== dbType && h === rel,
        );
        if (other) {
          throw new Error(`"${rel}" is already the home folder of "${other[0]}"`);
        }
        mockHomes[dbType] = rel;
      }
      return mockSchemaRead();
    }
    case "vault_schema_parent_set": {
      // mirrors Engine::set_schema_parent: the marked prop must be a
      // relation-kind prop of this same database pointing back at it; the
      // CANONICAL prop name is stored, null/blank clears
      const requestedDbType = ((args?.dbType as string) ?? "").trim();
      const dbType = mockFoldedKey(mockSchema, requestedDbType) ?? requestedDbType;
      if (!dbType) throw new Error("database must be non-empty");
      const raw = ((args?.prop as string | null) ?? "")?.trim() ?? "";
      if (!raw) {
        delete mockParents[dbType];
      } else {
        const props = mockSchema[dbType] ?? {};
        const canonical = mockFoldedKey(props, raw);
        if (!canonical) throw new Error(`“${dbType}” has no property named “${raw}”`);
        const ps = props[canonical];
        if (ps?.kind !== "relation") {
          throw new Error(`“${canonical}” is not a relation property`);
        }
        if ((ps.type ?? "").toLowerCase() !== dbType.toLowerCase()) {
          throw new Error(`“${canonical}” must point at “${dbType}” to name a parent row`);
        }
        mockParents[dbType] = canonical;
      }
      return mockSchemaRead();
    }
    case "vault_create_type": {
      // mirrors Engine::create_type: register the type in the schema with
      // optional initial props (absent kind = explicit text); nothing else
      // is written — a database only gets notes when entries are created
      const name = ((args?.name as string) ?? "").trim();
      mockCheckTypeName(name, null);
      const entry = mockRecord<PropSchema>();
      for (const p of (args?.props as NewTypeProp[]) ?? []) {
        const pname = (p?.name ?? "").trim();
        if (!pname) throw new Error("property names must be non-empty");
        if (pname.toLowerCase() === "icon")
          throw new Error("“icon” is reserved for the database icon");
        if (pname.toLowerCase() === "home")
          throw new Error("“home” is reserved for the database home folder");
        if (pname.toLowerCase() === "parent")
          throw new Error("“parent” is reserved for the sub-item parent link");
        if (Object.keys(entry).some((k) => k.toLowerCase() === pname.toLowerCase()))
          throw new Error(`duplicate property “${pname}”`);
        const kind = ((p.kind as NewPropKind | null) ?? null) || "text";
        if (!["text", "select", "date", "file", "relation", "multi", "url", "email", "phone", "checkbox", "number", "rollup"].includes(kind))
          throw new Error(`unknown property kind “${kind}”`);
        // mirrors Engine::create_type: a rollup's wiring doesn't fit this
        // call — it's added to an existing database via vault_schema_set
        if (kind === "rollup")
          throw new Error(`rollup property “${pname}” needs an existing relation property — add it after the database exists`);
        const target = (p.target ?? "").trim();
        if (kind === "relation" && !target)
          throw new Error(`relation property “${pname}” needs a target database`);
        // mirrors Engine::create_type: "select" names the KINDLESS entry a
        // select is made of — storing it as a kind would leave a column no
        // editor knows how to read — and its options ARE it. They normalize
        // like a schema edit's (trimmed, blanks out, case-insensitive dupes
        // gone) and belong to select and multi only
        const seenOpt = new Set<string>();
        const options: SelectOption[] = [];
        if (kind === "select" || kind === "multi")
          for (const o of p.options ?? []) {
            const value = (o.value ?? "").trim();
            if (!value || seenOpt.has(value.toLowerCase())) continue;
            seenOpt.add(value.toLowerCase());
            options.push(o.color?.trim() ? { value, color: o.color } : { value });
          }
        entry[pname] =
          kind === "select"
            ? { options }
            : { options, kind, ...(kind === "relation" ? { type: target } : {}) };
      }
      mockSchema[name] = entry;
      return mockSchemaRead();
    }
    case "vault_rename_type": {
      // mirrors Engine::rename_type: bulk `type:` rewrite; schema key,
      // relation targets, views pref, sidebar order, and template follow
      const oldName = ((args?.old as string) ?? "").trim();
      const newName = ((args?.new as string) ?? "").trim();
      // The sweeps return a BulkSweep so a partial run can report its
      // count with the error. The mock never fails mid-sweep, so `failed` is
      // always absent here — the shape is what has to stay truthful.
      if (oldName === newName) return { notes: 0, skipped: 0 };
      mockCheckTypeName(newName, oldName);
      // Note Type values may carry another casing of this same database and
      // must not block a self-case rename. Schema keys are durable entries:
      // exempt only the exact-first source, never a distinct folded peer.
      const schemaSource = mockFoldedKey(mockSchema, oldName);
      const schemaCollision = Object.keys(mockSchema).find(
        (key) => key !== schemaSource && key.toLowerCase() === newName.toLowerCase()
      );
      if (schemaCollision) throw new Error(`a database named “${schemaCollision}” already exists`);
      if (mockTemplateNamesForIdentity(oldName).length > 1)
        throw new Error(`template identity “${mockSanitizeFilename(oldName)}.md” is ambiguous`);
      const templateOld = mockExistingTemplateName(oldName);
      const templateNew = mockSanitizeFilename(newName);
      const templateTarget = mockExistingTemplateName(newName);
      if (templateOld && templateTarget && templateTarget !== templateOld)
        throw new Error(`a template named “${templateNew}” already exists`);
      let rewritten = 0;
      for (const n of mockNotes) {
        const typeKey = mockPropKey(n.props, "type");
        if (typeKey && mockPropString(n.props, "type")?.toLowerCase() === oldName.toLowerCase()) {
          n.props[typeKey] = newName;
          n.updated_ms = Date.now();
          rewritten++;
        }
      }
      const schemaOld = mockFoldedKey(mockSchema, oldName);
      if (schemaOld) {
        mockSchema[newName] = mockSchema[schemaOld];
        delete mockSchema[schemaOld];
      }
      // the engine moves the whole type entry — the icon rides with it
      const iconOld = mockFoldedKey(mockIcons, oldName);
      if (iconOld) {
        mockIcons[newName] = mockIcons[iconOld];
        delete mockIcons[iconOld];
      }
      // …and so do the parent mark and the home folder
      const parentOld = mockFoldedKey(mockParents, oldName);
      if (parentOld) {
        mockParents[newName] = mockParents[parentOld];
        delete mockParents[parentOld];
      }
      const homeOld = mockFoldedKey(mockHomes, oldName);
      if (homeOld) {
        mockHomes[newName] = mockHomes[homeOld];
        delete mockHomes[homeOld];
      }
      for (const props of Object.values(mockSchema))
        for (const ps of Object.values(props))
          if (ps.kind === "relation" && ps.type?.toLowerCase() === oldName.toLowerCase()) ps.type = newName;
      const viewsOld = mockFoldedKey(mockViews, oldName);
      if (viewsOld) {
        mockViews[newName] = mockViews[viewsOld];
        delete mockViews[viewsOld];
      }
      mockSidebarOrder = {
        ...mockSidebarOrder,
        databases: mockSidebarOrder.databases.map((d) => (d.toLowerCase() === oldName.toLowerCase() ? newName : d)),
      };
      // a key bound to the database row follows the rename
      mockMoveSidebarKeysDb(oldName, newName);
      if (templateOld) {
        mockTemplates[templateNew] = mockTemplates[templateOld];
        if (templateOld !== templateNew) delete mockTemplates[templateOld];
      }
      // a mount IS its schema type, so the registry follows the
      // rename — one left on the old name and the two identities drift apart
      for (const m of mockMounts) {
        if (m.name.trim().toLowerCase() === oldName.toLowerCase()) m.name = newName;
      }
      return { notes: rewritten, skipped: 0 };
    }
    case "vault_delete_type": {
      // mirrors Engine::delete_type: strip `type:` (keep notes) or move every
      // note of the type to the trash; schema/views/sidebar/template go too
      const dbType = ((args?.dbType as string) ?? "").trim();
      const trashNotes = args?.trashNotes as boolean;
      // Resolve while both database identities still exist. Ambiguous legacy
      // aliases return undefined, preserving their shared template.
      const templateKey = mockExistingTemplateName(dbType);
      const doomed = mockNotes.filter(
        (n) => mockPropString(n.props, "type")?.toLowerCase() === dbType.toLowerCase()
      );
      for (const n of doomed) {
        if (trashNotes) {
          mockNotes.splice(mockNotes.indexOf(n), 1);
          const deleted_ms = Date.now();
          mockTrash.unshift({
            id: `${deleted_ms}/${n.path}`,
            path: n.path,
            title: n.title,
            deleted_ms,
            kind: "note",
            notes: [],
            note: n,
          });
        } else {
          const typeKey = mockPropKey(n.props, "type");
          if (typeKey) delete n.props[typeKey];
          n.updated_ms = Date.now();
        }
      }
      const schemaKey = mockFoldedKey(mockSchema, dbType);
      const iconKey = mockFoldedKey(mockIcons, dbType);
      const homeKey = mockFoldedKey(mockHomes, dbType);
      const parentKey = mockFoldedKey(mockParents, dbType);
      const viewsKey = mockFoldedKey(mockViews, dbType);
      if (schemaKey) delete mockSchema[schemaKey];
      if (iconKey) delete mockIcons[iconKey];
      if (homeKey) delete mockHomes[homeKey];
      if (parentKey) delete mockParents[parentKey];
      if (viewsKey) delete mockViews[viewsKey];
      mockSidebarOrder = {
        ...mockSidebarOrder,
        databases: mockSidebarOrder.databases.filter((d) => d.toLowerCase() !== dbType.toLowerCase()),
      };
      // …and dies with the delete
      mockMoveSidebarKeysDb(dbType, null);
      // the template goes through the trash like the engine's,
      // carrying its content so restore round-trips
      if (templateKey) {
        const tpl = mockTemplates[templateKey];
        delete mockTemplates[templateKey];
        let deleted_ms = Date.now();
        while (mockTrash.some((t) => t.id === `${deleted_ms}/.templates/${templateKey}.md`))
          deleted_ms += 1;
        mockTrash.unshift({
          id: `${deleted_ms}/.templates/${templateKey}.md`,
          path: `.vault/templates/${templateKey}.md`,
          title: templateKey,
          deleted_ms,
          kind: "template",
          notes: [],
          template: tpl,
        });
      }
      // deleting the database unmounts the folder it stood for —
      // otherwise the next rescan feeds a ghost type
      for (const m of mockMounts) {
        if (m.name.trim().toLowerCase() === dbType.toLowerCase()) {
          delete mockMountIndex[m.id];
          delete mockMountBindings[m.id];
        }
      }
      mockMounts = mockMounts.filter((m) => m.name.trim().toLowerCase() !== dbType.toLowerCase());
      return { notes: doomed.length, skipped: 0 };
    }
    case "vault_rename_prop": {
      // mirrors Engine::rename_prop: schema key move + bulk key rewrite;
      // notes already carrying the new key are skipped, never clobbered
      const dbType = ((args?.dbType as string) ?? "").trim();
      const oldName = ((args?.old as string) ?? "").trim();
      const newName = ((args?.new as string) ?? "").trim();
      if (!oldName || !newName) throw new Error("property names must be non-empty");
      if (oldName === newName) return { notes: 0, skipped: 0 };
      if (newName.toLowerCase() === "icon")
        throw new Error("“icon” is reserved for the database icon");
      if (newName.toLowerCase() === "home")
        throw new Error("“home” is reserved for the database home folder");
      if (newName.toLowerCase() === "parent")
        throw new Error("“parent” is reserved for the sub-item parent link");
      const schemaDb = mockFoldedKey(mockSchema, dbType);
      const schemaProps = schemaDb ? mockSchema[schemaDb] : undefined;
      const schemaOld = schemaProps ? mockFoldedKey(schemaProps, oldName) : undefined;
      if (
        schemaProps &&
        Object.keys(schemaProps).some(
          (k) => k !== schemaOld && k.toLowerCase() === newName.toLowerCase()
        )
      )
        throw new Error(`“${dbType}” already has a property named “${newName}”`);
      const oldIsNumber = schemaOld ? schemaProps?.[schemaOld]?.kind === "number" : false;
      let notes = 0;
      let skipped = 0;
      for (const n of mockNotes) {
        if (mockPropString(n.props, "type")?.toLowerCase() !== dbType.toLowerCase()) continue;
        const actualOld = mockPropKey(n.props, oldName);
        if (!actualOld) continue;
        const actualNew = mockPropKey(n.props, newName);
        if (actualNew && actualNew !== actualOld) {
          skipped++;
          continue;
        }
        n.props[newName] = n.props[actualOld];
        if (actualOld !== newName) delete n.props[actualOld];
        n.updated_ms = Date.now();
        notes++;
      }
      if (schemaProps && schemaOld) {
        schemaProps[newName] = schemaProps[schemaOld];
        if (schemaOld !== newName) delete schemaProps[schemaOld];
      }
      // mirrors Engine::rename_prop: a rollup following the renamed relation
      // (same database, case-folded) retargets its `relation` reference
      for (const ps of Object.values(schemaProps ?? {}))
        if (ps.kind === "rollup" && ps.relation?.toLowerCase() === oldName.toLowerCase())
          ps.relation = newName;
      // …and the sub-item parent mark names its prop the same way
      const parentDb = schemaDb ? mockFoldedKey(mockParents, schemaDb) : undefined;
      if (parentDb && mockParents[parentDb].toLowerCase() === oldName.toLowerCase())
        mockParents[parentDb] = newName;
      // …and every rollup in ANY database whose relation points at
      // this one retargets its `prop` reference — left dangling it would read
      // a prop no row carries, rendering the whole column empty
      for (const ts of Object.values(mockSchema)) {
        for (const ps of Object.values(ts)) {
          if (ps.kind !== "rollup" || ps.prop?.toLowerCase() !== oldName.toLowerCase()) continue;
          const rel = ps.relation;
          if (!rel) continue;
          const relSchema =
            ts[rel] ?? Object.entries(ts).find(([k]) => k.toLowerCase() === rel.toLowerCase())?.[1];
          if (relSchema?.kind !== "relation") continue;
          if (relSchema.type?.toLowerCase() !== dbType.toLowerCase()) continue;
          ps.prop = newName;
        }
      }
      const viewDb = mockFoldedKey(mockViews, dbType);
      const rnPref = viewDb ? mockViews[viewDb] : undefined;
      if (rnPref?.group_by?.toLowerCase() === oldName.toLowerCase()) rnPref.group_by = newName;
      if (rnPref?.table_group_by?.toLowerCase() === oldName.toLowerCase()) rnPref.table_group_by = newName;
      // The remembered sort and hidden entries follow the rename too
      if (rnPref?.sorts) rnPref.sorts = rnPref.sorts.map((s) => (s.key.toLowerCase() === oldName.toLowerCase() ? { ...s, key: newName } : s));
      if (rnPref?.hidden) rnPref.hidden = rnPref.hidden.map((h) => (h.toLowerCase() === oldName.toLowerCase() ? newName : h));
      // The table drag order follows the rename too
      if (rnPref?.col_order)
        rnPref.col_order = rnPref.col_order.map((c) => (c.toLowerCase() === oldName.toLowerCase() ? newName : c));
      // Per-layout hidden entries follow the rename too
      if (rnPref?.hidden_per_layout?.table)
        rnPref.hidden_per_layout.table = rnPref.hidden_per_layout.table.map((h) =>
          h.toLowerCase() === oldName.toLowerCase() ? newName : h
        );
      if (rnPref?.hidden_per_layout?.list)
        rnPref.hidden_per_layout.list = rnPref.hidden_per_layout.list.map((h) =>
          h.toLowerCase() === oldName.toLowerCase() ? newName : h
        );
      mockRemapSavedViewProp(dbType, oldName, newName, oldIsNumber);
      return { notes, skipped };
    }
    case "vault_clear_prop": {
      // mirrors Engine::clear_prop: strip a prop's values from the type's
      // notes (the separately-confirmed sweep after schema removal)
      const dbType = ((args?.dbType as string) ?? "").trim();
      const prop = ((args?.prop as string) ?? "").trim();
      const wasNumber = args?.wasNumber === true;
      const stripValues = args?.stripValues === true;
      let cleared = 0;
      if (stripValues) {
        for (const n of mockNotes) {
          if (mockPropString(n.props, "type")?.toLowerCase() !== dbType.toLowerCase()) continue;
          const actualProp = mockPropKey(n.props, prop);
          if (!actualProp) continue;
          delete n.props[actualProp];
          n.updated_ms = Date.now();
          cleared++;
        }
      }
      const viewDb = mockFoldedKey(mockViews, dbType);
      const clPref = viewDb ? mockViews[viewDb] : undefined;
      if (clPref?.group_by?.toLowerCase() === prop.toLowerCase()) delete clPref.group_by;
      if (clPref?.table_group_by?.toLowerCase() === prop.toLowerCase()) {
        delete clPref.table_group_by;
        // the section memory goes with the grouping it describes: both keys
        // name VALUES of this prop, which mean nothing once the prop is gone
        delete clPref.group_order;
        delete clPref.collapsed_groups;
      }
      // The prop's sort key and hidden entry drop with it; emptied
      // lists leave the pref entirely (the engine's collapse-to-None rule)
      if (clPref?.sorts) {
        clPref.sorts = clPref.sorts.filter((s) => s.key.toLowerCase() !== prop.toLowerCase());
        if (clPref.sorts.length === 0) delete clPref.sorts;
      }
      if (clPref?.hidden) {
        clPref.hidden = clPref.hidden.filter((h) => h.toLowerCase() !== prop.toLowerCase());
        if (clPref.hidden.length === 0) delete clPref.hidden;
      }
      // The prop drops out of the table drag order too
      if (clPref?.col_order) {
        clPref.col_order = clPref.col_order.filter((c) => c.toLowerCase() !== prop.toLowerCase());
        if (clPref.col_order.length === 0) delete clPref.col_order;
      }
      // Per-layout sets lose the prop too — emptied sets collapse to
      // absent, and a sets object with nothing left leaves the pref entirely
      const hpl = clPref?.hidden_per_layout;
      if (hpl) {
        if (hpl.table) {
          hpl.table = hpl.table.filter((h) => h.toLowerCase() !== prop.toLowerCase());
          if (hpl.table.length === 0) delete hpl.table;
        }
        if (hpl.list) {
          hpl.list = hpl.list.filter((h) => h.toLowerCase() !== prop.toLowerCase());
          if (hpl.list.length === 0) delete hpl.list;
        }
        if (!hpl.table && !hpl.list) delete clPref.hidden_per_layout;
      }
      mockRemapSavedViewProp(dbType, prop, null, wasNumber);
      return { notes: cleared, skipped: 0 };
    }
    case "history_snapshot":
      // the mock's per-note snaps can't model a vault-wide pre-sweep commit —
      // true = "a restore point exists", the healthy-vault answer (the engine
      // only returns false when history is disabled outright)
      return true;
    case "path_exists": {
      const p = String(args?.path ?? "");
      // links into the mounted folder exist iff its "disk" still holds the file
      if (p.startsWith("~/Personal/Finance/")) {
        const name = p.split("/").pop() ?? "";
        return mockFolderFiles.some((f) => f.name === name);
      }
      // mock: anything with "missing" in the name is a broken link
      return !p.toLowerCase().includes("missing");
    }
    case "vault_folder_files": {
      // engine parity: name-ascending, case-insensitive — the
      // running order for hand-numbered takes
      const folder = String(args?.path ?? "");
      const names = [...(mockLooseFiles.get(folder) ?? [])].sort((a, b) => {
        const [al, bl] = [a.toLowerCase(), b.toLowerCase()];
        return al < bl ? -1 : al > bl ? 1 : a < b ? -1 : a > b ? 1 : 0;
      });
      const files = names.map((name) => {
        const rel = folder ? `${folder}/${name}` : name;
        return {
          rel,
          name,
          path: mockLoosePath(rel),
          size: 8 + rel.length,
          mtime_ms: mockLooseMtime,
        };
      });
      return { files, total: files.length };
    }
    case "file_open":
      console.info("[mock] open", args?.path);
      return null;
    case "file_reveal":
      console.info("[mock] reveal in Finder", args?.path);
      return null;
    case "file_pick": {
      if (args?.dir) return "~/Personal/Finance";
      // honor the extensions filter like the real dialog does — the
      // mastering surface picks audio, everything else gets the pdf
      const exts = Array.isArray(args?.extensions) ? (args.extensions as string[]) : [];
      if (exts.length > 0) return `~/Documents/picked.${exts[0]}`;
      return "~/Documents/Mastering notes.pdf";
    }
    case "file_read_text":
      // the browser import flow picks via <input type=file> instead — the
      // mock has no fs outside the vault, so this path is Tauri-only
      throw new Error("file_read_text is only available in the app");
    case "curator_refresh": {
      // the Rust bridge mirrored: the configured command is required, one
      // live run, a second click is refused
      if (String(args?.command ?? "").trim() === "")
        throw new Error("no feed-curator command configured");
      mockCuratorTick();
      if (mockCuratorRuns.some((r) => r.state === "running"))
        throw new Error("a curation run is already in flight");
      const entry: MockCuratorRun = {
        id: `c${++mockCuratorSeq}`,
        state: "running",
        started_ms: Date.now(),
        finished_ms: null,
        summary: null,
        error: null,
        finishAt: Date.now() + MOCK_CURATOR_RUN_MS,
      };
      mockCuratorRuns.push(entry);
      return { ...entry };
    }
    case "curator_runs": {
      mockCuratorTick();
      return mockCuratorRuns.map((r) => ({ ...r })).sort(byStartedThenId);
    }
    case "curator_cancel": {
      const id = String(args?.id ?? "");
      const r = mockCuratorRuns.find((x) => x.id === id);
      if (!r || r.state !== "running") throw new Error("no running curation with that id");
      r.state = "failed";
      r.finished_ms = Date.now();
      r.error = "cancelled";
      return null;
    }
    case "vault_views_set": {
      const requestedDb = args?.db as string;
      const db = mockFoldedKey(mockViews, requestedDb)
        ?? mockFoldedKey(mockSchema, requestedDb)
        ?? requestedDb;
      // the wire keys are camelCase (Tauri converts for the Rust command);
      // read both so a snake_case straggler still lands
      // mirrors Engine::set_view_pref: bad sort dirs are refused,
      // empty lists collapse to absent, hidden entries trim (empties drop)
      const sorts = (args?.sorts as ViewsConfig[string]["sorts"] | null) ?? undefined;
      for (const s of sorts ?? []) {
        if (s.dir !== 1 && s.dir !== -1) throw new Error(`sort dir must be 1 or -1, got ${s.dir}`);
      }
      const hidden = ((args?.hidden as string[] | null) ?? undefined)
        ?.map((h) => h.trim())
        .filter(Boolean);
      // The drag order sanitizes like the hidden list
      const colOrder = (((args?.colOrder ?? args?.col_order) as string[] | null) ?? undefined)
        ?.map((c) => c.trim())
        .filter(Boolean);
      // the board's hand order sanitizes the same way (note paths,
      // never validated against the index — a stale path is ignored on read)
      const cardOrder = (((args?.cardOrder ?? args?.card_order) as string[] | null) ?? undefined)
        ?.map((c) => c.trim())
        .filter(Boolean);
      // The table's section memory holds group VALUES, and the empty
      // string is the "No <prop>" section's own key — so entries keep their
      // exact spelling and only a wholly empty list collapses to absent
      const groupOrder = ((args?.groupOrder ?? args?.group_order) as string[] | null) ?? undefined;
      const collapsedGroups =
        ((args?.collapsedGroups ?? args?.collapsed_groups) as string[] | null) ?? undefined;
      // Per-layout hidden sets sanitize like the flat list — entries
      // trim, empties drop, an empty set collapses to absent, and a sets
      // object with nothing left leaves the pref entirely
      const hplRaw = (args?.hiddenPerLayout ?? args?.hidden_per_layout) as
        | ViewsConfig[string]["hidden_per_layout"]
        | null
        | undefined;
      const hplTable = hplRaw?.table?.map((h) => h.trim()).filter(Boolean);
      const hplList = hplRaw?.list?.map((h) => h.trim()).filter(Boolean);
      const hiddenPerLayout =
        (hplTable?.length ?? 0) + (hplList?.length ?? 0) > 0
          ? {
              ...(hplTable?.length ? { table: hplTable } : {}),
              ...(hplList?.length ? { list: hplList } : {}),
            }
          : undefined;
      // Zero widths drop, wrap entries trim — Engine::set_view_pref
      const widths = Object.fromEntries(
        Object.entries((args?.widths as Record<string, number> | null) ?? {}).filter(([, w]) => w > 0)
      );
      const wrap = ((args?.wrap as string[] | null) ?? undefined)
        ?.map((w) => w.trim())
        .filter(Boolean);
      mockViews[db] = {
        view: args?.view as ViewsConfig[string]["view"],
        group_by: ((args?.groupBy ?? args?.group_by) as string | null) ?? undefined,
        table_group_by: ((args?.tableGroupBy ?? args?.table_group_by) as string | null) ?? undefined,
        aggregations:
          (args?.aggregations as ViewsConfig[string]["aggregations"] | null) ?? undefined,
        sorts: sorts?.length ? sorts : undefined,
        col_order: colOrder?.length ? colOrder : undefined,
        card_order: cardOrder?.length ? cardOrder : undefined,
        group_order: groupOrder?.length ? groupOrder : undefined,
        collapsed_groups: collapsedGroups?.length ? collapsedGroups : undefined,
        hidden: hidden?.length ? hidden : undefined,
        widths: Object.keys(widths).length ? widths : undefined,
        wrap: wrap?.length ? wrap : undefined,
        // Absent = follow the global db-grid setting
        grid: (args?.grid as boolean | null) ?? undefined,
        hidden_per_layout: hiddenPerLayout,
      };
      return { ...mockViews };
    }
    case "vault_folder_meta_read":
      return JSON.parse(JSON.stringify(mockFolderMeta));
    case "vault_tag_folders_read":
      return JSON.parse(JSON.stringify(mockTagFolders));
    case "vault_tag_folders_write": {
      // mirrors Engine::write_tag_folders: blank id or name refuses, ids
      // dedupe last-wins, the written list is what comes back
      const incoming = (args?.folders as TagFolder[]) ?? [];
      for (const f of incoming) {
        if (!f.id?.trim()) throw new Error("tag folder id cannot be empty");
        if (!f.name?.trim()) throw new Error("tag folder name cannot be empty");
      }
      const byId = new Map<string, TagFolder>();
      for (const f of incoming) byId.set(f.id.trim(), { ...f, id: f.id.trim(), name: f.name.trim() });
      mockTagFolders = [...byId.values()];
      return JSON.parse(JSON.stringify(mockTagFolders));
    }
    case "vault_note_add_tags": {
      // mirrors Engine::add_tags: only the `tags:` prop is written, tags the
      // note already carries inline are skipped, and the file never moves
      const n = mockNotes.find((m) => m.path === (args?.path as string));
      if (!n) throw new Error("not found");
      const wanted = ((args?.tags as string[]) ?? []).map((t) => t.trim()).filter(Boolean);
      const have = noteTags(n.props, n.body);
      const missing = wanted.filter((t) => !have.some((h) => h.toLowerCase() === t.toLowerCase()));
      if (missing.length === 0) return meta(n);
      const key = Object.keys(n.props).find((k) => k.toLowerCase() === "tags") ?? "tags";
      const list = propTags(n.props);
      for (const tag of missing) {
        if (!list.some((h) => h.toLowerCase() === tag.toLowerCase())) list.push(tag);
      }
      n.props[key] = list;
      if (n.fm !== undefined) {
        const ser = mockFmSerialize(n.props);
        if (ser === undefined) delete n.fm;
        else n.fm = ser;
      }
      n.updated_ms = Date.now();
      return meta(n);
    }
    case "vault_folder_icon_set": {
      // mirrors Engine::set_folder_icon: trim, emoji wins over glyph, tint
      // only with a mark, no mark removes the entry — whole icon each write
      const parts = ((args?.path as string) ?? "")
        .split(/[/\\]/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length === 0) throw new Error("folder name cannot be empty");
      if (parts.some((p) => p === "." || p === ".." || p.startsWith("."))) {
        throw new Error("invalid folder path");
      }
      const path = parts.join("/");
      const clean = (v: unknown) => {
        const s = typeof v === "string" ? v.trim() : "";
        return s || undefined;
      };
      const emoji = clean(args?.emoji);
      const glyph = emoji ? undefined : clean(args?.glyph);
      const tint = glyph || emoji ? clean(args?.tint) : undefined;
      if (!glyph && !emoji) {
        delete mockFolderMeta[path];
      } else {
        mockFolderMeta[path] = {
          icon: {
            ...(glyph ? { glyph } : {}),
            ...(emoji ? { emoji } : {}),
            ...(tint ? { tint } : {}),
          },
        };
      }
      return JSON.parse(JSON.stringify(mockFolderMeta));
    }
    case "vault_folders":
      return [...mockFolders].sort();
    case "vault_create_folder": {
      const raw = ((args?.path as string) ?? "").trim();
      // engine parity: sanitize_folder_rel checks each RAW part,
      // sanitizes it (reserved chars → space, whitespace collapsed), then
      // re-checks the sanitized form — ":.." sanitizes to ".." and must
      // refuse, and "My: Folder" must store as "My Folder", not verbatim
      const parts: string[] = [];
      for (const rawPart of raw.split(/[/\\]/).map((p) => p.trim())) {
        if (!rawPart) continue;
        if (rawPart === "." || rawPart === "..") throw new Error("invalid folder path");
        if (rawPart.startsWith(".")) throw new Error("hidden folders are not managed");
        const part = mockSanitizeFilename(rawPart);
        if (part === "." || part === "..") throw new Error("invalid folder path");
        if (part.startsWith(".")) throw new Error("hidden folders are not managed");
        parts.push(part);
      }
      if (parts.length === 0) throw new Error("folder name cannot be empty");
      const clean = parts.join("/");
      mockAddFolder(clean);
      return clean;
    }
    case "vault_rename_folder": {
      const oldRel = ((args?.path as string) ?? "").replace(/^[/\\]+|[/\\]+$/g, "");
      const rawName = ((args?.name as string) ?? "").trim();
      if (!oldRel) throw new Error("cannot rename the vault root");
      if (!rawName) throw new Error("folder name cannot be empty");
      // engine parity: rename_folder sanitizes the new leaf and
      // refuses a hidden result, exactly like create
      const name = mockSanitizeFilename(rawName);
      if (name.startsWith(".")) throw new Error("hidden folders are not managed");
      if (!mockFolders.has(oldRel)) throw new Error("folder not found");
      const parent = mockFolderOf(oldRel);
      const newRel = parent ? `${parent}/${name}` : name;
      if (newRel !== oldRel && mockFolders.has(newRel)) {
        throw new Error(`a folder named “${name}” already exists here`);
      }
      mockRelocateFolder(oldRel, newRel);
      return newRel;
    }
    // A folder dragged under another parent ("" = vault root) keeps
    // its name; everything path-keyed follows exactly as a rename's does.
    // NOTE: no sanitize_folder_rel / hidden_rel parity here — the engine's
    // traversal and dot-folder guards (mod.rs move_folder) are engine-only, so
    // a regression in them is invisible to e2e. cargo tests own that lane.
    case "vault_move_folder": {
      const oldRel = ((args?.path as string) ?? "").replace(/^[/\\]+|[/\\]+$/g, "");
      const parent = ((args?.folder as string) ?? "").trim().replace(/^[/\\]+|[/\\]+$/g, "");
      if (!oldRel) throw new Error("cannot move the vault root");
      if (!mockFolders.has(oldRel)) throw new Error("folder not found");
      const name = oldRel.split("/").pop()!;
      const newRel = parent ? `${parent}/${name}` : name;
      if (newRel === oldRel) return oldRel;
      if (parent === oldRel || parent.startsWith(`${oldRel}/`)) {
        throw new Error("cannot move a folder into itself");
      }
      if (mockFolders.has(newRel)) {
        throw new Error(`“${name}” already exists in ${parent || "the vault root"}`);
      }
      mockAddFolder(parent);
      mockRelocateFolder(oldRel, newRel);
      return newRel;
    }
    case "vault_move": {
      const n = find();
      if (!n) throw new Error("not found");
      const folder = ((args?.folder as string) ?? "").trim();
      if (n.folder === folder) return meta(n);
      const movedFrom = n.path;
      const fileName = n.path.split("/").pop()!;
      const newPath = folder ? `${folder}/${fileName}` : fileName;
      if (mockNotes.some((m) => m.path === newPath)) {
        throw new Error(`“${n.stem}” already exists in ${folder || "the vault root"}`);
      }
      mockAddFolder(folder);
      mockMoveSidebarPin(n.path, newPath);
      mockMoveSidebarKeys(n.path, newPath);
      n.path = newPath;
      n.folder = folder;
      n.updated_ms = Date.now();
      // the destination reopens locked, like Engine::move_note
      mockUnlockedSealed.delete(movedFrom);
      mockUnlockedSealed.delete(newPath);
      mockEnforceSealScope(n);
      return meta(n);
    }
    case "vault_sidebar_order":
      return mockSidebarOrder;
    case "vault_set_sidebar_order": {
      mockSidebarOrder = args?.order as SidebarOrder;
      return mockSidebarOrder;
    }
    case "mounts_list":
      return mockMounts.map(mockMountInfo);
    case "mount_add": {
      // mirrors Engine::add_mount: trimmed name, empty refused, a folded
      // duplicate refused — then bind on this machine and scan once, so the
      // board has rows the moment the dialog closes
      const name = ((args?.name as string) ?? "").trim();
      const path = ((args?.path as string) ?? "").trim();
      if (!name) throw new Error("a mount needs a name");
      if (!path) throw new Error("a mount needs a folder");
      if (mockMounts.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`“${name}” is already mounted`);
      }
      mockCheckTypeName(name, null);
      const globs = (Array.isArray(args?.globs) ? (args.globs as unknown[]) : [])
        .map((g) => String(g).trim())
        .filter(Boolean);
      // a mount IS a schema type — that's what gives its sidecars props
      mockSchema[name] = mockRecord<PropSchema>();
      const pending = mockPendingIgnore.get(name.toLowerCase());
      const mount: MockMount = {
        id: `mount-${mockSanitizeFilename(name).toLowerCase()}-${mockMounts.length + 1}`,
        name,
        globs,
        ...(pending?.length ? { ignore: pending } : {}),
        ...(args?.watch ? { watch: true } : {}),
      };
      mockMounts.push(mount);
      mockMountBindings[mount.id] = path;
      return mockScanMount(mount);
    }
    case "mount_bind": {
      // "Locate folder…": bind (and rescan) or unbind. Unbinding keeps the
      // mount, its index and its sidecars — that's the other-machine board.
      const id = String(args?.id ?? "");
      const path = args?.path == null ? null : String(args.path);
      const mount = mockMounts.find((m) => m.id === id);
      if (!mount) throw new Error(`no such mount: ${id}`);
      if (path === null) {
        delete mockMountBindings[id];
        return { id, name: mount.name, scanned: 0, added: 0, updated: 0, renamed: 0, missing: 0 };
      }
      mockMountBindings[id] = path;
      return mockScanMount(mount);
    }
    case "mount_rescan": {
      // one mount or all of them; mounts unbound on this machine are skipped,
      // so their index stays as the machine holding the folder left it
      const only = args?.id == null ? null : String(args.id);
      return mockMounts
        .filter((m) => mockMountBindings[m.id] && (!only || m.id === only))
        .map(mockScanMount);
    }
    case "mount_rows":
      return mockMountRows(String(args?.id ?? ""));
    case "mount_annotate": {
      // mirrors Engine::mount_annotate: the mount's only write path. An
      // existing sidecar takes the prop; otherwise this first annotation
      // creates the note under Mounts/<name>/.
      const id = String(args?.id ?? "");
      const rel = String(args?.rel ?? "");
      const prop = String(args?.prop ?? "").trim();
      const value = args?.value ?? null;
      const mount = mockMounts.find((m) => m.id === id);
      if (!mount) throw new Error(`no such mount: ${id}`);
      if (!prop) throw new Error("property names must be non-empty");
      if (["mount", "mount_file", "mount_identity"].includes(prop)) {
        throw new Error(`“${prop}” is set by the mount`);
      }
      // The file owns these, and the next extraction would overwrite
      // anything typed over them — mirrors Engine::mount_annotate
      if ((MOUNT_EXTRACTED as readonly string[]).some((c) => c.toLowerCase() === prop.toLowerCase())) {
        throw new Error(`“${prop}” is read from the file itself`);
      }
      const file = (mockMountIndex[id]?.files ?? []).find((f) => f.rel === rel);
      const sidecars = mockSidecarsOf(id);
      const existing =
        (file?.identity && sidecars.find((n) => n.props["mount_identity"] === file.identity)) ||
        sidecars.find((n) => n.props["mount_file"] === rel);
      if (existing) {
        if (value === null) delete existing.props[prop];
        else existing.props[prop] = value as PropValue;
        existing.updated_ms = Date.now();
        return meta(existing);
      }
      if (value === null) throw new Error(`“${rel}” has no note yet`);
      const folder = `Mounts/${mockSanitizeFilename(mount.name)}`;
      const stem = mockSanitizeFilename((rel.split("/").pop() ?? rel).replace(/\.[^.]+$/, ""));
      let path = `${folder}/${stem}.md`;
      let i = 2;
      while (mockNotes.some((n) => n.path === path)) path = `${folder}/${stem} ${i++}.md`;
      mockAddFolder(folder);
      const note: MockNote = {
        path,
        stem: path.slice(folder.length + 1, -".md".length),
        title: stem,
        folder,
        props: {
          created: day(0),
          type: mount.name,
          mount: id,
          mount_file: rel,
          mount_identity: file?.identity ?? "",
          [prop]: value as PropValue,
        },
        updated_ms: Date.now(),
        excerpt: "",
        body: "",
      };
      mockNotes.push(note);
      return meta(note);
    }
    case "mount_remove": {
      // unmount; `cleanup` trashes the sidecars (recoverable), never the
      // mounted folder, and takes the type the mount stood for with it
      const id = String(args?.id ?? "");
      const gone = mockMounts.find((m) => m.id === id);
      if (!gone) throw new Error(`no such mount: ${id}`);
      if (args?.cleanup) {
        for (const n of mockSidecarsOf(id)) {
          mockNotes.splice(mockNotes.indexOf(n), 1);
          const deleted_ms = Date.now();
          mockTrash.unshift({
            id: `${deleted_ms}/${n.path}`,
            path: n.path,
            title: n.title,
            deleted_ms,
            kind: "note",
            notes: [],
            note: n,
          });
        }
        delete mockSchema[gone.name];
      }
      mockMounts = mockMounts.filter((m) => m.id !== id);
      delete mockMountIndex[id];
      delete mockMountBindings[id];
      return mockMounts.map((m) => ({
        id: m.id,
        name: m.name,
        globs: m.globs,
        ...(m.watch ? { watch: true } : {}),
      }));
    }
    case "drives_list":
      return mockDrives();
    case "drives_sync":
      // the browser has no volumes to notice appear or vanish, so a sync is
      // honestly a no-op here — it still returns the shelf, like the backend
      return mockDrives();
    case "drive_entries":
      return mockDriveEntries(String(args?.id ?? ""), String(args?.prefix ?? ""));
    case "drive_search":
      return mockDriveSearch(String(args?.query ?? ""));
    case "drive_forget": {
      // forgetting drops the catalog and records the volume, so the next scan
      // doesn't quietly adopt the disk it was just told to leave alone. The
      // disk itself is never touched — there isn't one here to touch.
      const id = String(args?.id ?? "");
      const gone = mockMounts.find((m) => m.id === id && m.volume);
      if (!gone) throw new Error(`no such drive: ${id}`);
      if (args?.cleanup) {
        for (const n of mockSidecarsOf(id)) mockNotes.splice(mockNotes.indexOf(n), 1);
      }
      mockMounts = mockMounts.filter((m) => m.id !== id);
      delete mockMountIndex[id];
      delete mockMountBindings[id];
      mockDrivesIgnored = [...new Set([...mockDrivesIgnored, gone.volume!.id])];
      return mockDrives();
    }
    case "drive_unforget": {
      const volume = String(args?.volume ?? "");
      mockDrivesIgnored = mockDrivesIgnored.filter((v) => v !== volume);
      return null;
    }
    case "drives_ignored":
      return [...mockDrivesIgnored].sort();
    case "agenda_open_note":
      // the real backend surfaces the main window with this note open
      console.info("[mock] open note from tray agenda", args?.path);
      return null;
    case "agenda_open_capture":
      console.info("[mock] open capture from tray agenda");
      return null;
    // The palette's two exits. Both surface the main window and hide the
    // palette in the real backend — neither is something a browser can do,
    // so the mock says what would have happened.
    case "palette_open_note":
      console.info("[mock] open note from everywhere palette", args?.path);
      return null;
    case "palette_open_view":
      console.info("[mock] open view from everywhere palette", JSON.stringify(args?.view));
      return null;
    // The ⌘K pivot out of quick capture. Rust swaps one window for the other
    // and parks the typed line for the palette to pull; in the browser the
    // two windows are two pages, so the mock parks the line where a
    // navigation survives it and goes to the other page.
    case "capture_pivot_palette":
      sessionStorage.setItem(PALETTE_SEED_KEY, String(args?.text ?? ""));
      window.location.href = "/palette.html";
      return null;
    case "palette_seed_query":
      // reading does not consume it, exactly as in Rust: the palette clears
      // its box first and asks afterwards
      return sessionStorage.getItem(PALETTE_SEED_KEY) ?? "";
    // In the browser mock nothing ever hands us a `substrate://`
    // link — the scheme is registered with the OS around a packaged app — so
    // the queue is always empty and the prefill always absent.
    case "deeplink_take_pending":
      return [];
    case "deeplink_capture_prefill":
      return null;
    case "deeplink_clear_capture_prefill":
      return null;
    /* Context-bound capture. The real backend snapshots the frontmost app
       before the capture window is shown; the mock hands back whatever a spec
       staged, which is `null` — no chip — until one does. `context_request_access`
       is the one command that prompts on a real Mac, so the mock never models
       more than the answer: specs flip trust with __mockSetAxTrusted. */
    case "context_pending":
      return mockContext;
    case "context_ax_trusted":
      return mockAxTrusted;
    case "context_request_access":
      return mockAxTrusted;
    case "agenda_resize":
      // the real backend clamps this and re-anchors the popover under the tray
      console.info("[mock] resize tray agenda", args?.height);
      return null;
    case "vault_saved_views_read":
      return [...mockSavedViews];
    case "vault_saved_view_set": {
      // mirrors Engine::set_saved_view — upsert by id, pin order kept
      const view = args?.view as SavedView;
      if (!view.id?.trim() || !view.name?.trim() || !view.db?.trim()) {
        throw new Error("saved view needs a non-empty id, name, and db");
      }
      const i = mockSavedViews.findIndex((v) => v.id === view.id);
      if (i === -1) mockSavedViews.push(view);
      else mockSavedViews[i] = view;
      return [...mockSavedViews];
    }
    case "vault_saved_view_delete": {
      mockSavedViews = mockSavedViews.filter((v) => v.id !== args?.id);
      // a deleted saved view takes its key with it (engine drop_sidebar_key_saved_view)
      mockRetargetSidebarKeys((t) => (t === `sv:${args?.id}` ? null : undefined));
      return [...mockSavedViews];
    }
    /* The link folder itself is real-filesystem work the mock can't
       do, so the mock backend models the part the UI depends on — which view
       has a remembered target, and what a run reports back. */
    case "view_export_target":
      return mockExportTargets.get(args?.viewId as string) ?? null;
    case "view_export_run": {
      const dest = args?.dest as string;
      const paths = (args?.paths as string[]) ?? [];
      mockExportTargets.set(args?.viewId as string, dest);
      return { dest, links: paths.length, missing: 0, kept: 0 };
    }
    case "view_export_forget":
      mockExportTargets.delete(args?.viewId as string);
      return undefined;

    case "history_list": {
      const n = find();
      if (n) return mockEntries(n.path, snapsFor(n));
      // off-disk paths (trashed/deleted notes) keep their snapshots, like the engine
      const path = args?.path as string;
      return mockEntries(path, mockHistory.get(path) ?? []);
    }
    case "history_facts": {
      // the mock vault's three snapshot levels (now, -3h, -27h) as fact lanes
      // one point per *change*, oldest first, so `valueAt` binary
      // searches the same shape the real revwalk produces. Numeric facts are
      // walked back so a history chart has a slope to draw; everything else
      // simply held its present value for as long as history goes back.
      const refs = (args?.refs ?? []) as { path: string; key: string }[];
      return refs.map((r) => {
        const n = mockNotes.find((m) => m.path === r.path);
        // the key binds case-folded, exact first, the way `fact_value` folds
        // every historical blob (factlane.rs) — a mock that only answered the
        // exact spelling made `PROP(n, "Weight")` look like an absent fact
        const props = n?.props ?? {};
        const raw = props[foldedPropKey(props, r.key)];
        const value =
          raw === null || raw === undefined
            ? null
            : Array.isArray(raw)
              ? raw.map((x) => String(x)).join(", ")
              : String(raw);
        const num = value === null ? null : Number(value);
        const older = num !== null && Number.isFinite(num) ? String(Math.round(num * 0.8)) : value;
        // each point carries its receipt (receipts spec §7) — the two mock writers
        // are the MCP door and the app itself, so a receipts surface has both
        // actor shapes to render without the vault having to be real
        const points =
          value === null
            ? []
            : [
                {
                  ts_ms: now - 27 * 3_600_000,
                  value: older,
                  commit: "vault-snap-2",
                  actor: { kind: "mcp", name: "Claude" },
                  subject: `mcp: note_write ${r.path} (Claude)`,
                },
                {
                  ts_ms: now - 3 * 3_600_000,
                  value,
                  commit: "vault-snap-1",
                  actor: { kind: "app" },
                  subject: "snapshot",
                },
              ];
        return {
          path: r.path,
          key: r.key,
          points,
          oldest_ts_ms: now - 27 * 3_600_000,
          born_ts_ms: null,
        };
      });
    }
    case "history_freshness": {
      // the mock's newest fact point is an ordinary app snapshot on a handful
      // of notes, so nothing in the mock vault is a sweep: every fact that has
      // a value reads as reviewed then, and one with none has no history.
      // The windowed facts (mockSchemaSeed's `review:` props) are the
      // exception — they carry the ages a shelf-life surface exists to show,
      // one per state a reader can meet: past the window, nearing it, well
      // inside it, and one nobody but an import has ever touched.
      const refs = (args?.refs ?? []) as { path: string; key: string }[];
      return refs.map((r) => {
        const n = mockNotes.find((m) => m.path === r.path);
        const props = n?.props ?? {};
        const raw = props[foldedPropKey(props, r.key)];
        const has = raw !== null && raw !== undefined;
        const aged = mockFactAges[`${r.path}#${r.key.toLowerCase()}`];
        const dated = has && !(aged && aged.days === null);
        const ts = aged?.days != null ? now - aged.days * 86_400_000 : now - 3 * 3_600_000;
        return {
          path: r.path,
          key: r.key,
          reviewed_ts_ms: dated ? ts : null,
          reviewed_commit: dated ? "vault-snap-1" : null,
          reviewed_actor: dated ? { kind: "app" } : null,
          only_bulk: has && !dated && (aged?.onlyBulk ?? false),
          oldest_ts_ms: now - 27 * 3_600_000,
        };
      });
    }
    case "history_sheets": {
      // every mock note as it stood at each instant. The mock has no per-day
      // divergence, so a past sheet reads like today's — enough for a spec to
      // prove AT() routed through the historical tree at all; an instant below
      // the trim boundary correctly answers with no snapshot.
      const instants = (args?.instants ?? []) as number[];
      const oldest = now - 27 * 3_600_000;
      return instants.map((instant_ms) => ({
        instant_ms,
        commit: instant_ms < oldest ? null : "vault-snap-0",
        oldest_ts_ms: oldest,
        sheets:
          instant_ms < oldest
            ? []
            : mockNotes.map((n) => ({
                path: n.path,
                title: meta(n).title,
                stem: meta(n).stem,
                body: n.body,
              })),
      }));
    }
    case "history_points":
      return [
        { id: "vault-snap-0", ts_ms: now, subject: "snapshot" },
        { id: "vault-snap-1", ts_ms: now - 3 * 3_600_000, subject: "snapshot" },
        { id: "vault-snap-2", ts_ms: now - 27 * 3_600_000, subject: "snapshot" },
      ];
    case "history_vault_snapshot": {
      // a Deep Recall result jumps to a real commit id rather than to one of
      // the three mock points, and landing SOMEWHERE is the honest mock
      // answer to "put the vault back at this snapshot"
      const asked = Number(String(args?.id ?? "").split("-").pop());
      const level = Number.isFinite(asked) ? Math.max(0, Math.min(2, asked)) : 0;
      const point = [
        { id: "vault-snap-0", ts_ms: now, subject: "snapshot" },
        { id: "vault-snap-1", ts_ms: now - 3 * 3_600_000, subject: "snapshot" },
        { id: "vault-snap-2", ts_ms: now - 27 * 3_600_000, subject: "snapshot" },
      ][level];
      const notes = mockNotes
        .map((note) => ({ ...meta(note), updated_ms: point.ts_ms }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const contents = Object.fromEntries(
        mockNotes.map((note) => [
          note.path,
          { body: snapsFor(note)[level]?.body ?? note.body, props: structuredClone(note.props) },
        ])
      );
      const fm = Object.fromEntries(
        mockNotes
          .filter((note) => Object.keys(note.props).length > 0)
          .map((note) => [
            note.path,
            {
              raw: Object.entries(note.props)
                .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                .join("\n"),
              error: null,
              repairable: true,
            },
          ])
      );
      return {
        point,
        notes,
        contents,
        fm,
        folders: [...mockFolders].sort(),
        views: structuredClone(mockViews),
        schema: structuredClone(mockSchema),
        sidebar_order: structuredClone(mockSidebarOrder),
        saved_views: structuredClone(mockSavedViews),
        folder_meta: structuredClone(mockFolderMeta),
      };
    }
    case "history_diff": {
      const file = args?.file as string;
      const n = mockNotes.find((m) => m.path === file);
      if (!n) return [];
      const snaps = snapsFor(n);
      const i = snaps.findIndex((s) => s.id === args?.id);
      if (i === -1) return [];
      return mockDiff(snaps[i + 1]?.body ?? "", snaps[i].body);
    }
    case "history_restore": {
      const n = find();
      if (!n) throw new Error("not found");
      const snaps = snapsFor(n);
      const vaultLevel = String(args?.id ?? "").startsWith("vault-snap-")
        ? Number(String(args?.id).split("-").pop())
        : null;
      const snap = vaultLevel === null ? snaps.find((s) => s.id === args?.id) : snaps[vaultLevel];
      if (!snap) throw new Error("snapshot not found");
      n.body = snap.body;
      n.updated_ms = Date.now();
      snaps.unshift({
        id: `snap${++mockSnapSeq}`,
        ts_ms: n.updated_ms,
        subject: `restore ${n.path}`,
        body: snap.body,
      });
      return meta(n);
    }
    case "history_purge_note": {
      mockPurgeHistory(args?.path as string);
      return null;
    }
    case "history_purge_notes": {
      for (const path of (args?.paths as string[]) ?? []) mockPurgeHistory(path);
      return null;
    }
    case "history_trim": {
      const cutoff = (args?.beforeMs as number) ?? 0;
      for (const n of mockNotes) {
        const snaps = snapsFor(n);
        const kept = snaps.filter((s) => s.ts_ms >= cutoff);
        mockHistory.set(n.path, kept.length > 0 ? kept : [snaps[0]]);
      }
      return null;
    }
    case "history_status":
      // the mock vault's repo is always app-created — history stays enabled
      return { available: true, enabled: true };
    default:
      throw new Error(`unknown command ${cmd}`);
  }
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
  }
  return result;
};

/* Mock event registry: the real listen() bridges the engine's file
   watcher; the mock keeps its own handlers so specs can fire vault:changed
   (and any future event) through window.__mockEmit. Unlisten really removes —
   the old no-op made the external-change lanes unreachable from e2e. */
type MockEventHandler = (event: { event: string; payload: unknown }) => void;
const mockListeners = new Map<string, Map<number, MockEventHandler>>();
let mockListenerSeq = 0;

const mockListen: typeof tauriListen = async (event, handler) => {
  const id = ++mockListenerSeq;
  let handlers = mockListeners.get(event);
  if (!handlers) mockListeners.set(event, (handlers = new Map()));
  handlers.set(id, handler as MockEventHandler);
  return () => {
    handlers.delete(id);
  };
};

export const listen: typeof tauriListen = isTauri ? tauriListen : mockListen;

/* e2e-only surface: installed only outside Tauri, so the
   shipped app never carries it. Specs stage watcher events, external edits
   and asset re-bounces through these; failures ride __mockFail above. */
if (!isTauri) {
  window.__mockEmit = (event, payload) => {
    for (const fn of mockListeners.get(event)?.values() ?? []) {
      fn({ event, payload });
    }
  };
  window.__mockEditNote = (path, body) => {
    // straight into the store, bypassing vault_write_body's conflict guard —
    // that bypass is the point: this simulates an editor outside the app
    const n = mockNotes.find((m) => m.path === path);
    if (!n) throw new Error(`__mockEditNote: no mock note at ${path}`);
    n.body = body;
    n.updated_ms = Date.now();
    mockEnforceSealScope(n);
  };
  // a marker arriving by sync: the file lands, this device never
  // confirmed it, so nothing is sealed and no history is touched
  window.__mockPlantSealScope = (path) => {
    const scope = path.replace(/^[/\\]+|[/\\]+$/g, "");
    mockSealScopes.add(scope);
    mockUnconfirmedSealScopes.add(scope);
    // the marker file is not a note, so the watcher reports it the way lib.rs
    // does: seal scopes changed, notes untouched
    window.__mockEmit?.("vault:seal-scopes-changed");
  };
  // the file vanishing under the app: same outside-the-app bypass as
  // __mockEditNote, so a subsequent vault_read rejects the way a real one does
  window.__mockDeleteNote = (path) => {
    const i = mockNotes.findIndex((m) => m.path === path);
    if (i < 0) throw new Error(`__mockDeleteNote: no mock note at ${path}`);
    mockNotes.splice(i, 1);
  };
  window.__mockCloneNote = (sourcePath, path) => {
    const source = mockNotes.find((m) => m.path === sourcePath);
    if (!source) throw new Error(`__mockCloneNote: no mock note at ${sourcePath}`);
    if (mockNotes.some((m) => m.path === path))
      throw new Error(`__mockCloneNote: mock note already exists at ${path}`);
    const stem = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const clone: MockNote = {
      ...source,
      path,
      stem,
      title: stem,
      folder,
      props: { ...source.props },
      updated_ms: Date.now(),
    };
    mockEnforceSealScope(clone);
    mockNotes.push(clone);
  };
  window.__mockEditProp = (path, key, value) => {
    // straight into the store, bypassing vault_set_prop's expected-guard —
    // that bypass is the point: this is a writer that isn't us. Settings.md
    // lives outside mockNotes (see mockSettings) but is reachable here for
    // the same reason: an agent writing `feed-curator` is exactly such a
    // writer, and the feedrefresh spec seeds that state.
    if (path === "Settings.md") {
      if (value === null) delete mockSettings.props[key];
      else mockSettings.props[key] = value;
      mockSettings.updated_ms = Date.now();
      return;
    }
    const n = mockNotes.find((m) => m.path === path);
    if (!n) throw new Error(`__mockEditProp: no mock note at ${path}`);
    if (value === null) delete n.props[key];
    else n.props[key] = value as never;
    n.updated_ms = Date.now();
  };
  window.__mockEditSchema = (dbType, props) => {
    mockSchema[dbType] = mockRecord(props);
  };
  window.__mockResetSyncRemote = () => {
    mockVaultSyncStatus = { configured: false, last_result: null, last_error: null };
    mockSyncRemote = { kind: "none", url: null };
    mockRewriteBlocked = false;
    mockReplacedStore = null;
    mockVaultKeyDocument = null;
    mockVaultKeyHeldLocally = false;
  };
  window.__mockStoredSyncRemoteUrl = () => mockSyncRemote.url;
  window.__mockPropOf = (path, key) => {
    const n = mockNotes.find((m) => m.path === path);
    if (!n) throw new Error(`__mockPropOf: no mock note at ${path}`);
    return n.props[key];
  };
  window.__mockBodyOf = (path) => {
    const n = mockNotes.find((m) => m.path === path);
    if (!n) throw new Error(`__mockBodyOf: no mock note at ${path}`);
    return n.body;
  };
  window.__mockNotesDump = () => mockNotes.map((n) => ({ path: n.path, body: n.body }));
  window.__mockSealedUnlocked = () => [...mockUnlockedSealed].sort();
  window.__mockTouchAsset = (name) => {
    mockAssetMtimes.set(name, (mockAssetMtimes.get(name) ?? 1) + 1);
  };
  // an asset appearing on disk without an app write: no echo
  // window, so the next __mockEmit refreshes immediately
  window.__mockSaveAsset = (name, data) => {
    mockAssets.set(name, data);
  };
  window.__mockSetExportTarget = (viewName, dest) => {
    const view = mockSavedViews.find((v) => v.name === viewName);
    if (!view) throw new Error(`__mockSetExportTarget: no saved view named ${viewName}`);
    mockExportTargets.set(view.id, dest);
  };
  window.__mockStageReflexesFile = (opts) => {
    mockReflexes.hasFile = true;
    mockReflexes.filePaused = Boolean(opts?.filePaused);
  };
  // Opt-ins; off by default, reset by the next page load
  window.__mockSetEchoOnWrites = (on) => {
    mockEchoOnWrites = on;
    if (!on) window.clearTimeout(mockEchoTimer); // a pending echo dies with the flag
  };
  window.__mockSetAsync = (on) => {
    mockAsyncDispatch = on === true ? "timeout" : on;
  };
  // Instrumentation: start/read the write-lane command trace
  window.__mockTraceCommands = () => {
    mockCmdTrace = [];
    mockCmdTraceT0 = Date.now();
  };
  window.__mockReadCommandTrace = () => mockCmdTrace ?? [];
  // Park a command mid-flight so a spec can navigate away while it is
  // still pending, then let it land into the world it left behind
  window.__mockHoldCommand = (cmd) => {
    if (mockHeldCommands.has(cmd)) return;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockHeldCommands.set(cmd, gate);
    mockHoldReleases.set(cmd, release);
  };
  // A deterministic slow disk for one command
  window.__mockSetLatency = (cmd, ms) => {
    if (ms > 0) mockLatency.set(cmd, ms);
    else mockLatency.delete(cmd);
  };
  // Stage the snapshot the capture window would have been armed with, and
  // whether the mock Mac has granted Accessibility
  window.__mockSetContext = (snap) => {
    mockContext = snap;
  };
  window.__mockSetAxTrusted = (trusted) => {
    mockAxTrusted = trusted;
  };
  // Refuse the NEXT call to cmd and only that one (calls counted in
  // call order, so it binds before the latency wait — see mockInvoke)
  window.__mockFailOnce = (cmd) => {
    mockFailOnce.set(cmd, (mockFailOnce.get(cmd) ?? 0) + 1);
  };
  window.__mockReleaseCommand = (cmd) => {
    mockHeldCommands.delete(cmd);
    mockHoldReleases.get(cmd)?.();
    mockHoldReleases.delete(cmd);
  };
  // A windowing-sized list. Half the seeds carry a subtitle prop, so
  // the two row heights the offset math distinguishes are both present.
  window.__mockSeedNotes = (folder, count) => {
    for (let i = 0; i < count; i++) {
      const stem = `Seeded ${String(i + 1).padStart(4, "0")}`;
      mockNotes.push({
        path: folder ? `${folder}/${stem}.md` : `${stem}.md`,
        stem,
        title: stem,
        folder,
        props: i % 2 === 0 ? { created: day(0), status: "seeded" } : { created: day(0) },
        updated_ms: now - (i + 1) * 1000,
        excerpt: "",
        body: "",
      });
    }
  };
  // A cap-sized match set. `where` decides the rank — a title hit
  // sorts ahead of every body-only one, so seeding the untyped bulk into
  // titles and the typed few into late body text puts the typed notes outside
  // the top N on purpose. That is the whole point: a cap applied before the
  // caller's `type:` filter renders them as "No results".
  window.__mockSeedMatching = ({ folder, count, token, where, noteType }) => {
    for (let i = 0; i < count; i++) {
      const stem = `${folder} ${String(i + 1).padStart(4, "0")}`;
      const title = where === "title" ? `${stem} ${token}` : stem;
      const body =
        where === "body" ? `padding padding padding padding\n\n${token} appears late\n` : "";
      mockNotes.push({
        path: `${folder}/${stem}.md`,
        stem,
        title,
        folder,
        props: noteType ? { created: day(0), type: noteType } : { created: day(0) },
        updated_ms: now - (i + 1) * 1000,
        excerpt: body.split("\n")[0] ?? "",
        body,
      });
    }
  };
  // Stage the no-vault state the real backend reaches on a machine
  // with neither VAULT_DIR, a stored choice, nor ~/Vault
  window.__mockSetFirstRun = (on) => {
    mockFirstRun = on;
  };
  window.__mockRelaunched = () => mockRelaunched;
  window.__mockAgentCommand = () => mockAgentCommand;
  // Stage a merge that was parked before the app restarted. The
  // engine keeps it in git refs, so status still reports it; only the
  // session's last-result record is gone, which is exactly what this leaves.
  window.__mockWriteKind = async ({
    id,
    manifest,
    files,
    enabled,
    enabledHash,
    enabledApi,
    trustUpdates,
  }) => {
    const all: Record<string, string> = { "kind.json": manifest, ...files };
    // hashed over the same bytes the real loader hashes, so a spec that edits
    // one file and re-seeds reproduces real drift rather than a staged flag
    const hash = await hashKindBundle(all);
    const row: KindBundleInfo = {
      id,
      hash,
      manifest: parseKindManifest(id, manifest),
      // the same metadata the loader derives from the bytes it hashed, so the
      // review pane's file list is real in the mock lane too
      files: Object.keys(all)
        .sort()
        .map((name) => ({ name, bytes: new TextEncoder().encode(all[name]).length })),
    };
    if (enabled || enabledHash) {
      row.record = {
        hash: enabledHash ?? hash,
        api: enabledApi ?? KIND_API,
        enabledAt: "2026-08-01T09:00:00Z",
        ...(trustUpdates ? { trustUpdates: true } : {}),
      };
    }
    const at = mockKinds.findIndex((k) => k.row.id === id);
    const entry = { row, files: all };
    if (at < 0) mockKinds.push(entry);
    else mockKinds[at] = entry;
  };
  window.__mockClearKinds = () => {
    mockKinds.length = 0;
  };
  window.__mockKindFile = (id, file) => mockKinds.find((k) => k.row.id === id)?.files[file];
  window.__mockParkConflicts = () => {
    mockConflicts = mockConflictSeed();
  };
  window.__mockSetPull = (plan) => {
    mockPullPlan = plan;
  };
  window.__mockSyncCalls = () => [...mockSyncCalls];
  window.__mockHostedVault = (vault) => {
    mockHostedVault = vault ? { ...vault } : null;
  };
  window.__mockSyncRewriteBlocked = (blocked) => {
    mockRewriteBlocked = blocked;
  };
  window.__mockSyncReplacedStore = (state) => {
    mockReplacedStore = state ? { ...state } : null;
  };
  window.__mockSetPrivacy = (notice) => {
    mockPrivacyNotice = notice ? { message: notice.message, paths: [...notice.paths] } : null;
  };
  window.__mockSetSyncNotice = (notice) => {
    mockSyncNotice = notice;
  };
  // The other-machine board. The index stays exactly as the machine
  // holding the folder left it — only this machine's binding goes — so a
  // dashboard over the mount still has rows to chart.
  // The hand-authored half of a mount: `.vault/mounts.json` is the UI for an
  // ignore list, and a spec has no file to edit.
  window.__mockSetMountIgnore = (name, patterns) => {
    const m = mockMounts.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (m) m.ignore = patterns;
    else mockPendingIgnore.set(name.toLowerCase(), patterns);
  };
  window.__mockUnbindMount = (name, path) => {
    const m = mockMounts.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!m) throw new Error(`no such mount: ${name}`);
    if (path == null) delete mockMountBindings[m.id];
    else mockMountBindings[m.id] = path;
  };
}
