import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type {
  AggKind,
  CalendarFeedConfig,
  ConflictSide,
  ConflictState,
  DbIcon,
  DiffLine,
  FolderMetaMap,
  HistoryEntry,
  MountInfo,
  MountRow,
  MountScanStats,
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
  TagCount,
  TagFolder,
  TrashEntry,
  VaultSyncStatus,
  ViewsConfig,
} from "./types.ts";
import { daysAgoIso } from "./dates.ts";
import { stripMachineFences } from "./fences.ts";
import { noteTags, propTags, tagUniverse } from "./tags.ts";
import { MOCK_FX, MOCK_FX_RATES } from "./fx.ts";
import { MOUNT_EXTRACTED, MOUNT_SCHEME } from "./mounts.ts";
import { noteOwnWrite } from "./ownwrites.ts";
import { remapSavedQueryProperty } from "./query.ts";
import { isSystemPropName } from "./schemalookup.ts";
import { isAppFile } from "./settings.ts";
import { hashKindBundle, parseKindManifest, KIND_API, type KindBundleInfo } from "./kinds.ts";
import { embedTarget, parseWikiLink } from "./wikilinks.ts";

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

/* The guard is an ALLOW-list, not a deny-list. The first shape only
   denied `history_*`/`vault_*` plus three names, so every other family passed
   by default — sync_control could push the historical projection to a remote,
   jobs_control could run a job against it, term_spawn could open a shell in a
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
  "vault_tags",
  "vault_tag_folders_read",
  "vault_sync_status",
  "vault_sync_conflicts",
  "vault_trash_list",
  /* app-shell reads with no vault side effect */
  "onboarding_status",
  "path_exists",
  "drop_shift_down",
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
    /** stub the settings pane's terminal-font availability check:
        the real one measures canvas text, and whether an unknown family is
        dropped (CoreText) or substituted (fontconfig) is platform-specific,
        so a spec asserting the hint installs deterministic answers here */
    __mockFontAvailable?: (family: string) => boolean;
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
    /** unbind a mount on "this machine" without touching its index — the
        other-machine board a dashboard has to keep charting from.
        Pass a folder path to bind it somewhere instead; a path containing
        "missing" is the folder-went-away case. */
    __mockUnbindMount?: (name: string, path?: string) => void;
  }
}

/** `sealed` is REQUIRED on `NoteMeta` but stays optional on the
    fixture: nearly a hundred seed notes are plaintext, and `meta()` below is
    the single boundary where a fixture becomes a `NoteMeta`, so it fills the
    default there rather than making every literal carry `sealed: false`. */
interface MockNote extends Omit<NoteMeta, "sealed"> {
  sealed?: boolean;
  body: string;
  /** vault_read rejects for these — a file that vanished or became unreadable */
  unreadable?: boolean;
  /** raw frontmatter block, no fences — tracked only when the
      block's health matters (the repair lane); absent = no block, so
      vault_fm_raw returns null like the engine on a block-less file */
  fm?: string;
  /** The file opens with `---` and never closes it. The engine sees
      no block at all (split_frontmatter returns None), so `fm` stays absent —
      but prop writes still refuse, and the banner says so without offering a
      repair dialog there is no block to fill. */
  fmUnterminated?: boolean;
}

const now = Date.now();

/** An ISO day `d` days from today — the ```progress fixtures need
    deadlines that stay in the future, since a fence's pace line reads against
    the real calendar and a hard-coded date would rot the fixture. Built on
    daysAgoIso so the day is a LOCAL calendar day: a UTC slice would land a day
    off near local midnight, against the todayIso() the pace line reads. */
const isoDay = (d: number) => daysAgoIso(-d, new Date(now));

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
let mockMcpGrants: { client: string; prefix: string; access: "read" | "write" }[] = [];

/** local YYYY-MM-DD, `offset` days from today — keeps demo calendar entries
    near whatever day the app is opened */
const day = (offset: number) => {
  const d = new Date(now + offset * 86_400_000);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${dd}`;
};

/* Mock `.assets/`: name → base64 payload. `blueprint-sketch.png` is embedded in
   Static Bouquet (GC must leave it alone); `stale-screenshot.png` and
   `old-bounce.wav` are orphaned on purpose so the Assets pane has both an image
   and a non-image row to find in the browser. `some.pdf` backs the file-chip
   lane — chips never decode the payload, so a stub suffices. */
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";


const mockAssets = new Map<string, string>([
  ["blueprint-sketch.png", PIXEL_PNG],
  ["stale-screenshot.png", PIXEL_PNG],
  ["old-bounce.wav", ""],
  ["some.pdf", "JVBERi0xLjQKbW9jayBwZGYgZm9yIGUyZQo="],
  // routing stand-in for the wide image set (heic renders inline, not as a
  // chip) — payload is a png pixel; e2e asserts the widget, not the decode
  ["IMG_0231.heic", PIXEL_PNG],
]);

// one real stored asset so the §6 inline-image path and the gallery's
// body-embed fallback both render in the browser gate
mockAssets.set(
  "vessel-artwork.svg",
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">` +
      `<rect width="320" height="320" fill="#14161a"/>` +
      `<circle cx="160" cy="132" r="74" fill="none" stroke="hsla(210,18%,70%,0.5)" stroke-width="1.5"/>` +
      `<circle cx="160" cy="132" r="46" fill="none" stroke="hsla(210,14%,60%,0.28)" stroke-width="1"/>` +
      `<rect x="52" y="236" width="216" height="2" fill="hsla(210,16%,72%,0.35)"/>` +
      `</svg>`
  )
);

/* Per-name asset mtimes: vault_asset_info reads from here so an e2e
   re-bounce (window.__mockTouchAsset) changes the asset's cacheKey — the
   constant 1 made the audio-player rebind lane unreachable from specs. */
const mockAssetMtimes = new Map<string, number>();

/* The loose (non-.md) files a folder view lists as rows, per folder.
   Notes live in mockNotes; these are the rest of what sits on disk beside
   them. Nothing under `.assets/` appears here and nothing here is an asset —
   that separation IS the dedupe rule the real engine enforces by skipping
   dot-paths, so the browser gate exercises the same shape.
   Deliberately a mix: two audio files (the playlist) and one that isn't
   (the open/reveal row). */
const mockLooseFiles = new Map<string, string[]>([
  ["Projects", ["01 umbra rough.wav", "02 umbra bounce.wav", "umbra session.als"]],
]);

/** One stable mtime for every loose file: the player's cacheKey is built from
    path+size+mtime, so a value that moved between calls would rebind players
    mid-spec. */
const mockLooseMtime = now - 3 * 86_400_000;

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

const mockNotes: MockNote[] = [
  {
    path: "Welcome.md",
    stem: "Welcome",
    title: "Welcome",
    folder: "",
    props: { created: "2026-07-17" },
    updated_ms: now - 3 * 60_000,
    excerpt: "Everything here is a plain markdown file on disk.",
    body: "Everything here is a plain markdown file on disk. A note becomes a database row by gaining properties — nothing ever moves.\n\n## The basics\n\n- **⌘K** — command palette: open anything, create anything, search everything\n- **⌘N** — capture a thought into the Inbox, zero filing decisions\n- Link notes with [[Slow Bloom EP]] style wikilinks — backlinks appear at the bottom\n\nThe `code chips` render inline, *emphasis* and **strong** style live.\n\n## Checklists and tables\n\n- [ ] tasks render as real checkboxes — click one to flip it\n- [x] done items get struck through\n\n| release | status | artist |\n| --- | --- | --- |\n| [[Slow Bloom EP]] | in review | various |\n| [[Static Bouquet]] | **live** | chroma weather |\n\n```ts\nfunction apr(yieldUsd: number, principal: number, hours: number): number {\n  // annualized from the observed window\n  return (yieldUsd / principal) * (8760 / hours) * 100;\n}\n```\n",
  },
  {
    path: "Inbox/Capture anything.md",
    stem: "Capture anything",
    title: "Capture anything",
    folder: "Inbox",
    props: { created: "2026-07-17" },
    updated_ms: now - 40 * 60_000,
    excerpt: "This is the Inbox. ⌘N drops new notes here instantly.",
    body: "This is the Inbox. ⌘N drops new notes here instantly — file them later by adding them to a database, or don't.\n",
  },
  /* The seeded agent orientation files: indexed like the real
     engine indexes them, concealed by the App-side filter unless Settings.md
     says `show-agent-files: true` — which is exactly what the e2e spec
     exercises. Bodies are stand-ins, not the shipped seed text. */
  {
    path: "AGENTS.md",
    stem: "AGENTS",
    title: "AGENTS",
    folder: "",
    props: {},
    updated_ms: now - 5 * 86_400_000,
    excerpt: "Mock agent orientation — how to work in this vault.",
    body: "Mock agent orientation — how to work in this vault.\n",
  },
  {
    path: "CLAUDE.md",
    stem: "CLAUDE",
    title: "CLAUDE",
    folder: "",
    props: {},
    updated_ms: now - 5 * 86_400_000,
    excerpt: "Mock pointer at AGENTS.md.",
    body: "Mock pointer at AGENTS.md.\n",
  },
  {
    path: "Slow Bloom EP.md",
    stem: "Slow Bloom EP",
    title: "Slow Bloom EP",
    folder: "",
    props: { type: "release", status: "in review", "cat#": "SMP-030", artist: "various", released: "2026-08-01", artwork: "slow-bloom-cover.png", contact: "Gero", format: "Vinyl", tracks: "8", created: "2026-07-17" },
    updated_ms: now - 2 * 3_600_000,
    excerpt: "Track order still open — the granular rework wants to close the B side.",
    body: "Sample release note. Track order still open — the granular rework wants to close the B side. See [[Static Bouquet]] for the artwork direction.\n",
  },
  {
    path: "Vessel Songs.md",
    stem: "Vessel Songs",
    title: "Vessel Songs",
    folder: "",
    props: { type: "release", status: "mastering", "cat#": "SMP-029", artist: "1k petals", released: "2026-06-19", contract: "~/Documents/missing contract.pdf", format: ["Tape"], tracks: "12", created: "2026-07-17" },
    updated_ms: now - 26 * 3_600_000,
    excerpt: "Masters v2 due back this week; vocal-led opener confirmed.",
    body: "Sample release note. Masters v2 due back this week; vocal-led opener confirmed.\n\n![[vessel-artwork.svg]]\n\n![[vessel-master-v2.wav]]\n\nRough of the opener for reference:\n\n![[opener-vocal-rough.mp3]]\n",
  },
  {
    path: "Static Bouquet.md",
    stem: "Static Bouquet",
    title: "Static Bouquet",
    folder: "",
    props: { type: "release", status: "live", "cat#": "SMP-028", artist: "chroma weather", released: "2026-05-30", contract: "~/Music/masters/static-bouquet.wav", artwork: "![[static-bouquet.png]]", contact: ["Gero", "Noa"], format: ["Vinyl", "Digital"], tracks: "6", created: "2026-07-17" },
    updated_ms: now - 3 * 86_400_000,
    excerpt: "The blue series artwork lives here.",
    body: "Sample release note. The blue series artwork lives here — [[Slow Bloom EP]] follows the same palette.\n\n![[blueprint-sketch.png]]\n",
  },
  {
    path: "Gero.md",
    stem: "Gero",
    title: "Gero",
    folder: "",
    props: { type: "contact", role: "mix engineer", email: "gero@umbra.example", phone: "+49 30 1234567", created: "2026-07-17" },
    updated_ms: now - 4 * 86_400_000,
    excerpt: "Mix engineer based in Lisbon.",
    body: "Mix engineer based in Lisbon. Prefers stems at -18 LUFS integrated.\n",
  },
  {
    path: "Noa.md",
    stem: "Noa",
    title: "Noa",
    folder: "",
    props: { type: "contact", role: "artwork", email: "noa@umbra.example", created: "2026-07-17" },
    updated_ms: now - 5 * 86_400_000,
    excerpt: "Artwork and visual direction.",
    body: "Artwork and visual direction — the blue series and beyond.\n",
  },
  {
    // One note whose frontmatter block is broken (duplicate key).
    // props carry the lenient last-wins read like the engine's parse_props;
    // the fm field is the verbatim block the repair lane surfaces. Untyped
    // and filed in its own folder so no count-based spec sees it.
    path: "Repair/Broken frontmatter.md",
    stem: "Broken frontmatter",
    title: "Broken frontmatter",
    folder: "Repair",
    props: { status: "review", created: "2026-07-17" },
    updated_ms: now - 6 * 86_400_000,
    excerpt: "Seeded with a broken frontmatter block.",
    body: "Seeded with a broken frontmatter block — a duplicate key above. Property edits refuse until it is repaired in-app.\n",
    fm: "status: draft\nstatus: review\ncreated: 2026-07-17\n",
  },
  {
    // The opening fence is never closed, so the engine reads the
    // file as having no frontmatter at all — props are empty and the whole
    // text is body. Prop edits still refuse (they would otherwise serialize
    // a fresh block on top and demote every property to text), and the
    // banner says so without a Repair… button: there is no block to edit.
    path: "Repair/Unterminated frontmatter.md",
    stem: "Unterminated frontmatter",
    title: "Unterminated frontmatter",
    folder: "Repair",
    props: {},
    updated_ms: now - 6 * 86_400_000,
    excerpt: "type: release",
    body: "---\ntype: release\nstatus: live\nSeeded with an opening fence that never closes.\n",
    fmUnterminated: true,
  },
  {
    path: "Dashboards/Yield APR.md",
    stem: "Yield APR",
    title: "Yield APR",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "yield-apr", created: "2026-07-17" },
    updated_ms: now - 10 * 60_000,
    excerpt: "Yield farming APR tracker.",
    body: "Yield farming APR tracker. Snapshots live in the csv block below — the dashboard reads and appends to it.\n\n```csv\nat,yield_usd,principal_usd\n2026-07-17 10:28,3,15600\n2026-07-17 10:35,9,15600\n2026-07-17 10:48,22,15600\n2026-07-17 11:04,38.1,15700\n2026-07-17 11:13,47.4,15600\n2026-07-17 11:57,97,15900\n2026-07-17 12:09,107,15900\n2026-07-17 12:23,122.4,15900\n2026-07-17 12:32,129.7,15900\n2026-07-17 12:33,143.6,15900\n2026-07-17 12:47,143.6,15900\n2026-07-17 13:03,160,15900\n2026-07-17 13:22,178.5,15900\n2026-07-17 14:18,232,15700\n```\n",
  },
  {
    path: "Holdings.md",
    stem: "Holdings",
    title: "Holdings",
    folder: "",
    props: { type: "sheet", created: "2026-07-17" },
    updated_ms: now - 90 * 60_000,
    excerpt: "Portfolio tracker — data rows plus formula columns and totals.",
    body: "Portfolio tracker — rows are data; the formulas block computes columns and totals.\n\n```csv\nasset,bucket,units,price_usd\nGLOW,etf,1200,31.4\nBTC,crypto,4.1,64200\nARC,etf,80,92.5\nETH,crypto,9,3050\n```\n\n```formulas\nvalue_usd = units * price_usd\nvalue_eur = value_usd * FX(\"USD\",\"EUR\")\n\ntotal     = SUM(value_eur)\ncrypto    = SUMIF(bucket, \"crypto\", value_eur)\netf       = SUMIF(bucket, \"etf\", value_eur)\nrest      = total - crypto\npositions = COUNT(units)\nmax_pos   = MAX(value_eur)\ngrand_total = total + Cash.cash_total\n```\n",
  },
  {
    // fixture: the fixed-costs shape — twelve named summaries, most
    // of them describing one column, which is what fills the totals row and
    // leaves the footer to the few that can't be placed.
    path: "Fixed Costs.md",
    stem: "Fixed Costs",
    title: "Fixed Costs",
    folder: "",
    props: { type: "sheet", created: "2026-08-03" },
    updated_ms: now - 70 * 60_000,
    excerpt: "Monthly fixed costs — rent, studio, tools.",
    body: "Monthly fixed costs. Rows are months; the formulas block totals each column.\n\n```csv\nmonth,rent_eur,studio_eur,tools_eur,paid\n2026-01,1240,320,88,yes\n2026-02,1240,320,112,yes\n2026-03,1240,355,64,yes\n2026-04,1290,355,151,yes\n2026-05,1290,355,96,no\n2026-06,1290,380,143,no\n```\n\n```formulas\nmonthly_eur = rent_eur + studio_eur + tools_eur\n\nrent_total    = SUM(rent_eur)\nrent_avg      = AVG(rent_eur)\nstudio_total  = SUM(studio_eur)\nstudio_avg    = AVG(studio_eur)\ntools_total   = SUM(tools_eur)\ntools_peak    = MAX(tools_eur)\ntools_low     = MIN(tools_eur)\nmonthly_total = SUM(monthly_eur)\nmonthly_avg   = AVG(monthly_eur)\nmonths        = COUNTIF(month, \"2026*\")\npaid_eur      = SUMIF(paid, \"yes\", monthly_eur)\nopen_eur      = monthly_total - paid_eur\nannual_plan   = 1290 * 12\n```\n",
  },
  {
    path: "Cash.md",
    stem: "Cash",
    title: "Cash",
    folder: "",
    props: { type: "sheet", created: "2026-07-17" },
    updated_ms: now - 80 * 60_000,
    excerpt: "Cash accounts — referenced by the Holdings sheet (grand_total).",
    body: "Cash accounts. [[Holdings]] adds `cash_total` into its `grand_total` — a cross-sheet reference.\n\n```csv\naccount,balance_eur\nNordkasse,14200\nBrokerhaus,3800\n```\n\n```formulas\ncash_total = SUM(balance_eur)\n```\n",
  },
  {
    path: "Dashboards/Portfolio.md",
    stem: "Portfolio",
    title: "Portfolio",
    folder: "Dashboards",
    props: {
      type: "dashboard",
      dashboard: "metrics",
      cards: [
        // emph: the two anchors of this board (principle 11) — everything
        // between them sinks to the quiet voice
        { label: "Total value", bind: "{{Holdings.total}}", format: "eur", emph: true },
        { label: "Crypto", bind: "{{Holdings.crypto}}", format: "eur" },
        { label: "ETF", bind: "{{Holdings.etf}}", format: "eur" },
        { label: "Positions", bind: "{{Holdings.positions}}", format: "number" },
        { label: "Largest position", bind: "{{Holdings.max_pos}}", format: "eur" },
        // cash rides between the sheet total and the grand total so the two
        // totals reconcile on screen (total + cash = grand total) — a delta
        // the reader can't derive is a number they can't trust
        { label: "Cash", bind: "{{Cash.cash_total}}", format: "eur" },
        { label: "Grand total", bind: "{{Holdings.grand_total}}", format: "eur", emph: true },
      ],
      created: "2026-07-17",
    },
    updated_ms: now - 30 * 60_000,
    excerpt: "Portfolio totals, bound to the Holdings sheet.",
    body: "Cards are bound to summaries on the [[Holdings]] sheet — edit `cards` in this note's frontmatter.\n",
  },
  {
    // workbook pages: metrics page 0 + a sheet page, a view page,
    // and one broken entry — the e2e spec walks all four tabs
    path: "Dashboards/Label Books.md",
    stem: "Label Books",
    title: "Label Books",
    folder: "Dashboards",
    props: {
      type: "dashboard",
      dashboard: "metrics",
      cards: [{ label: "Cash total", bind: "{{Cash.cash_total}}", format: "eur" }],
      pages: [
        { label: "Cash", note: "Cash" },
        { label: "Releases", view: "release", query: "status:live" },
        { label: "Broken", note: "No Such Sheet" },
      ],
      created: "2026-07-17",
    },
    updated_ms: now - 25 * 60_000,
    excerpt: "Label accounting workbook — pages over the cash sheet and releases.",
    body: "Workbook pages live in this note's frontmatter — the tab strip at the bottom switches them.\n",
  },
  {
    path: "Glass Havens.md",
    stem: "Glass Havens",
    title: "Glass Havens",
    folder: "",
    props: { type: "release", status: "live", "cat#": "SMP-027", artist: "fern palace", released: "2026-06-27", tracks: "9", created: "2026-07-17" },
    updated_ms: now - 8 * 86_400_000,
    excerpt: "Second pressing shipped.",
    body: "Sample release note. Second pressing shipped; Bandcamp codes sent to the list.\n",
  },
  {
    path: "Fern Palace.md",
    stem: "Fern Palace",
    title: "Fern Palace",
    folder: "",
    props: { type: "release", status: "mastering", "cat#": "SMP-031", artist: "glass havens", released: "2026-08-23", tracks: "7", created: "2026-07-17" },
    updated_ms: now - 6 * 3_600_000,
    excerpt: "Artwork proofs due Friday.",
    body: "Sample release note. Artwork proofs due Friday; master approved.\n",
  },
  {
    // hub note seed: prose plus a ```view fence over the release db,
    // so the inline-embed render path shows on boot
    path: "Projects/Umbra.md",
    stem: "Umbra",
    title: "Umbra",
    folder: "Projects",
    props: { created: "2026-07-17" },
    updated_ms: now - 12 * 60_000,
    excerpt: "Label hub — the release pipeline, inline.",
    body: "Label hub for the Umbra pipeline. The table below is a `view` fence — a live, editable cut of the release database.\n\n```view\ntype: release\nquery: status:mastering\nview: table\n```\n\nRows open their note from the title cell, other cells edit in place, and the header opens the full database.\n",
  },
  {
    path: "Weight Log.md",
    stem: "Weight Log",
    title: "Weight Log",
    folder: "",
    props: { type: "sheet", created: "2026-07-17" },
    updated_ms: now - 20 * 60_000,
    excerpt: "Daily morning weigh-ins.",
    // fixed history feeds the Overview chart; the three day-relative rows at
    // the end feed the food pane's weight overlay, sparse on purpose
    // so the line has gaps to bridge on any date the suite runs
    body: `Daily morning weigh-ins.\n\n\`\`\`csv\ndate,kg\n2026-07-01,78.9\n2026-07-02,78.6\n2026-07-03,78.8\n2026-07-04,78.4\n2026-07-05,78.5\n2026-07-06,78.2\n2026-07-07,78.3\n2026-07-08,77.9\n2026-07-09,78.1\n2026-07-10,77.8\n2026-07-11,78.0\n2026-07-12,77.7\n2026-07-13,77.9\n2026-07-14,77.6\n${day(-9)},78.4\n${day(-5)},78.0\n${day(0)},77.4\n\`\`\`\n`,
  },
  {
    path: "Dashboards/Overview.md",
    stem: "Overview",
    title: "Overview",
    folder: "Dashboards",
    props: { type: "dashboard", created: "2026-07-17" },
    updated_ms: now - 5 * 60_000,
    excerpt: "Charts over the label databases and sheets.",
    body: "Charts over the label databases and sheets. Each block below is a `chart` fence in this note — edit the text to reconfigure.\n\n```chart\nsource: release\nx: released:month\ny: count\nkind: bar\ntitle: Releases per month\n```\n\n```chart\nsource: release\nx: status\ny: count\nkind: bar\ntitle: Releases by status\n```\n\n```chart\nsource: {{Weight Log}}\nx: date:day\ny: avg:kg\nkind: line\ntitle: Weight (kg)\n```\n\n```chart\nsource: {{Holdings}}\nx: bucket\ny: sum:value_usd\nkind: bar\ntitle: Holdings by bucket\n```\n",
  },
  {
    // subfoldered dashboard seed: lives one level below the
    // dashboards' home folder, so the sidebar renders it under a "Releases"
    // group header instead of in the flat list
    path: "Dashboards/Releases/Label Health.md",
    stem: "Label Health",
    title: "Label Health",
    folder: "Dashboards/Releases",
    props: { type: "dashboard", created: "2026-07-25" },
    updated_ms: now - 11 * 86_400_000,
    excerpt: "Release pipeline health for the label.",
    body: "Release pipeline health for the label.\n\n```chart\nsource: release\nx: status\ny: count\nkind: bar\ntitle: Releases by status\n```\n",
  },
  {
    // hub dashboard seed: `dashboard: hub` — the body is ordinary
    // markdown; the hub renderer lays `##` sections out with consecutive
    // callouts as side-by-side cards, the rest in linear flow. Old
    // updated_ms keeps it out of the Today recency grid; the title sorts
    // between Portfolio and Yield APR in the sidebar.
    // `## People` also holds a hand-typed table of the same shape as the
    // live one below it — the pill-parity fixture: the same role value,
    // typed and queried, must wear the same pill.
    // The two trailing ```view fences are the fixture: `## People`
    // resolves against the four `type: contact` notes and renders a live
    // table, `## Broken` names a database that does not exist and must show
    // its error in place without taking the sections around it down.
    path: "Dashboards/Umbra Home.md",
    stem: "Umbra Home",
    title: "Umbra Home",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "hub", created: "2026-07-17" },
    updated_ms: now - 9 * 86_400_000,
    excerpt: "Label home — the pipeline at a glance.",
    body:
      "Label home — the pipeline at a glance.\n\n## Releases\n\n> [!note] In review\n> [[Slow Bloom EP]] is with the label for sequencing notes.\n> [!warn] Waiting on masters\n> [[Vessel Songs]] masters v2 are due back this week.\n> [!idea] Next up\n> [[Static Bouquet]] blue-series follow-up — pitch the live session.\n> ```chart\n> source: release\n> x: status\n> y: count\n> ```\n> ```cards\n> - label: Nested\n>   bind: {{Holdings.total}}\n> ```\n> ```progress\n> label: Nested goal\n> value: count\n> source: contact\n> target: 8\n> ```\n\nEverything below the cards renders in linear flow.\n\n| release | status |\n| --- | --- |\n| [[Slow Bloom EP]] | in review |\n| [[Vessel Songs]] | mastering |\n\n## Money\n\n> A quoted cards fence is quoted text, not a board:\n> ```cards\n> - label: Quoted\n>   bind: {{Holdings.total}}\n> ```\n\n```cards\n- label: Total value\n  bind: \"{{Holdings.total}}\"\n  format: eur\n  emph: true\n- label: Crypto\n  bind: \"{{Holdings.crypto}}\"\n  format: eur\n- label: Positions\n  bind: \"{{Holdings.positions}}\"\n  format: number\n```\n\n```chart\nsource: {{Holdings}}\nx: bucket\ny: sum:value_usd\nkind: bar\ntitle: Holdings by bucket\n```\n\n```progress\nlabel: Portfolio target\nvalue: {{Holdings.total}}\ntarget: 500000\nformat: eur\n" +
      `deadline: ${isoDay(45)}\n` +
      "```\n\n## People\n\n| person | role |\n| --- | --- |\n| [[Gero]] | mix engineer |\n\n```view\ntype: contact\nview: table\n```\n\n## Release arc\n\n```timeline\nsource: release\nstart: created\nend: released\nlabel: title\ngroup: status\n```\n\n## Broken\n\n```view\ntype: nosuchtype\n```\n\n```chart\nsource: release\nx: status\ny: nonsense\n```\n\n```progress\nlabel: Broken goal\nvalue: count\ntarget: 5\n```\n\n```timeline\nsource: release\nstart: created\n```\n",
  },
  {
    // progress fence seed: a hub body can be only progress fences,
    // which is the standalone fence form without inventing another dashboard
    // kind. It carries a sheet bind, a database count and one malformed fence.
    path: "Dashboards/Goals.md",
    stem: "Goals",
    title: "Goals",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "hub", created: "2026-07-17" },
    updated_ms: now - 9 * 86_400_000,
    excerpt: "Label goals — value against target, with the days left.",
    body:
      "Label goals — each fence puts one number against the number it should reach.\n\n" +
      "```progress\nlabel: Portfolio target\nvalue: {{Holdings.total}}\ntarget: 500000\nformat: eur\n" +
      `deadline: ${isoDay(60)}\nstart: ${isoDay(-30)}\n` +
      "```\n\n" +
      "```progress\nlabel: Contacts logged\nvalue: count\nsource: contact\ntarget: 8\n```\n\n" +
      "```progress\nlabel: Broken goal\nvalue: count\ntarget: 5\n```\n",
  },
  {
    // tasks dashboard seed: a read-only cut of task notes. Areas is
    // an allowlist (YAML lists and comma text both work); stale_days controls
    // when age raises a row out of the quiet layer.
    path: "Dashboards/Tasks.md",
    stem: "Tasks",
    title: "Tasks",
    folder: "Dashboards",
    props: {
      type: "dashboard",
      dashboard: "tasks",
      areas: ["Label", "Studio", "Admin"],
      stale_days: 30,
      created: day(-1),
    },
    updated_ms: now - 9 * 86_400_000,
    excerpt: "Open tasks by area, with old high-priority work surfaced first.",
    body: "A read-only attention view over task notes. Configure its area allowlist and stale threshold in this note's frontmatter.\n",
  },
  {
    // food dashboard seed: `dashboard: food` — config props only,
    // rows live in the Food Log sheet below. Old updated_ms keeps it out of
    // the Today recency grid.
    path: "Dashboards/Calories.md",
    stem: "Calories",
    title: "Calories",
    folder: "Dashboards",
    props: {
      type: "dashboard",
      dashboard: "food",
      log: "Food Log",
      floor: "1900",
      ceiling: "2300",
      created: "2026-07-21",
    },
    updated_ms: now - 9 * 86_400_000,
    excerpt: "Net-kcal tracker — 1900–2300 band, quick add.",
    body: "Net-kcal tracker. Rows live in the Food Log sheet; the band is a floor, not a target.\n",
  },
  {
    // the food dashboard's log sheet — day-relative rows so the strip and
    // today's totals always have data: one in-band day, one under, one over,
    // an exercise row today, a comma-quoted name for CSV round-tripping
    path: "Food Log.md",
    stem: "Food Log",
    title: "Food Log",
    folder: "",
    props: { type: "sheet", created: "2026-07-21" },
    updated_ms: now - 25 * 60_000,
    excerpt: "Daily food log — net kcal, negative = exercise.",
    body: `Daily food log — net kcal, negative = exercise.\n\n\`\`\`csv\ndate,food,kcal,protein_g\n${day(-3)},Chicken bowl,650,45\n${day(-3)},Skyr,180,30\n${day(-3)},Toast,700,20\n${day(-2)},"Pasta, alla vodka",815,24\n${day(-1)},Ramen,700,40\n${day(-1)},Flat white,90,6\n${day(-1)},Tortellini,780,32\n${day(-1)},Porridge,320,20\n${day(0)},Chicken bowl,650,45\n${day(0)},Gym,-300,\n\`\`\`\n`,
  },
  {
    // the food dashboard's DB: stable kcal bases the autocomplete
    // prices from, one per basis kind. Names keep clear of the seeded log
    // foods so the log-memory fixtures (Flat white placeholder, Ramen accept)
    // keep exercising the log-only path. Old updated_ms: out of Today's
    // recency grid.
    path: "Food DB.md",
    stem: "Food DB",
    title: "Food DB",
    folder: "",
    props: { type: "sheet", created: "2026-07-24" },
    updated_ms: now - 9 * 86_400_000,
    excerpt: "Food kcal bases — per 100 g, 100 ml, or unit.",
    body: "Food kcal bases — per 100 g, 100 ml, or unit.\n\n```csv\nname,kcal,per,protein\nChevroux,265,100g,18\nClub Mate,25,100ml,\nEggs,80,x,7\n```\n",
  },
  {
    // feed dashboard seed: `dashboard: feed` — config props only,
    // items live in the News Items sheet below. `curated` renders verbatim;
    // day-relative so the pane's ~36h staleness dot stays quiet by
    // default — specs that want it stale rewrite the prop. Old updated_ms
    // keeps it out of the Today recency grid.
    path: "Dashboards/News.md",
    stem: "News",
    title: "News",
    folder: "Dashboards",
    props: {
      type: "dashboard",
      dashboard: "feed",
      items: "News Items",
      curated: `${day(0)} 09:10`,
      created: "2026-07-26",
    },
    updated_ms: now - 9 * 86_400_000,
    excerpt: "Curated newsfeed — the agent writes it, you rate it.",
    body: "A curated newsfeed. The curator agent writes the News Items sheet; this pane renders it and writes only the fb column.\n",
  },
  {
    // the feed dashboard's items sheet — two days so the date grouping shows,
    // one row per verdict state (up / down / unrated), a comma-quoted title
    // for CSV round-tripping, and one row with no url so the pane's
    // nothing-clickable branch is exercised
    path: "News Items.md",
    stem: "News Items",
    title: "News Items",
    folder: "",
    props: { type: "sheet", created: "2026-07-26" },
    updated_ms: now - 40 * 60_000,
    excerpt: "Curated news rows — the app writes only fb.",
    body: `Curated news rows — the app writes only the fb column.\n\n\`\`\`csv\ndate,topic,title,source,url,blurb,why,fb\n${day(0)},plugins,"Zynaptiq ships Morph 3, realtime now",CDM,https://cdm.link/example/morph3,"Spectral morph between two sources, low enough latency to play live.","Ada Voss's spectral chain is all offline — this one she could perform with.",up\n${day(0)},hardware,M8 firmware 4.2 adds per-track sends,Dirtywave,https://dirtywave.com/example/m8-42,"Two global send busses, addressable per track.","The Slow Bloom sketches lose their space in the DAW; sends travel with the song.",\n${day(0)},scene,Umbra announces a four-date label night,Resident Advisor,,"Four nights across autumn, lineup in waves.","chroma weather plays the second date — first live set since the mixes went out.",\n${day(-1)},ai,Open-weights stem separator beats Demucs on drums,Hacker News,https://news.ycombinator.com/example/stems,"Runs locally, ~2x realtime on Apple silicon.","Archive salvage: the variants with no stems could get usable ones.",down\n${day(-1)},wild,A granular synth built inside a spreadsheet,lines,https://llllllll.co/example/sheet-granular,"12000 formula cells scheduling grains at 30fps.","Filed purely because it is a good trick — no deadline attached.",\n\`\`\`\n`,
  },
  {
    // music-work dashboard seed: `dashboard: music-work` — config
    // props only, the jobs live in the Work Index sheet below
    path: "Dashboards/Music Work.md",
    stem: "Music Work",
    title: "Music Work",
    folder: "Dashboards",
    props: {
      type: "dashboard",
      dashboard: "music-work",
      index: "Work Index",
      scanned: "2026-07-30 00:10",
      created: "2026-07-30",
    },
    updated_ms: now - 9 * 86_400_000,
    excerpt: "Every production job, pivoted by year, artist or category.",
    body: "The production tree is category-first, so this board supplies the axes it can't: year, artist, category over the same scanned rows.\n",
  },
  {
    // the music-work board's index sheet — three years and three categories so
    // every view groups more than once, one flagged row for the warning chip,
    // one 0 MB job for the dust rule, and a comma-quoted job name for CSV
    // round-tripping
    path: "Work Index.md",
    stem: "Work Index",
    title: "Work Index",
    folder: "",
    props: { type: "sheet", scanned: "2026-07-30 00:10", created: "2026-07-30" },
    updated_ms: now - 55 * 60_000,
    excerpt: "Scanned production jobs — the scanner writes it, the app only reads.",
    body: "Scanned production jobs — written by the nightly tree scan, never hand-edited.\n\n```csv\ncategory,client,job,year,last_active,files,size_mb,flags\nMASTERING,Ada Voss,Voss Signal,2026,2026-06-13,318,23949,\nMASTERING,Mira,mira master v2,2026,2026-03-02,12,340,\nMASTERING,Mira,Fern Static,2025,2026-07-29,51,1392,name 2025 vs files 2026\nMIXING,Juno Marek,ep4,2026,2026-07-18,196,14324,\nMIXING,Mira,\"mira adjust, alt take\",2026,2026-01-06,3,0,\nMIXING,Halo Ferry,drums session,2025,2025-11-02,88,6210,\nOWN WORK,NIGHT CIRCUIT (2026),night circuit,2026,2026-06-01,10,280,\nOWN WORK,COLLABS,Lila,2024,2024-01-23,54,3880,\n```\n",
  },
  {
    /* A mount sidecar whose file is no longer in the mounted folder:
       the annotations survive, the row renders missing. Sidecars live under
       Mounts/<mount name>/ and bind by content identity, not by path. */
    path: "Mounts/finance-doc/2025-11 Invoice Old Vendor.md",
    stem: "2025-11 Invoice Old Vendor",
    title: "2025-11 Invoice Old Vendor",
    folder: "Mounts/finance-doc",
    props: {
      created: "2026-07-17",
      type: "finance-doc",
      mount: "mount-finance",
      mount_file: "2025-11 Invoice Old Vendor.pdf",
      mount_identity: "id-2025-11 invoice old vendor.pdf",
      year: "2025",
      category: "invoice",
      status: "booked",
    },
    updated_ms: now - 20 * 86_400_000,
    excerpt: "",
    body: "",
  },
  {
    path: "Rondo MX180.md",
    stem: "Rondo MX180",
    title: "Rondo MX180",
    folder: "",
    props: { type: "gear", category: "mixer", status: "in studio", manual: "~/Downloads/rondo-mx180-manual.pdf", created: "2026-07-17" },
    updated_ms: now - 5 * 86_400_000,
    excerpt: "Rotary mixer, main console spot.",
    body: "Sample gear note. Rotary mixer, main console spot. Service history and patchbay routing notes go here.\n",
  },
  {
    path: "Tasks/Master Vessel Songs v3.md",
    stem: "Master Vessel Songs v3",
    title: "Master Vessel Songs v3",
    folder: "Tasks",
    props: {
      type: "task",
      status: "doing",
      area: "Studio",
      priority: "High",
      // pinned to the board's Now section — hand-picked focus,
      // so its 46-day age raises no stale finding there
      now: true,
      due: day(2),
      created: day(-46),
    },
    updated_ms: now - 5 * 60_000,
    excerpt: "v3 revisions for 1k petals — low-end notes addressed.",
    body: "v3 revisions for [[Vessel Songs]] — low-end notes addressed. Bounce and send.\n",
  },
  {
    path: "Tasks/Approve SMP-030 artwork.md",
    stem: "Approve SMP-030 artwork",
    title: "Approve SMP-030 artwork",
    folder: "Tasks",
    props: {
      type: "task",
      status: "todo",
      area: "Label",
      priority: "High",
      due: day(0),
      created: day(-12),
    },
    updated_ms: now - 30 * 60_000,
    excerpt: "Final check on the blue series before it goes to the plant.",
    body: "Final check on the blue series before it goes to the plant. See [[Static Bouquet]].\n",
  },
  {
    path: "Tasks/Send SMP-029 promos.md",
    stem: "Send SMP-029 promos",
    title: "Send SMP-029 promos",
    folder: "Tasks",
    props: {
      type: "task",
      status: "todo",
      area: "Label",
      priority: "Medium",
      // snoozed off the tasks board until next week — counted in
      // the header tally, hidden from the groups. Other surfaces (database
      // views, Today) ignore snoozed_until by design.
      snoozed_until: day(7),
      due: day(9),
      created: day(-38),
    },
    updated_ms: now - 2 * 3_600_000,
    excerpt: "Promo list in the note — DJs first, blogs after.",
    body: "Promo list below — DJs first, blogs after.\n",
  },
  {
    // overdue: due two days ago — the named overdue fixture the loosened
    // e2e floor asserts by title (the seed adds three overdue-adjacent tasks)
    path: "Tasks/Renew Bandcamp plan.md",
    stem: "Renew Bandcamp plan",
    title: "Renew Bandcamp plan",
    folder: "Tasks",
    props: {
      type: "task",
      status: "todo",
      area: "Admin",
      priority: "Low",
      due: day(-2),
      created: day(-74),
    },
    updated_ms: now - 7 * 86_400_000,
    excerpt: "Yearly plan renews — check the label account first.",
    body: "Yearly plan renews — check the label account first.\n",
  },
  {
    path: "Calendar/Call with Gero.md",
    stem: "Call with Gero",
    title: "Call with Gero",
    folder: "Calendar",
    props: { type: "event", date: day(1), created: "2026-07-17" },
    updated_ms: now - 3 * 3_600_000,
    excerpt: "Distribution contract walkthrough.",
    body: "Distribution contract walkthrough.\n",
  },
  {
    path: "Calendar/Umbra listening session.md",
    stem: "Umbra listening session",
    title: "Umbra listening session",
    folder: "Calendar",
    props: { type: "event", date: day(0), created: "2026-07-17" },
    updated_ms: now - 8 * 3_600_000,
    excerpt: "Full-album pass on the big speakers, notes after.",
    body: "Full-album pass on the big speakers, notes after.\n",
  },
  {
    // The timed lane — a date prop carrying HH:MM on the same day as
    // the all-day session above, so e2e can assert all-day-first ordering and
    // the pill's time. updated_ms stays old: Recent's top 8 must not move
    path: "Calendar/Label sync call.md",
    stem: "Label sync call",
    title: "Label sync call",
    folder: "Calendar",
    props: { type: "event", date: `${day(0)} 14:00`, created: "2026-07-17" },
    updated_ms: now - 20 * 86_400_000,
    excerpt: "Weekly sync — pressing schedule and the SMP-031 budget.",
    body: "Weekly sync — pressing schedule and the SMP-031 budget.\n",
  },
  {
    // The ranged lane — a same-day `start/end` date prop, so e2e can
    // assert the week canvas draws the real duration instead of a default
    // hour. It deliberately CONTAINS the 14:00 call above, which pins the
    // overlap half: the two have to share lanes. updated_ms stays old for the
    // same reason as the call — Recent's top 8 must not move
    path: "Calendar/Cutting room workshop.md",
    stem: "Cutting room workshop",
    title: "Cutting room workshop",
    folder: "Calendar",
    props: {
      type: "event",
      date: `${day(0)} 09:00/${day(0)} 17:00`,
      created: "2026-07-17",
    },
    updated_ms: now - 21 * 86_400_000,
    excerpt: "Full day on the lathe — levels, depth, and a test cut per hour.",
    body: "Full day on the lathe — levels, depth, and a test cut per hour.\n",
  },
  {
    // listed but unreadable — the vanished-file empty state has a
    // deterministic mock lane; sorts last in Recent, never matched by queries
    path: "Inbox/Vanished note.md",
    stem: "Vanished note",
    title: "Vanished note",
    folder: "Inbox",
    props: { created: "2026-07-17" },
    updated_ms: now - 30 * 86_400_000,
    excerpt: "This file is gone.",
    body: "This file is gone.\n",
    unreadable: true,
  },
  {
    // zhome: the schema-metadata lane — this db's schema entry carries the
    // reserved icon/home keys like a real schema.json (the 0.8.0 crash:
    // a filterHint loop iterated it as if every entry were a PropSchema)
    path: "ZHome/Zed note.md",
    stem: "Zed note",
    title: "Zed note",
    folder: "ZHome",
    props: { type: "zhome", status: "Active", created: "2026-07-17" },
    updated_ms: now - 4 * 86_400_000,
    excerpt: "Homed test db row.",
    body: "Homed test db row.\n",
  },
];

/* ── Generated bulk density ──────────────────────────────────────
   Programmatic fixtures layered on top of the hand-crafted set above, so the
   mock vault reads closer to the real thing (a full label pipeline, a deep
   contacts book, a packed inventory) instead of a toy. Everything derives
   from loop indices — no Date.now(), no Math.random() — so every boot serves
   the identical vault.

   The e2e suite pins the seeded world hard, which shapes what bulk may do:
   - the sidebar orders its (homeless) database list count-desc then
     alphabetically; the Release > Sheet > Contact > Event > Finance-doc >
     Gear chain was pinned while the flat sidebar section lived (that
     removed it — only per-db counts are asserted now), so seeded counts may
     grow freely as long as each asserted count is updated in step. A later
     grew the calendar-eligible dbs: task 4 → 17 (homed in Tasks/, invisible
     to the flat list — free), event 2 → 4 counterbalanced by contact 2 → 4
     and sheet 3 → 5 (release 5 = sheet 5 and contact 4 = event 4, ties break
     alphabetically); the timed event came later (event 4 → 5). Catalog/
     artist/inventory/diary keep clear of the asserted counts. Counts are asserted
     at: smoke db rows/filters (release 5 wholesale; task 17, `due < 7d` →
     "13 of 17", +1 in-test create → 18), db-block "N entries" texts, the
     folder-trash "5 notes" (the seed adds the timed event), and the
     delete-task dialog ("17 entries").
   - the calendar's create-type list is asserted exactly ([event, release,
     task]) and is built from types that hold dated entries, event first then
     alphabetical — count-independent, but no generated note may expose an
     ISO-shaped date in a schema-unruled prop (`created` is always exempt).
     The catalog's `released` keeps ISO values but the schema rules it kind
     text, which the calendar reads as "not a date". The contacts and
     sheets carry no ISO props beyond `created` for the same reason.
   - the Notes scratch list is asserted at exactly 4 untyped rows — every
     generated note carries a type.
   - Today's recency grid tops out at the 8 seeded notes — generated
     updated_ms sit 2+ days in the past (genUpdated), so the top-8 closed set
     holds even after those extra tasks.
   - the overdue strip/tray count is a FLOOR in e2e (≥ 1, plural-safe), no
     longer exactly 1: "Renew Bandcamp plan" (day −2) is the named fixture,
     joined by three overdue-adjacent tasks (day −1/−3/−8).
   - search and palette fixtures key on specific words ("lisbon", "inbox",
     "vessel", "rondo", "static", "capture", "Umbra", "Overview") — none
     of them appears in generated titles or bodies. */

/** content dates anchor to this constant, never the clock */
const FIXED_BASE = "2026-07-17";
const fixedDay = (daysBack: number): string =>
  new Date(Date.parse(`${FIXED_BASE}T00:00:00Z`) - daysBack * 86_400_000)
    .toISOString()
    .slice(0, 10);

const pick = <T,>(arr: readonly T[], i: number): T => arr[i % arr.length];

let genSeq = 0;
/** generated notes share one aging sequence: all 2+ days old and distinct, so
    Today's seeded recency top-8 and every recency-sorted list stay put */
const genUpdated = () => now - 2 * 86_400_000 - ++genSeq * 47 * 60_000;

/* ~35 catalog releases (SMP-032 up): the label's wider pipeline. Statuses
   spread 9/9/9/5 plus a few status-less so every board column fills; some
   long titles, some missing artist/released, a few ![[…]] artworks and
   file-path contracts (two pointing nowhere, like the seeded Vessel one). */
const CATALOG_ARTISTS = [
  "mirror fauna", "glacier plains", "soft authority", "plum echo",
  "pale operator", "moss radar", "twin cedar", "low orbiter",
  "salt ribbons", "cinder bloom", "late junction", "minor empires",
  "fennec", "brine pool",
];
const CATALOG_TITLES = [
  "Night Parcel EP",
  "Copper Season",
  "Meadow Hush",
  "Gullwing",
  "Slow Arrivals",
  "Tinfoil Sky",
  "Amber Rooms",
  "Field Lines",
  "Quiet Machinery",
  "Salt Ribbon",
  "Plum Echo",
  "Twin Cedar",
  "Low Orbiter",
  "Moss Radar",
  "Songs for a Room That Forgot How to Hold Its Shape in the Rain",
  "The Long Corridor Tapes Volume Two — Rehearsals for a Quiet Collapse",
  "Everything We Recorded in the Barn Before the Roof Finally Gave In",
  "Minor Empires",
  "Glass Harrier",
  "Brine Pool",
  "Late Junction",
  "Owlish",
  "Veld Fire",
  "Fennec",
  "Pale Operator",
  "Hollow Reeds",
  "North Relay",
  "Cinder Bloom",
  "Day Tunnels",
  "Rain Ledger",
  "Warm Circuit",
  "Foxglove",
  "Winter Prosper",
  "Soft Authority",
  "Kites at Night",
  "Glacier Plains",
];
const CATALOG_STATUS = ["live", "in review", "mastering", "parked"] as const;
const CATALOG_LINES = [
  "Test pressing approved; the B-side etching stays.",
  "Waiting on the plant's slot confirmation before anything ships.",
  "Sleeve proofs came back a touch dark — reprint ordered.",
  "Bandcamp draft is up, private for now.",
  "Distribution wants final audio two weeks earlier than planned.",
  "The barn recording closes the record; everything else is sequenced.",
];
for (let i = 0; i < CATALOG_TITLES.length; i++) {
  const title = CATALOG_TITLES[i];
  const status = i < 27 ? CATALOG_STATUS[Math.floor(i / 9)] : i < 32 ? "parked" : undefined;
  const props: Record<string, unknown> = {
    type: "catalog",
    "cat#": `SMP-0${32 + i}`,
    created: fixedDay(3 + ((i * 11) % 75)),
  };
  if (status) props.status = status;
  if (i % 8 !== 0) props.artist = pick(CATALOG_ARTISTS, i * 5 + 2);
  if (i % 6 !== 0) {
    props.released =
      i % 5 === 1 ? fixedDay(-(7 + ((i * 3) % 45))) : fixedDay(20 + ((i * 13) % 320));
  }
  props.tracks = String(4 + ((i * 3) % 11));
  if (i % 11 !== 0) {
    props.format =
      i % 7 === 0
        ? ["Vinyl", "Digital", "Tape"]
        : i % 3 === 0
          ? ["Vinyl", "Digital"]
          : i % 2 === 0
            ? "Digital"
            : ["Vinyl"];
  }
  if (i % 9 === 0) props.artwork = `![[smp-${32 + i}-cover.png]]`;
  else if (i % 9 === 4) props.artwork = `smp-${32 + i}-art.jpg`;
  if (i % 10 === 0) props.contract = `~/Documents/contracts/smp-${32 + i}.pdf`;
  else if (i % 10 === 5) props.contract = `~/Documents/missing smp-${32 + i} contract.pdf`;
  if (i % 7 === 1 || i % 7 === 4) props.contact = pick(["Gero", "Noa"], i);
  const excerpt = `Catalog release note. ${pick(CATALOG_LINES, i)}`;
  const link =
    i % 6 === 2
      ? ` Companion piece to [[${CATALOG_TITLES[(i + 5) % CATALOG_TITLES.length]}]].`
      : "";
  mockNotes.push({
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props,
    updated_ms: genUpdated(),
    excerpt,
    body: `${excerpt}${link}\n`,
  });
}

/* ~28 artists: the contacts book behind the catalog. Roles repeat like a
   real label roster; city/since drop out on some rows. */
const ARTIST_NAMES = [
  "Mara Voss", "Iris Lindqvist", "Theo Brandt", "Anouk Verhoeven",
  "Jonas Pichler", "Lena Marchetti", "Ruben Sousa", "Freya Nilsen",
  "Oskar Lindh", "Petra Kovacs", "Milan Drozd", "Sofia Anders",
  "Nils Bergstrom", "Ayla Demir", "Casper Woud", "Ines Moreau",
  "Tobias Renner", "Hanna Sikora", "Elif Yilmaz", "Bruno Carvalho",
  "Maja Lindgren", "Piotr Nowak", "Sara Lindholm", "Viktor Ahl",
  "Nina Kostova", "Emil Faber", "Rosa Jimenez", "Karl Enevold",
];
const ARTIST_ROLES = [
  "producer", "vocalist", "DJ", "photographer", "live sound", "booking agent",
  "pressing plant", "journalist", "video director", "session keys",
  "session drums", "mix assistant", "promo", "design", "radio plugger",
  "sync agent", "tour manager", "webshop", "translator", "archivist",
];
const ARTIST_CITIES = [
  "Berlin", "Porto", "Warsaw", "Leipzig", "Amsterdam", "Glasgow", "Oslo",
  "Prague", "Vienna", "Milan", "Ghent", "Rotterdam", "Aarhus", "Turin",
];
for (let i = 0; i < ARTIST_NAMES.length; i++) {
  const name = ARTIST_NAMES[i];
  const role = pick(ARTIST_ROLES, i);
  const props: Record<string, unknown> = {
    type: "artist",
    role,
    created: fixedDay(10 + ((i * 17) % 140)),
  };
  if (i % 5 !== 0) props.city = pick(ARTIST_CITIES, i * 3 + 1);
  if (i % 4 !== 0) props.since = String(2016 + ((i * 7) % 10));
  const roleTitle = role.charAt(0).toUpperCase() + role.slice(1);
  const excerpt = `${roleTitle}${props.city ? ` based in ${props.city}` : ""} — on the roster since ${props.since ?? "the early days"}.`;
  mockNotes.push({
    path: `${name}.md`,
    stem: name,
    title: name,
    folder: "",
    props,
    updated_ms: genUpdated(),
    excerpt,
    body: `${excerpt}\n`,
  });
}

/* 15 inventory rows: studio gear density without touching the seeded gear db
   (its count pins the sidebar order). `acquired` stays a bare year — a full
   ISO day would land inventory on the calendar (see the block comment). */
const GEAR_NAMES = [
  "Aeon Driftbox", "Nordvik One", "Pellas RP-2", "Monocord 64",
  "Tapeworks T-4", "Voluma 500", "Klarheit K-2", "Dundorf D-6",
  "Falke F-3", "Rothe R-8", "Sirene S-2", "Basslinie B-1",
  "Kern K-500", "Welle W-12", "Tonteck T-90",
];
const GEAR_CATS = [
  "synth", "drum machine", "mixer", "monitor", "microphone", "fx unit",
  "controller", "tape machine", "preamp",
];
const GEAR_STATUS = ["in studio", "in studio", "in studio", "loaned out", "in repair", "sold"];
const GEAR_SPOTS = ["Studio A", "Studio B", "storage"];
/* product-page links for the url-kind `link` prop — every fifth
   row carries one, the rest demo the empty-cell lane */
const GEAR_LINKS = [
  "https://www.aeon.audio/driftbox",
  "https://www.tapeworks.shop/t-4",
  "https://www.sirene.audio/s-2",
];
for (let i = 0; i < GEAR_NAMES.length; i++) {
  const name = GEAR_NAMES[i];
  const category = pick(GEAR_CATS, i);
  const status = pick(GEAR_STATUS, i);
  const props: Record<string, unknown> = {
    type: "inventory",
    category,
    status,
    created: fixedDay(30 + ((i * 23) % 300)),
  };
  if (i % 3 !== 0) props.location = pick(GEAR_SPOTS, i);
  if (i % 4 !== 0) props.acquired = String(2015 + ((i * 3) % 11));
  if (i % 5 === 0) props.link = GEAR_LINKS[i / 5];
  // checkbox kind: every third unit is in the live rig — the
  // checked lane; the rest demo unchecked (prop absent, never `false`)
  if (i % 3 === 0) props["in use"] = true;
  // number kind, euro format: most rows carry a price (a few with
  // decimals) — Pellas RP-2 demos the junk lane (renders exactly as typed),
  // every fourth row leaves the cell empty
  if (i === 2) props.price = "ask";
  else if (i % 4 !== 3) props.price = 199 + ((i * 137) % 2400) + (i % 5 === 0 ? 0.5 : 0);
  // the importer's dedupe stamp — real migrated rows all carry it;
  // must stay invisible as a column
  props.notion_id = `mock-${String(i).padStart(4, "0")}-c147-81ce`;
  const excerpt = `${category} — ${status}.`;
  mockNotes.push({
    path: `${name}.md`,
    stem: name,
    title: name,
    folder: "",
    props,
    updated_ms: genUpdated(),
    excerpt,
    body: `${excerpt} Service notes and cabling go here.\n`,
  });
}

/* a dozen diary/plain notes across folders: the prose-only filler a real
   vault accumulates. Dates live in titles, never in props (calendar — see
   the block comment). */
const DIARY: { title: string; line: string }[] = [
  { title: "Studio log 2026-06-08", line: "Drum bus finally sits; the trick was less of everything." },
  { title: "Studio log 2026-06-15", line: "Resampled the hallway claps through the spring." },
  { title: "Mix notes — June roundup", line: "Three mixes approved, one back for a vocal ride." },
  { title: "Canal loop walk", line: "Voice memos from the towpath — two keepers." },
  { title: "Autumn sampler ideas", line: "One track per artist who played the spring nights." },
  { title: "Patch bay cleanup notes", line: "Normalling the first two rows again made sense." },
  { title: "Label night debrief", line: "Small room, right people. Do it quarterly." },
  { title: "Listening pile July", line: "The reissue queue is getting away from me." },
  { title: "Compressor settings worth keeping", line: "Drums: slow attack, fast release, needle barely moves." },
  { title: "Sleeve notes draft", line: "The thanks section is harder than the music." },
  { title: "Week 28 plan", line: "Two masters in, one artwork out, no meetings Friday." },
  { title: "Signal chain sketches", line: "Try the spring before the delay next time." },
];
const DIARY_FOLDERS = ["Field notes", "Ideas", "Projects", ""];
for (let i = 0; i < DIARY.length; i++) {
  const { title, line } = DIARY[i];
  const folder = DIARY_FOLDERS[i % DIARY_FOLDERS.length];
  mockNotes.push({
    path: folder ? `${folder}/${title}.md` : `${title}.md`,
    stem: title,
    title,
    folder,
    props: { type: "diary", created: fixedDay(5 + ((i * 9) % 50)) },
    updated_ms: genUpdated(),
    excerpt: line,
    body: `${line}\n`,
  });
}
{
  // A stale pick — `today` still points at yesterday, so the rebuilt
  // Today surface shows it in the leftovers row (Keep rolls it forward, Clear
  // drops it). diary keeps clear of every asserted count, and the date lands
  // on the calendar yesterday, where no spec pins a cell
  const line = "Second half drags — swap the two ambient ones.";
  mockNotes.push({
    path: "Ideas/Resequence the live set.md",
    stem: "Resequence the live set",
    title: "Resequence the live set",
    folder: "Ideas",
    props: { type: "diary", today: day(-1), created: FIXED_BASE },
    updated_ms: genUpdated(),
    excerpt: line,
    body: `${line}\n`,
  });
}

{
  // an UNTYPED note carrying a list prop — the only fixture that reaches the
  // plain chip editor with a multi-value prop, which is where a stored list
  // used to collapse into one comma-joined scalar on a bare click-away.
  // Untyped + filed, so it stays out of the Notes scratch list; aged well
  // past the recency window so no Today/list ordering assertion moves.
  mockNotes.push({
    path: "Ideas/Split the stem pack.md",
    stem: "Split the stem pack",
    title: "Split the stem pack",
    folder: "Ideas",
    props: { format: ["Vinyl", "Digital"], created: FIXED_BASE },
    updated_ms: now - 40 * 24 * 3_600_000,
    excerpt: "Stems go out in both formats.",
    body: "Stems go out in both formats.\n",
  });
}

{
  // A dashboard filed in a CONTENT folder, not under the dashboards
  // home. It renders inside the Ideas tree row instead of in the Dashboards
  // section (splitDashboards routes each path to exactly one surface). Ideas is
  // a plain seeded root no spec pins a note count on, and one ```chart fence
  // makes it a charts dashboard with no `dashboard:` key needed.
  mockNotes.push({
    path: "Ideas/Sketch Metrics.md",
    stem: "Sketch Metrics",
    title: "Sketch Metrics",
    folder: "Ideas",
    props: { type: "dashboard", created: FIXED_BASE },
    updated_ms: now - 47 * 24 * 3_600_000,
    excerpt: "How the idea pile is moving.",
    body: "How the idea pile is moving.\n\n```chart\nsource: release\nx: status\ny: count\nkind: bar\ntitle: Releases by status\n```\n",
  });
}

/* ── Dated density ────────────────────────────────────────────────
   Today and Calendar stop reading like a toy: task deadlines spread across
   the visible weeks (a few overdue-adjacent, a dense today, some this week, a
   couple next week and beyond) plus two more events, so the month scatters
   chips and Today's agenda shows a real day. Dates ride day(offset) like the
   seeded tasks/events — always near the run date — and updated_ms shares the
   generated aging sequence, so Today's recency top-8 stays the seeded eight.

   Sidebar discipline (the flat list sorts count-desc, then alphabetical, and
   e2e pins the Release > Sheet > Contact > Event > Finance-doc > Gear order):
   task is homed in Tasks/, so its count never reaches the flat list and grows
   freely; the +2 events are counterbalanced by +2 contacts and +2 sheets —
   release 5 vs sheet 6 (Food Log — moot for ordering
   removed the flat list; only per-db counts are asserted, and no spec pins
   the sheet count) and contact 4 = event 4, ties break alphabetically.
   Every note carries a type (Notes keeps exactly its
   4 scratch rows), no ISO-shaped prop sneaks in beyond the scheduling one
   (`due` / `date` — `created` is exempt), and titles/bodies stay clear of the
   search/palette keywords listed above. */
/* `area`/`priority` are optional here and drive ONLY the tasks board:
   the allowlist is Label/Studio/Admin, so a filler without an area stays off
   that board while still counting as one of the 17 seeded tasks every db-view
   spec pins. Three carry an area on purpose — one more overdue row, and two
   upcoming ones so the board's area groups render below its urgency spine. */
/* `createdBack` overrides the shared FIXED_BASE created date with one relative
   to today: a task whose fixture role is "carries NO rot chip" has
   to stay young as the calendar moves, or a fixed created date silently ages
   past `stale_days` and turns the negative assertion red for good. */
const DENSE_TASKS: {
  title: string;
  due: number;
  status: string;
  line: string;
  area?: string;
  priority?: string;
  createdBack?: number;
}[] = [
  // overdue-adjacent: joined "Renew Bandcamp plan" in the overdue strip
  { title: "Chase the test pressing approvals", due: -1, status: "doing", area: "Label", priority: "High", createdBack: 3, line: "Two plants answered, one still owes the green light." },
  { title: "Update the Bandcamp payout details", due: -3, status: "todo", line: "New account since spring — check the split settings too." },
  { title: "Return the borrowed spring reverb", due: -8, status: "todo", line: "It lives on the drum bus until the bounce is done." },
  // a dense today (with the seeded task + both events: 7 dated entries)
  { title: "Bounce the SMP-030 sequence for the plant", due: 0, status: "doing", line: "Sequence locked — 44.1/24 WAVs plus the DDP image." },
  { title: "Approve the label-night photos for the archive", due: 0, status: "todo", line: "Pick twelve, credit line goes under each." },
  { title: "Write the pressing notes for the autumn window before the plant call", due: 0, status: "todo", line: "Quantities, weight, sleeve stock — one page the plant can quote from." },
  { title: "Ship the patron download codes", due: 0, status: "todo", line: "Codes generated; the mail goes out after the bounce." },
  // this week (inside the next-7-days window)
  { title: "Call the plant about the pressing slot", due: 1, status: "todo", line: "Confirm the autumn window before the quotes expire." },
  { title: "Pack the merch box for the label night", due: 3, status: "todo", line: "Tees, totes, and the last of the tape stock." },
  { title: "Set up the pre-save page for the September single", due: 5, status: "todo", line: "Artwork crop still pending — use the placeholder." },
  // next week and beyond (outside next-7-days, still on the month)
  { title: "Renew the webshop shipping rates", due: 8, status: "todo", area: "Admin", priority: "Medium", line: "Carrier raised prices again — recompute the bundles." },
  { title: "Send the live-room recording quote", due: 11, status: "todo", area: "Studio", line: "Two days, house kit included, dry hire on day three." },
  { title: "Sequence the winter sampler", due: 16, status: "todo", line: "One track per roster artist; the opener picks itself." },
];
for (const t of DENSE_TASKS) {
  mockNotes.push({
    path: `Tasks/${t.title}.md`,
    stem: t.title,
    title: t.title,
    folder: "Tasks",
    props: {
      type: "task",
      status: t.status,
      due: day(t.due),
      created: t.createdBack === undefined ? FIXED_BASE : day(-t.createdBack),
      ...(t.area ? { area: t.area } : {}),
      ...(t.priority ? { priority: t.priority } : {}),
    },
    updated_ms: genUpdated(),
    excerpt: t.line,
    body: `${t.line}\n`,
  });
}
const DENSE_EVENTS: { title: string; date: number; line: string }[] = [
  { title: "Mirror fauna vocal session", date: 0, line: "Comp the choruses first, ad-libs after dinner." },
  { title: "Pressing plant open day", date: 12, line: "Tour the new line; bring a test lacquer." },
];
for (const e of DENSE_EVENTS) {
  mockNotes.push({
    path: `Calendar/${e.title}.md`,
    stem: e.title,
    title: e.title,
    folder: "Calendar",
    props: { type: "event", date: day(e.date), created: FIXED_BASE },
    updated_ms: genUpdated(),
    excerpt: e.line,
    body: `${e.line}\n`,
  });
}
/* sidebar counterbalance for the +2 events (see the block comment): contacts
   and sheets grow in step so the pinned count-desc order never moves. Every
   contact carries an email; Tess also has a phone — the second
   phone lane beside Gero above. */
const DENSE_CONTACTS: { name: string; role: string; email: string; phone?: string; line: string }[] = [
  { name: "Tess Almeida", role: "booking", email: "booking@umbra.example", phone: "+49 30 7654321", line: "Books the club and small-festival slots." },
  { name: "Annelies Verbeek", role: "radio plugger", email: "annelies@umbra.example", line: "Plugs the roster's singles to college radio." },
];
for (const c of DENSE_CONTACTS) {
  const props: NoteMeta["props"] = { type: "contact", role: c.role, email: c.email, created: FIXED_BASE };
  if (c.phone) props.phone = c.phone;
  mockNotes.push({
    path: `${c.name}.md`,
    stem: c.name,
    title: c.name,
    folder: "",
    props,
    updated_ms: genUpdated(),
    excerpt: c.line,
    body: `${c.line}\n`,
  });
}
const DENSE_SHEETS: { title: string; csv: string }[] = [
  { title: "Studio Time Log", csv: "date,hours\n2026-07-06,4\n2026-07-08,6\n2026-07-10,3\n2026-07-13,5\n" },
  { title: "Merch Stock", csv: "item,stock\nTee black M,14\nTee black L,9\nTote natural,22\nVinyl bundle,7\n" },
];
for (const s of DENSE_SHEETS) {
  const body = `${s.title} — rows are data.\n\n\`\`\`csv\n${s.csv}\`\`\`\n`;
  mockNotes.push({
    path: `${s.title}.md`,
    stem: s.title,
    title: s.title,
    folder: "",
    props: { type: "sheet", created: FIXED_BASE },
    updated_ms: genUpdated(),
    excerpt: `${s.title} — rows are data.`,
    body,
  });
}

/* ── Wide royalty ledger ──────────────────────────────────────────
   Ten royalty statements, one per platform-period, carrying the 16-prop
   schema above — the widest table in the mock, shaped like the real books so
   the audit harness can judge horizontal density. Hand-written for realistic
   irregularity: long statement numbers, decimals on every money column, a
   junk gross cell ("see csv" — renders exactly as typed), empties spread
   across recoupment/url/notes/rates, one negative carried balance, and `paid`
   checked on the four settled rows only (absent = unchecked, never `false`).
   Rows stay homeless so Ledger lands in the sidebar's flat db list on its
   own — count 10 slots between Diary (12) and Release (5), which the pinned
   six-name sidebar assertion never sees (it filters to its names). updated_ms
   shares the generated aging sequence (Today's recency top-8 holds), every
   row carries a type (Notes keeps its 4 scratch rows), no prop holds an
   ISO-shaped date beyond the exempt `created` (calendar create-as picker
   holds at [event, release, task]), and titles/bodies keep clear of the
   search/palette keywords listed above — "release" included (palette.spec
   pins the ranking for that query). */
const LEDGER_ROWS: {
  title: string;
  platform: string;
  period: string;
  stmt: string;
  gross?: number | string;
  fees?: number;
  net?: number;
  share?: number;
  recoup?: number;
  balance?: number;
  dig?: number;
  phys?: number;
  paid?: boolean;
  url?: string;
  contact?: string;
  notes?: string;
  method: string;
  line: string;
}[] = [
  { title: "Bandcamp 2026 Q2", platform: "Bandcamp", period: "2026 Q2", stmt: "BC-2026Q2-00417", gross: 4213.55, fees: 632.03, net: 3581.52, share: 1790.76, recoup: 412.10, balance: 1378.66, dig: 8.5, phys: 12, paid: true, url: "https://statements.umbra.example/bc-2026-q2", contact: "Gero", method: "bank transfer", notes: "Fee-waiver Fridays folded in — mirror fauna split per the 60/40 sampler agreement.", line: "Q2 Bandcamp payout — the sampler carries the quarter." },
  { title: "Bandcamp 2026 Q1", platform: "Bandcamp", period: "2026 Q1", stmt: "BC-2026Q1-00389", gross: 3550.10, fees: 532.52, net: 3017.58, share: 1508.79, balance: 1508.79, dig: 8.5, phys: 12, paid: true, url: "https://statements.umbra.example/bc-2026-q1", contact: "Gero", method: "bank transfer", notes: "First quarter with the new tape stock priced in.", line: "Q1 Bandcamp payout, tapes included." },
  { title: "Spotify 2026-05", platform: "Spotify", period: "2026-05", stmt: "SPF-2026-05-88103", gross: 1186.42, fees: 59.32, net: 1127.10, share: 563.55, recoup: 563.55, balance: 0, dig: 15, paid: true, contact: "Noa", method: "paypal", notes: "Delayed a month — the April file arrived corrupted and had to be re-requested.", line: "May streams, finally settled." },
  { title: "Spotify 2026-04", platform: "Spotify", period: "2026-04", stmt: "SPF-2026-04-87554", gross: 1093.88, fees: 54.69, net: 1039.19, share: 519.60, recoup: 519.60, balance: 0, dig: 15, method: "paypal", line: "April streams at the usual trickle." },
  { title: "Apple Music 2026-04", platform: "Apple Music", period: "2026-04", stmt: "AM-2026-04-5521", gross: 942.30, fees: 47.12, net: 895.18, share: 447.59, balance: 447.59, dig: 15, url: "https://statements.umbra.example/am-2026-04", method: "bank transfer", line: "Apple's April file, small but steady." },
  { title: "Beatport 2026 Q2", platform: "Beatport", period: "2026 Q2", stmt: "BP-2026-Q2-11482", gross: 2310.00, fees: 346.50, net: 1963.50, share: 981.75, recoup: 250.00, balance: 731.75, dig: 12.5, paid: true, url: "https://statements.umbra.example/bp-2026-q2", contact: "Tess Almeida", method: "paypal", notes: "Club tools bundle outsold the singles two to one.", line: "Beatport's club quarter landed." },
  { title: "Juno 2026 Q1", platform: "Juno Download", period: "2026 Q1", stmt: "JUNO-2026-Q1-0907", gross: 388.44, fees: 58.27, net: 330.17, share: 165.09, balance: 165.09, dig: 10, phys: 10, method: "bank transfer", notes: "Vinyl returns pending — may pull the carried balance negative next quarter.", line: "Juno's first quarter, thin as expected." },
  { title: "YouTube Content ID 2026-05", platform: "YouTube Content ID", period: "2026-05", stmt: "YT-CID-2026-05-334", gross: "see csv", contact: "Noa", method: "label credit", url: "https://statements.umbra.example/yt-2026-05", notes: "Claim review still open — totals land once the disputed videos clear.", line: "Content ID month, numbers still pending." },
  { title: "Spotify 2026-03", platform: "Spotify", period: "2026-03", stmt: "SPF-2026-03-86901", gross: 978.21, fees: 48.91, net: 929.30, share: 464.65, recoup: 464.65, balance: 0, dig: 15, method: "paypal", line: "March streams, tidy." },
  { title: "Bandcamp 2025 Q4", platform: "Bandcamp", period: "2025 Q4", stmt: "BC-2025Q4-00352", gross: 5102.74, fees: 765.41, net: 4337.33, share: 2168.67, recoup: 1000.00, balance: -486.20, dig: 8.5, phys: 12, url: "https://statements.umbra.example/bc-2025-q4", contact: "Gero", method: "bank transfer", notes: "Year-end adjustment applied after the returns window closed.", line: "Last year's Q4, adjusted for returns." },
];
for (const r of LEDGER_ROWS) {
  const props: Record<string, unknown> = {
    type: "ledger",
    platform: r.platform,
    period: r.period,
    "statement no": r.stmt,
    method: r.method,
    created: FIXED_BASE,
  };
  if (r.gross !== undefined) props.gross = r.gross;
  if (r.fees !== undefined) props.fees = r.fees;
  if (r.net !== undefined) props.net = r.net;
  if (r.share !== undefined) props["artist share"] = r.share;
  if (r.recoup !== undefined) props.recoupment = r.recoup;
  if (r.balance !== undefined) props["balance carried"] = r.balance;
  if (r.dig !== undefined) props["digital rate"] = r.dig;
  if (r.phys !== undefined) props["physical rate"] = r.phys;
  if (r.paid) props.paid = true;
  if (r.url) props["statement url"] = r.url;
  if (r.contact) props.contact = r.contact;
  if (r.notes) props.notes = r.notes;
  mockNotes.push({
    path: `${r.title}.md`,
    stem: r.title,
    title: r.title,
    folder: "",
    props,
    updated_ms: genUpdated(),
    excerpt: r.line,
    body: `${r.line}\n`,
  });
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

function mockFmProps(fm: string): Record<string, unknown> {
  const out = mockRecord<unknown>();
  for (const line of fm.split("\n")) {
    if (!line.trim() || line.startsWith("#") || /^\s/.test(line)) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
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
  const lines = Object.entries(props).map(([k, v]) =>
    Array.isArray(v) ? `${k}:\n${v.map((x) => `- ${x}`).join("\n")}` : `${k}: ${v}`
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
    email: { options: [], kind: "email" },
    phone: { options: [], kind: "phone" },
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
  watch?: boolean;
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
const mockMountIndex: Record<string, { scanned: string; files: MockMountFile[] }> = {};
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
/** Stand-in for the engine's content hash — the mock has no bytes to read, and
    every consumer only ever compares identities for equality. */
const mockIdentity = (name: string) => `id-${mockSanitizeFilename(name).toLowerCase()}`;
/** The mock's "disk": every path holds the same dozen files, filtered by the
    mount's globs the way `walk_folder_files` filters a real tree. */
function mockDiskFiles(globs: string[]): MockMountFile[] {
  const exts = globs.map((g) => g.trim().replace(/^\*/, "").toLowerCase()).filter(Boolean);
  return mockFolderFiles
    .filter((f) => !exts.length || exts.some((e) => f.name.toLowerCase().endsWith(e)))
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
  const found = mockDiskFiles(mount.globs);
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
  props: { "capture-hotkey": "alt+space", "close-to-tray": "false" },
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

/** schema.json as the real backend serves it: props plus the reserved
    per-type `icon` and `home` keys merged in (both survive even when a type
    has no props configured). */
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
let mockVaultSyncStatus: Omit<VaultSyncStatus, "conflicted"> = {
  configured: false,
  last_result: null,
  last_error: null,
};

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

/** Char offset of the first word-start match of any token, or `Infinity`.
    `starts` is the matcher's own word-boundary class, so each command ranks
    by exactly the rule it filtered with. */
function mockFirstHit(text: string, tokens: string[], starts: string): number {
  if (tokens.length === 0) return Infinity;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?<!${starts})(?:${tokens.map(esc).join("|")})`, "iu").exec(text);
  return m ? m.index : Infinity;
}

/** Sort key for both mock search commands — see the note above. */
function mockRank(a: MockSearchRank, b: MockSearchRank): number {
  if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
  if (a.offset !== b.offset) return a.offset - b.offset;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
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
    const fail = () => Promise.reject(new Error(`mock failure: ${cmd}`));
    return wait ? mockDelay(wait).then(fail) : fail();
  }
  // instrumentation: an opt-in ring of write-lane commands plus the
  // FX request seam, with args and outcomes. No effect unless a spec installed
  // the trace hook; including FX lets privacy regressions prove call counts.
  if (mockCmdTrace && (/^vault_(write_body|rename|create|read)$/.test(cmd) || cmd === "fx_rates")) {
    const entry: MockTraceEntry = {
      ms: Date.now() - mockCmdTraceT0,
      cmd,
      path: typeof args?.path === "string" ? args.path : undefined,
      bodyTail:
        typeof args?.body === "string" ? (args.body as string).slice(-40) : undefined,
      expectedNull: args && "expectedBody" in args ? args.expectedBody === null : undefined,
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
        (grant) => !(grant.client === args?.client && grant.prefix === args?.prefix)
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
      // query token must prefix-match some word in the title or body, where a
      // word is an alphanumeric run like the FTS tokenizer produces — so a
      // mid-word substring misses and scattered multi-word tokens hit.
      // machine-fence bodies are stripped like the engine's index
      const tokens = ((args?.q as string) ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return [];
      const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const bound = "[\\p{L}\\p{N}]";
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
          const hay = words(`${n.title}\n${stripMachineFences(n.body)}`);
          return tokens.every((t) => hay.some((w) => w.startsWith(t)));
        })
        // rank before capping, or the cap picks by insertion order
        .map((n) => {
          const body = stripMachineFences(n.body);
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
        .map(({ note: n }) => ({ path: n.path, snippet: n.excerpt || n.body.slice(0, 80) }));
    }
    case "vault_search_full": {
      // approximates the engine: word-prefix tokens, whole word highlighted
      const terms = ((args?.q as string) ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      if (terms.length === 0) return { hits: [], total_notes: 0, truncated: false };
      // scope: path allow-list applied before the cap, like the engine
      const fullScope = (args?.scope as string[] | undefined) ?? null;
      const fullInScope = fullScope ? new Set(fullScope) : null;
      // conceal parity: excluded before the count AND the cap, so
      // total_notes/truncated never speak for files the user can't see
      const fullSkipAppFiles = (args?.excludeAppFiles as boolean | undefined) ?? false;
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const res = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.map(esc).join("|")})[\\p{L}\\p{N}_]*`, "giu");
      const segment = (text: string): { parts: { text: string; hit: boolean }[]; count: number } => {
        const parts: { text: string; hit: boolean }[] = [];
        let count = 0;
        let last = 0;
        for (const m of text.matchAll(res)) {
          const at = m.index ?? 0;
          if (at > last) parts.push({ text: text.slice(last, at), hit: false });
          parts.push({ text: m[0], hit: true });
          count += 1;
          last = at + m[0].length;
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
        // AND semantics like FTS: every term must appear somewhere in the note
        const hay = `${n.title}\n${body}`.toLowerCase();
        if (total > 0 && terms.every((t) => new RegExp(`(?<![\\p{L}\\p{N}_])${esc(t)}`, "iu").test(hay)))
          ranked.push({
            hit: { path: n.path, title_parts: title.parts, total, matches, partial: false },
            titleHit: title.count > 0,
            offset:
              title.count > 0
                ? mockFirstHit(n.title, terms, bound)
                : mockFirstHit(body, terms, bound),
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
          if (fullInScope !== null && !fullInScope.has(path)) continue;
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
          const hay = `${name}\n${f.text ?? ""}`.toLowerCase();
          if (total === 0 || !terms.every((t) => new RegExp(`(?<![\\p{L}\\p{N}_])${esc(t)}`, "iu").test(hay)))
            continue;
          ranked.push({
            hit: { path, title_parts: title.parts, total, matches, partial: !!f.text_truncated },
            titleHit: title.count > 0,
            offset:
              title.count > 0 ? mockFirstHit(name, terms, bound) : mockFirstHit(f.text ?? "", terms, bound),
            path,
          });
        }
      }
      // rank before capping, or the cap picks by insertion order.
      // The count is of the whole match set, not the page — the UI
      // needs it to say "first 200 of 359" and to tell a truncated page apart
      // from an empty result set.
      const hits = ranked.sort(mockRank).slice(0, FULL_SEARCH_MAX_NOTES).map((r) => r.hit);
      return { hits, total_notes: ranked.length, truncated: hits.length < ranked.length };
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
      } satisfies VaultSyncStatus;
    case "vault_sync_set_remote": {
      const url = String(args?.url ?? "").trim();
      const token = String(args?.token ?? "");
      const cert = String(args?.cert ?? "").trim();
      if (!(url.startsWith("https://") || url.startsWith("file://"))) {
        throw new Error("vault sync remote must use https:// (file:// is allowed for tests)");
      }
      if (url.startsWith("https://") && token.length === 0) {
        throw new Error("vault sync token cannot be empty for an HTTPS remote");
      }
      if (cert.length > 0 && !cert.includes("-----BEGIN CERTIFICATE-----")) {
        throw new Error("server certificate must be a PEM CERTIFICATE block");
      }
      mockVaultSyncStatus = { configured: true, last_result: null, last_error: null };
      return null;
    }
    case "vault_sync_push": {
      if (!mockVaultSyncStatus.configured) throw new Error("vault sync remote is not configured");
      const report: SyncReport = {
        pushed: 2,
        pulled: 0,
        conflicted: [],
        head: "5dc371a8f1b9",
        // a push checks nothing out (engine parity)
        changed: [],
      };
      mockVaultSyncStatus = { configured: true, last_result: report, last_error: null };
      return report;
    }
    case "vault_sync_pull": {
      if (!mockVaultSyncStatus.configured) throw new Error("vault sync remote is not configured");
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
      const kind = ((args?.kind as PropKind | null) ?? undefined) || undefined;
      if (kind && kind !== "text" && kind !== "date" && kind !== "file" && kind !== "relation" && kind !== "multi" && kind !== "url" && kind !== "email" && kind !== "phone" && kind !== "checkbox" && kind !== "number" && kind !== "rollup")
        throw new Error(`unknown property kind “${kind}”`);
      const target = ((args?.target as string | null) ?? "").trim();
      if (kind === "relation" && !target)
        throw new Error("a relation property needs a target database");
      const format = ((args?.format as string | null) ?? "").trim();
      if (kind === "number" && format && !["plain", "euro", "percent"].includes(format))
        throw new Error(`unknown number format “${format}”`);
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
        if (mockSchema[dbType] && Object.keys(mockSchema[dbType]).length === 0)
          delete mockSchema[dbType];
      } else {
        const keep = mockSchema[dbType]?.[prop]?.notify ?? false;
        const notify = ((args?.notify as boolean | null) ?? keep) && kind === "date";
        // lead time rides the same date-only rule: 0 clears it,
        // longer than a year clamps, an absent arg keeps the stored value
        const keepBefore = mockSchema[dbType]?.[prop]?.notifyBefore;
        const before = (args?.notifyBefore as number | null) ?? keepBefore;
        const notifyBefore =
          kind === "date" && before && before > 0 ? Math.min(before, 365) : undefined;
        (mockSchema[dbType] ??= mockRecord())[prop] = kind
          ? { options: kind === "multi" ? options : [], kind, ...(kind === "relation" ? { type: target } : {}), ...(kind === "number" && format && format !== "plain" ? { format: format as NumberFormat } : {}), ...(kind === "rollup" ? { relation: rollRelation, prop: rollProp, agg: rollAgg as AggKind } : {}), ...(notify ? { notify: true } : {}), ...(notifyBefore ? { notifyBefore } : {}), ...(desc ? { description: desc } : {}) }
          : { options, ...(desc ? { description: desc } : {}) };
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
        if (Object.keys(entry).some((k) => k.toLowerCase() === pname.toLowerCase()))
          throw new Error(`duplicate property “${pname}”`);
        const kind = ((p.kind as PropKind | null) ?? null) || "text";
        if (!["text", "date", "file", "relation", "multi", "url", "email", "phone", "checkbox", "number", "rollup"].includes(kind))
          throw new Error(`unknown property kind “${kind}”`);
        // mirrors Engine::create_type: a rollup's wiring doesn't fit this
        // call — it's added to an existing database via vault_schema_set
        if (kind === "rollup")
          throw new Error(`rollup property “${pname}” needs an existing relation property — add it after the database exists`);
        const target = (p.target ?? "").trim();
        if (kind === "relation" && !target)
          throw new Error(`relation property “${pname}” needs a target database`);
        entry[pname] = { options: [], kind, ...(kind === "relation" ? { type: target } : {}) };
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
      // …and so does the home folder
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
      const viewsKey = mockFoldedKey(mockViews, dbType);
      if (schemaKey) delete mockSchema[schemaKey];
      if (iconKey) delete mockIcons[iconKey];
      if (homeKey) delete mockHomes[homeKey];
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
      if (clPref?.table_group_by?.toLowerCase() === prop.toLowerCase()) delete clPref.table_group_by;
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
    case "vault_tags":
      // mirrors Engine::tag_universe: count per folded tag over every indexed
      // note, most-used first
      return tagUniverse(mockNotes.map(meta)) as TagCount[];
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
      const mount: MockMount = {
        id: `mount-${mockSanitizeFilename(name).toLowerCase()}-${mockMounts.length + 1}`,
        name,
        globs,
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
    case "agenda_open_note":
      // the real backend surfaces the main window with this note open
      console.info("[mock] open note from tray agenda", args?.path);
      return null;
    case "agenda_open_capture":
      console.info("[mock] open capture from tray agenda");
      return null;
    // In the browser mock nothing ever hands us a `substrate://`
    // link — the scheme is registered with the OS around a packaged app — so
    // the queue is always empty and the prefill always absent.
    case "deeplink_take_pending":
      return [];
    case "deeplink_capture_prefill":
      return null;
    case "deeplink_clear_capture_prefill":
      return null;
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
        const raw = n?.props?.[r.key];
        const value =
          raw === null || raw === undefined
            ? null
            : Array.isArray(raw)
              ? raw.map((x) => String(x)).join(", ")
              : String(raw);
        const num = value === null ? null : Number(value);
        const older = num !== null && Number.isFinite(num) ? String(Math.round(num * 0.8)) : value;
        const points =
          value === null
            ? []
            : [
                { ts_ms: now - 27 * 3_600_000, value: older, commit: "vault-snap-2" },
                { ts_ms: now - 3 * 3_600_000, value, commit: "vault-snap-1" },
              ];
        return { path: r.path, key: r.key, points, oldest_ts_ms: now - 27 * 3_600_000 };
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
      const level = Math.max(0, Math.min(2, Number(String(args?.id ?? "").split("-").pop())));
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

export const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  if (blockedByHistoryMode(cmd)) {
    throw new Error("viewing the past is read-only — return to the present to make changes");
  }
  const result = await rawInvoke<T>(cmd, args);
  // only watcher-visible mutations echo back as vault:changed, so only they
  // need attributing; a template or asset write never returns to us at all
  if (WATCHED_WRITE_COMMANDS.has(cmd) && !templateStem(args?.path)) {
    noteOwnWrite(writtenPathsFor(cmd, args, result));
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
    // that bypass is the point: this is a writer that isn't us
    const n = mockNotes.find((m) => m.path === path);
    if (!n) throw new Error(`__mockEditProp: no mock note at ${path}`);
    if (value === null) delete n.props[key];
    else n.props[key] = value as never;
    n.updated_ms = Date.now();
  };
  window.__mockEditSchema = (dbType, props) => {
    mockSchema[dbType] = mockRecord(props);
  };
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
  // The other-machine board. The index stays exactly as the machine
  // holding the folder left it — only this machine's binding goes — so a
  // dashboard over the mount still has rows to chart.
  window.__mockUnbindMount = (name, path) => {
    const m = mockMounts.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!m) throw new Error(`no such mount: ${name}`);
    if (path == null) delete mockMountBindings[m.id];
    else mockMountBindings[m.id] = path;
  };
}
