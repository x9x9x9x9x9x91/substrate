import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type {
  AggKind,
  ConflictSide,
  ConflictState,
  DbIcon,
  DiffLine,
  FolderMetaMap,
  FolderMapping,
  FolderScanStats,
  HistoryEntry,
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
  TrashEntry,
  VaultSyncStatus,
  ViewsConfig,
} from "./types.ts";
import { stripMachineFences } from "./fences.ts";
import { MOCK_FX } from "./fx.ts";
import { noteOwnWrite } from "./ownwrites.ts";
import { remapSavedQueryProperty } from "./query.ts";
import { isSystemPropName } from "./schemalookup.ts";
import { isAppFile } from "./settings.ts";

export const isTauri = "__TAURI_INTERNALS__" in window;

/* e2e hooks into the mock backend (SUB-156/SUB-158), all prefixed `__mock`:
   __mockFail is created by specs themselves; the rest are installed by the
   mock-only block at the bottom of this file, so the shipped app never has
   them. */
declare global {
  interface Window {
    /** command names the mock should reject with `mock failure: <cmd>` (SUB-156) */
    __mockFail?: Set<string>;
    /** fire the mock event registry — the vault:changed lane (SUB-158) */
    __mockEmit?: (event: string, payload?: unknown) => void;
    /** mutate a mock note's body out-of-band, like an external editor (SUB-158) */
    __mockEditNote?: (path: string, body: string) => void;
    /** remove a mock note out-of-band — a file deleted outside the app (SUB-506) */
    __mockDeleteNote?: (path: string) => void;
    /** clone a mock note under a new path — focused navigation specs use this
        to stage two dashboards of the same renderer without bloating seeds */
    __mockCloneNote?: (sourcePath: string, path: string) => void;
    /** same, one frontmatter property — what an outside editor changing a
        prop looks like to the undo guard (SUB-477) */
    __mockEditProp?: (path: string, key: string, value: unknown) => void;
    /** replace one mock schema entry like a hand edit on disk; public schema
        writes reject the duplicate identities this regression hook stages */
    __mockEditSchema?: (dbType: string, props: Record<string, PropSchema>) => void;
    /** stub the settings pane's terminal-font availability check (SUB-873):
        the real one measures canvas text, and whether an unknown family is
        dropped (CoreText) or substituted (fontconfig) is platform-specific,
        so a spec asserting the hint installs deterministic answers here */
    __mockFontAvailable?: (family: string) => boolean;
    /** bump a mock asset's mtime — a re-bounce under the same name (SUB-158) */
    __mockTouchAsset?: (name: string) => void;
    /** drop an asset straight into the mock .assets store — no app write (SUB-289) */
    __mockSaveAsset?: (name: string, data: string) => void;
    /** opt-in: completed note-mutating commands echo vault:changed, debounced
        like the engine's watcher (SUB-296) */
    __mockSetEchoOnWrites?: (on: boolean) => void;
    /** opt-in: command execution defers so IPC completion is never synchronous
        (SUB-295). true → small random timeout (thread-pool reorder);
        "microtask" → minimal defer that out-races React's scheduled
        re-render — the production resolution class behind the SUB-305
        restore race, which the random timeout is too slow to reach */
    __mockSetAsync?: (on: boolean | "microtask") => void;
    /** SUB-771 instrumentation: record write-lane commands (write_body /
        rename / create / read) with args + outcome from now on */
    __mockTraceCommands?: () => void;
    /** SUB-771 instrumentation: read the recorded command trace */
    __mockReadCommandTrace?: () => unknown[];
    /** hold every call to `cmd` open until `__mockReleaseCommand` — the
        deterministic form of an IPC still in flight while the user navigates
        away (SUB-550). The random "timeout" mode is too narrow a window to
        race a note switch against reliably. */
    __mockHoldCommand?: (cmd: string) => void;
    /** let a held command through (SUB-550) */
    __mockReleaseCommand?: (cmd: string) => void;
    /** bulk-seed `count` loose notes into `folder` — the only way to reach a
        list long enough for ListPane to window (SUB-461) */
    __mockSeedNotes?: (folder: string, count: number) => void;
    /** seed `count` notes that all match `token`, optionally typed and
        deliberately ranked below the untyped ones (SUB-566) — the only way to
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
        so this is the only way to reach the onboarding screen (SUB-436).
        Boot resolution happens on mount, so a spec staging first-run must
        set this flag from addInitScript, before the module loads; the
        setter is for flipping it afterwards. */
    __mockFirstRun?: boolean;
    __mockSetFirstRun?: (on: boolean) => void;
    /** stage a build with no demo vault bundled (SUB-436 review #3) — the
        backend refuses rather than opening an empty folder, so a spec needs
        a way to reach the refusal */
    __mockNoDemoVault?: boolean;
    /** read one prop straight out of the mock store — the disk truth a spec
        needs when the rendered chip can't distinguish a list from a joined
        scalar (SUB-553) */
    __mockPropOf?: (path: string, key: string) => unknown;
    /** read one note's body straight out of the mock store — the disk truth a
        spec needs when it must check what landed WITHOUT switching notes,
        since a note switch unmounts the pane and flushes on the way out
        (SUB-551) */
    __mockBodyOf?: (path: string) => string;
    /** every note path + body in the mock store, for failure-time dumps: when
        a spec fails it often does NOT know which path the note is under (a
        rename may or may not have landed), so the path-keyed readers above
        can't be used — they throw on a miss (SUB-771) */
    __mockNotesDump?: () => { path: string; body: string }[];
    /** did the app ask to relaunch? a browser mock can't actually restart */
    __mockRelaunched?: () => boolean;
    /** the agent command onboarding wrote (SUB-804) — null = never called,
        "" = called as skip */
    __mockAgentCommand?: () => string | null;
    /** park a conflicted merge in the mock "repository" WITHOUT a pull having
        happened in this session — the state a restart leaves behind, where
        the engine still has the merge but no last result to report (SUB-572) */
    __mockParkConflicts?: () => void;
  }
}

interface MockNote extends NoteMeta {
  body: string;
  /** vault_read rejects for these — a file that vanished or became unreadable */
  unreadable?: boolean;
  /** raw frontmatter block, no fences (SUB-430) — tracked only when the
      block's health matters (the repair lane); absent = no block, so
      vault_fm_raw returns null like the engine on a block-less file */
  fm?: string;
  /** SUB-552: the file opens with `---` and never closes it. The engine sees
      no block at all (split_frontmatter returns None), so `fm` stays absent —
      but prop writes still refuse, and the banner says so without offering a
      repair dialog there is no block to fill. */
  fmUnterminated?: boolean;
}

const now = Date.now();

/* onboarding mock state (SUB-436): the mock vault is always present, so
   first-run is opt-in via __mockSetFirstRun before the app boots. */
let mockVaultRoot = "/Users/demo/Vault (mock)";
let mockFirstRun =
  typeof window !== "undefined" && (window as Window).__mockFirstRun === true;
let mockRelaunched = false;
let mockAgentCommand: string | null = null;

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
   lane (SUB-202) — chips never decode the payload, so a stub suffices. */
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

/* Per-name asset mtimes (SUB-158): vault_asset_info reads from here so an e2e
   re-bounce (window.__mockTouchAsset) changes the asset's cacheKey — the
   constant 1 made the audio-player rebind lane unreachable from specs. */
const mockAssetMtimes = new Map<string, number>();

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
  /* The seeded agent orientation files (SUB-831): indexed like the real
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
    // SUB-430: one note whose frontmatter block is broken (duplicate key).
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
    // SUB-552: the opening fence is never closed, so the engine reads the
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
    // workbook pages (SUB-464): metrics page 0 + a sheet page, a view page,
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
    // hub note seed (SUB-86): prose plus a ```view fence over the release db,
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
    // the end feed the food pane's weight overlay (SUB-707), sparse on purpose
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
    // subfoldered dashboard seed (SUB-466): lives one level below the
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
    // hub dashboard seed (SUB-189): `dashboard: hub` — the body is ordinary
    // markdown; the hub renderer lays `##` sections out with consecutive
    // callouts as side-by-side cards, the rest in linear flow. Old
    // updated_ms keeps it out of the Today recency grid; the title sorts
    // between Portfolio and Yield APR in the sidebar.
    // The two trailing ```view fences are SUB-860's fixture: `## People`
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
    body: "Label home — the pipeline at a glance.\n\n## Releases\n\n> [!note] In review\n> [[Slow Bloom EP]] is with the label for sequencing notes.\n> [!warn] Waiting on masters\n> [[Vessel Songs]] masters v2 are due back this week.\n> [!idea] Next up\n> [[Static Bouquet]] blue-series follow-up — pitch the live session.\n\nEverything below the cards renders in linear flow.\n\n| release | status |\n| --- | --- |\n| [[Slow Bloom EP]] | in review |\n| [[Vessel Songs]] | mastering |\n\n## People\n\n```view\ntype: contact\nview: table\n```\n\n## Broken\n\n```view\ntype: nosuchtype\n```\n",
  },
  {
    // tasks dashboard seed (SUB-732): a read-only cut of task notes. Areas is
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
    // food dashboard seed (SUB-325): `dashboard: food` — config props only,
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
    // the food dashboard's DB (SUB-408): stable kcal bases the autocomplete
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
    // feed dashboard seed (SUB-518): `dashboard: feed` — config props only,
    // items live in the News Items sheet below. `curated` renders verbatim;
    // day-relative so the pane's ~36h staleness dot (SUB-699) stays quiet by
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
    // music-work dashboard seed (SUB-595): `dashboard: music-work` — config
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
    path: "Finance/2025-11 Invoice Old Vendor.md",
    stem: "2025-11 Invoice Old Vendor",
    title: "2025-11 Invoice Old Vendor",
    folder: "Finance",
    props: {
      created: "2026-07-17",
      type: "finance-doc",
      file: "~/Personal/Finance/2025-11 Invoice Old Vendor.pdf",
      modified: "2026-06-01 10:12",
      size: "90210",
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
      // pinned to the board's Now section (SUB-786) — hand-picked focus,
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
      // snoozed off the tasks board until next week (SUB-786) — counted in
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
    // e2e floor asserts by title (SUB-182 added three overdue-adjacent tasks)
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
    // SUB-270: the timed lane — a date prop carrying HH:MM on the same day as
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
    // SUB-646: the ranged lane — a same-day `start/end` date prop, so e2e can
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
    // listed but unreadable — the vanished-file empty state (SUB-54) has a
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

/* ── Generated bulk density (SUB-170) ──────────────────────────────────────
   Programmatic fixtures layered on top of the hand-crafted set above, so the
   mock vault reads closer to the real thing (a full label pipeline, a deep
   contacts book, a packed inventory) instead of a toy. Everything derives
   from loop indices — no Date.now(), no Math.random() — so every boot serves
   the identical vault.

   The e2e suite pins the seeded world hard, which shapes what bulk may do:
   - the sidebar orders its (homeless) database list count-desc then
     alphabetically; the Release > Sheet > Contact > Event > Finance-doc >
     Gear chain was pinned while the flat sidebar section lived (SUB-159
     removed it — only per-db counts are asserted now), so seeded counts may
     grow freely as long as each asserted count is updated in step. SUB-182
     grew the calendar-eligible dbs: task 4 → 17 (homed in Tasks/, invisible
     to the flat list — free), event 2 → 4 counterbalanced by contact 2 → 4
     and sheet 3 → 5 (release 5 = sheet 5 and contact 4 = event 4, ties break
     alphabetically); SUB-270 added the timed event (event 4 → 5). Catalog/
     artist/inventory/diary keep clear of the asserted counts. Counts are asserted
     at: smoke db rows/filters (release 5 wholesale; task 17, `due < 7d` →
     "13 of 17", +1 in-test create → 18), db-block "N entries" texts, the
     folder-trash "5 notes" (SUB-270 added the timed event), and the
     delete-task dialog ("17 entries").
   - the calendar's create-type list is asserted exactly ([event, release,
     task]) and is built from types that hold dated entries, event first then
     alphabetical — count-independent, but no generated note may expose an
     ISO-shaped date in a schema-unruled prop (`created` is always exempt).
     The catalog's `released` keeps ISO values but the schema rules it kind
     text, which the calendar reads as "not a date". The SUB-182 contacts and
     sheets carry no ISO props beyond `created` for the same reason.
   - the Notes scratch list is asserted at exactly 4 untyped rows — every
     generated note carries a type.
   - Today's recency grid tops out at the 8 seeded notes — generated
     updated_ms sit 2+ days in the past (genUpdated), so the top-8 closed set
     holds even after SUB-182.
   - the overdue strip/tray count is a FLOOR in e2e (≥ 1, plural-safe), no
     longer exactly 1: "Renew Bandcamp plan" (day −2) is the named fixture,
     joined by three overdue-adjacent SUB-182 tasks (day −1/−3/−8).
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
/* product-page links for the url-kind `link` prop (SUB-172) — every fifth
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
  // checkbox kind (SUB-173): every third unit is in the live rig — the
  // checked lane; the rest demo unchecked (prop absent, never `false`)
  if (i % 3 === 0) props["in use"] = true;
  // number kind, euro format (SUB-188): most rows carry a price (a few with
  // decimals) — Pellas RP-2 demos the junk lane (renders exactly as typed),
  // every fourth row leaves the cell empty
  if (i === 2) props.price = "ask";
  else if (i % 4 !== 3) props.price = 199 + ((i * 137) % 2400) + (i % 5 === 0 ? 0.5 : 0);
  // the importer's dedupe stamp (SUB-328) — real migrated rows all carry it;
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
  // SUB-300: a stale pick — `today` still points at yesterday, so the rebuilt
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
  // SUB-605: a dashboard filed in a CONTENT folder, not under the dashboards
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

/* ── Dated density (SUB-182) ────────────────────────────────────────────────
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
   release 5 vs sheet 6 (Food Log, SUB-325 — moot for ordering since SUB-159
   removed the flat list; only per-db counts are asserted, and no spec pins
   the sheet count) and contact 4 = event 4, ties break alphabetically.
   Every note carries a type (Notes keeps exactly its
   4 scratch rows), no ISO-shaped prop sneaks in beyond the scheduling one
   (`due` / `date` — `created` is exempt), and titles/bodies stay clear of the
   search/palette keywords listed above. */
/* `area`/`priority` are optional here and drive ONLY the tasks board (SUB-870):
   the allowlist is Label/Studio/Admin, so a filler without an area stays off
   that board while still counting as one of the 17 seeded tasks every db-view
   spec pins. Three carry an area on purpose — one more overdue row, and two
   upcoming ones so the board's area groups render below its urgency spine. */
const DENSE_TASKS: {
  title: string;
  due: number;
  status: string;
  line: string;
  area?: string;
  priority?: string;
}[] = [
  // overdue-adjacent: joined "Renew Bandcamp plan" in the overdue strip
  { title: "Chase the test pressing approvals", due: -1, status: "doing", area: "Label", priority: "High", line: "Two plants answered, one still owes the green light." },
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
      created: FIXED_BASE,
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
   contact carries an email (SUB-181); Tess also has a phone — the second
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

/* ── Wide royalty ledger (SUB-193) ──────────────────────────────────────────
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
  return m;
}

/* Frontmatter health for the fm lanes (SUB-430), mirroring vault.rs's
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

/** The write-lane refusal wording (SUB-215), mirroring FmFault::refusal. */
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

/** Prop equality for the undo guard (SUB-477) — the engine compares
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

/* Mock folder meta (SUB-84): vault-relative folder path → icon, mirroring
   the `$folders` key in views.json. One seed so the read path shows on boot;
   rename retargets keys, trash drops them, like the engine. */
const mockFolderMeta: FolderMetaMap = {
  Projects: { icon: { emoji: "🌱" } },
};

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

/** Mirrors Engine::move_sidebar_pin (SUB-410): a pinned note path follows its
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

/** Mirrors Engine::retarget_sidebar_keys (SUB-467): `f` maps one target token
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
    delete passes ONE stamp for the whole selection (SUB-577). Throws like the
    engine when the path isn't a live note. */
function mockTrashNote(path: string, at: number): string {
  const idx = mockNotes.findIndex((n) => n.path === path);
  if (idx === -1) throw new Error("note not found");
  const [n] = mockNotes.splice(idx, 1);
  // a trashed note leaves the sidebar with it (engine move_sidebar_pin)
  mockMoveSidebarPin(n.path, null);
  // …and its assigned key frees up (SUB-467)
  mockMoveSidebarKeys(n.path, null);
  // engine Engine::trash bumps the stamp until the id is free, so two
  // deletions of the same path never collide (SUB-478)
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
      // a pinned note inside the folder keeps its row (SUB-410)
      mockMoveSidebarPin(n.path, moved);
      n.path = moved;
      n.folder = mockFolderOf(n.path);
    }
  }
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
  // …and every key bound into the subtree, the folder row included (SUB-467).
  // One subtree pass covers the notes too, so the per-note loop above
  // doesn't call the key mirror.
  mockMoveSidebarKeysFolder(oldRel, newRel);
}

let mockSavedViews: SavedView[] = [];

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
  // location chip (template default "Studio" wins) — the SUB-60 demo lane
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
    // the tasks board pills priority in the schema's own colors (SUB-870);
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
    // multi (SUB-79): several values per release — Notion multi_select parity
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
  // the generated pipeline (SUB-170): `released` is kind text ON PURPOSE — a
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
  // url kind (SUB-172): product-page links on the gear inventory — the demo
  // lane for clickable link cells; a few rows carry values (below)
  // checkbox kind (SUB-173): `in use` flags the gear in the live rig — a few
  // rows carry `true` (below), the rest demo the unchecked lane
  // number kind (SUB-188): `price` is the euro-formatted money column — most
  // rows carry a value (below), one carries junk, some stay empty; it also
  // carries the fixture property description (SUB-191)
  inventory: {
    link: { options: [], kind: "url" },
    "in use": { options: [], kind: "checkbox" },
    price: { options: [], kind: "number", format: "euro", description: "Approximate is fine — current resale value." },
  },
  // email/phone kinds (SUB-181): the contacts book is the demo lane — every
  // row carries an email, two carry a phone (the empty-cell lane). The role
  // select (SUB-184) is the grouped table's "By Type" lane — options in a
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
  /* ledger (SUB-193): the wide royalty-statement fixture — 16 props + title +
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

/* ── Perf fixture (SUB-310, gated) ──────────────────────────────────────────
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

/* Folder-database mock: one mapping, ~/Personal/Finance → finance-doc, with a
   dozen fake files. Rescan creates stub notes idempotently (dedupe by the
   file prop) like the real engine; the pre-seeded stub above points at a file
   that is NOT here, so the first rescan flags it missing. The mapping's type
   is mutable state: rename_type rewrites it and delete_type drops it
   (SUB-71), so a rescan can't resurrect a renamed or deleted database. */
let mockFolderMappings: { path: string; dbType: string; globs?: string[]; watch?: boolean }[] = [
  { path: "~/Personal/Finance", dbType: "finance-doc" },
];
const mockFolderFiles = [
  { name: "2026-01 Invoice Acme Mastering.pdf", size: 184211, modified: "2026-01-31 10:02" },
  { name: "2026-02 Invoice Acme Mastering.pdf", size: 186004, modified: "2026-02-27 09:41" },
  { name: "2026-03 Invoice Acme Mastering.pdf", size: 183557, modified: "2026-03-31 11:15" },
  { name: "2026-07 Rechnung Umbra.pdf", size: 92814, modified: "2026-07-02 14:48" },
  { name: "2025 Steuererklärung.pdf", size: 1204551, modified: "2026-05-11 16:22" },
  { name: "2026-05 Kontoauszug.pdf", size: 88109, modified: "2026-06-03 08:30" },
  { name: "2026-06 Kontoauszug.pdf", size: 89012, modified: "2026-07-03 08:31" },
  { name: "Mietvertrag 2025.pdf", size: 245880, modified: "2025-11-20 13:05" },
  { name: "Versicherung Haftpflicht 2026.pdf", size: 154302, modified: "2026-01-04 12:00" },
  { name: "Depot Jahresabrechnung 2025.pdf", size: 301455, modified: "2026-02-14 09:12" },
  { name: "Quittung Rondo Service.png", size: 488203, modified: "2026-04-19 17:40" },
  { name: "Ausgaben 2026.csv", size: 4210, modified: "2026-07-15 21:03" },
];
/** The wire shape of one mock mapping — the engine's FolderMapping serializes
    `db_type` as `type`, globs always present, `watch` skipped when false. */
const mockFolderMappingWire = (m: (typeof mockFolderMappings)[number]): FolderMapping => ({
  path: m.path,
  type: m.dbType,
  globs: m.globs ?? [],
  ...(m.watch ? { watch: true } : {}),
});
/* Mock `.vault/templates/` (SUB-17): type → template note. `release` and
   `event` have one, so the born-complete create demos both lanes — templated
   types (defaults + body skeleton) and schema-only types (empty chips).
   Explicit-path reads/writes under `.vault/templates/` reach this store like
   the real engine's hidden-path exception (SUB-59). */
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

/* Mock Settings.md (SUB-398): the ⌘, sheet reads/writes the root settings
   note by path. In the real engine it's a normal indexed note; here it lives
   outside mockNotes — like the template store above — so the seeded list
   counts every spec asserts stay put (concealed by default since SUB-878,
   `vault_list` serves it so the reveal toggle can be exercised; only a spec
   that flips `show-agent-files` ever sees the row). Parity covers the
   read/set_prop IPC the settings sheet uses plus that list membership. */
const mockSettings: { props: Record<string, unknown>; body: string; updated_ms: number } = {
  props: { "capture-hotkey": "alt+space", "close-to-tray": "false" },
  body: "Substrate settings — edit and save; changes apply within a second (⌘, opens the settings form).\n",
  // stable like the other seeds (a Date.now() here would float the row to the
  // top of every list once revealed, SUB-878); writes bump it like real notes
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
  };
}

/* Mock database icons (SUB-27): stored separately and merged under each
   type's reserved `icon` key at read time — the same shape schema.json has
   on disk (SchemaConfig here stays the props-only view; the reserved key is
   a DbIcon, not a PropSchema, so the merge casts). Seeds demo all three
   kinds: tinted glyph, plain glyph, emoji. */
const mockIcons = mockRecord<DbIcon>({
  release: { glyph: "music", tint: "violet" },
  gear: { glyph: "wrench" },
  task: { emoji: "🎵" },
});

/* Mock database home folders (SUB-85): stored separately and merged under
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
    mirrors the engine's template_rel exception (SUB-59). */
function templateStem(p: unknown): string | null {
  return /^\.vault\/templates\/([^/]+)\.md$/.exec(String(p ?? ""))?.[1] ?? null;
}

/** Mirrors Engine::make_excerpt (vault.rs): the first line that is non-empty
    after stripping leading `# > - * ` markup and [[ ]] brackets, trimmed and
    truncated to 120 chars with an ellipsis. The mock's one excerpt rule —
    create, template meta, and write_body all run through here (SUB-290). */
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
  };
}

/* Trash mirrors the real `.trash/<deleted_ms>/<rel>` scheme: the note keeps
   its body so restore round-trips. Folder entries hold the whole subtree
   (`folderNotes` + `folderDirs`) — same unit restore as the engine. */
const mockTrash: (TrashEntry & {
  note?: MockNote;
  folderNotes?: MockNote[];
  folderDirs?: string[];
  /** asset entries (SUB-479): the base64 payload, so restore round-trips bytes */
  asset?: string;
  /** template entries (SUB-781): the template's content, so restore round-trips */
  template?: { props: Record<string, unknown>; body: string };
})[] = [];

// Phone-first vault sync — the git-backed feature, not a dashboard kind.
// This state mirrors VaultSyncState's last-result/last-error record and is
// page scoped, like the rest of the browser mock store.
// `conflicted` is not stored here: the engine derives it from the repository
// on every status call (SUB-572), so the mock derives it from the parked
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
  // engine parity (SUB-522): gitsync::sync_conflicts sorts `path ASC` before
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

/** Mirrors validate_note_title (vault.rs, SUB-223): a dot-stem would land
    the note outside the index and `[`/`]` would corrupt every rewritten
    link — refuse before any mutation, in create and rename alike. */
function mockValidateNoteTitle(title: string, slug: string) {
  if (slug.startsWith(".")) throw new Error("titles cannot start with a dot");
  if (title.includes("[") || title.includes("]"))
    throw new Error("titles cannot contain [ or ]");
  // the engine's third refusal (SUB-223/SUB-909): a control char isn't
  // whitespace, so it survives the slug collapse and only fails at the
  // filesystem. Same Cc set as Rust char::is_control: C0, DEL, C1.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(slug))
    throw new Error("titles cannot contain control characters");
}


/* Opt-in fidelity flags (SUB-296/SUB-295), both OFF by default. Like the rest
   of the mock's state they are page-load scoped — a spec's page.goto starts
   fresh, so no cross-spec reset plumbing is needed. */
let mockEchoOnWrites = false;
// false | "timeout" (SUB-295 random 1–25ms reorder) | "microtask" (SUB-305:
// resolves before React's scheduled re-render, like production thread-pool
// IPC can — the ordering the restore race loses on)
let mockAsyncDispatch: false | "timeout" | "microtask" = false;
// SUB-771 instrumentation: opt-in write-lane command trace (null = off)
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
// SUB-550: commands parked open until their release fn runs — the in-flight
// IPC a spec needs to still be pending while it navigates elsewhere
const mockHeldCommands = new Map<string, Promise<void>>();
const mockHoldReleases = new Map<string, () => void>();

/* SUB-296: the engine never emits vault:changed from its commands — the OS
   watcher observes the write and, once the vault goes quiet for 300ms
   (vault.rs debounce), emits ONE vault:changed for the whole burst. With the
   flag on the mock mirrors that cadence: each completed note-mutating command
   (re)arms a 300ms timer and a quiet gap flushes a single echo, so a burst of
   writes coalesces exactly like the real watcher. Commands the watcher can't
   see never echo: template writes (SUB-59 — templates live outside the
   watcher), trash purges/empties and asset writes (dot-paths), config writes
   (.vault/*.json ride vault:config-changed instead, SUB-100), history
   snapshots/purges (.git-internal).

   The four database/property bulk sweeps ARE watched (SUB-660): they rewrite
   ordinary vault notes through edit_props → write_atomic, so the OS watcher
   sees them exactly like any other note write. They classify with unnamed
   reach — a `BulkSweep` returns counts only, never the swept paths — the same
   honest answer a folder op gives, and it keeps a sweep's own echo from being
   read as somebody else's edit and flattening the undo stack. */
const WATCHED_WRITE_COMMANDS = new Set([
  "vault_write_body",
  "vault_fm_write",
  "vault_set_prop",
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
  "folder_dbs_rescan",
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

/** Engine parity (SUB-460/SUB-516): the watcher's event names the rel paths
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
    event, and the app records them as its own write (SUB-516). `null` means
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
      // set_prop returns { meta, prior }; the others return the meta itself
      return [path ?? metaPath((result as { meta?: unknown })?.meta ?? result)].filter(
        (p): p is string => !!p
      );
    case "vault_create":
    case "url_capture":
    case "history_restore":
      return [metaPath(result)].filter((p): p is string => !!p);
    case "vault_move":
      // the engine renames on disk and the watcher emits BOTH rels — name the
      // vacated path too, or its echo reads external and the move kills its
      // own undo entry (SUB-653)
      return [path, metaPath(result)].filter((p): p is string => !!p);
    case "vault_rename": {
      // every note the link sweep rewrote, not just the renamed one (SUB-515)
      // — plus the vacated path, which `touched` never names (SUB-653)
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
      // vault_rename_folder, folder_dbs_rescan — whole-subtree reach.
      // vault_rename_type/_delete_type/_rename_prop/_clear_prop land here too
      // (SUB-660): a `BulkSweep` result carries counts, not paths, so the
      // sweep's reach genuinely isn't nameable from the call.
      return null;
  }
}

/** Mirrors the engine: a folder rescan echoes only when it actually created,
    stamped, or missing-flagged notes (lib.rs emits vault:changed on
    `changed`, not per scan). */
function mockRescanChanged(result: unknown): boolean {
  return (
    Array.isArray(result) &&
    result.some((s: FolderScanStats) => s.created + s.updated + s.missing > 0)
  );
}

/* Engine parity (SUB-519): both search commands cap their result set, so the
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

/** Sort key for both mock search commands — see the SUB-519 note above. */
function mockRank(a: MockSearchRank, b: MockSearchRank): number {
  if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
  if (a.offset !== b.offset) return a.offset - b.offset;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

type MockSearchRank = { titleHit: boolean; offset: number; path: string };

function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  // SUB-771 instrumentation: an opt-in ring of write-lane commands with their
  // args and outcomes, read by the failure dump. No effect unless a spec
  // installed the trace hook.
  if (mockCmdTrace && /^vault_(write_body|rename|create|read)$/.test(cmd)) {
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
  // SUB-550: an explicitly held command waits for its release before running
  const held = mockHeldCommands.get(cmd);
  if (held) return held.then(() => mockInvoke(cmd, args));
  // both flags off: straight dispatch — resolution timing byte-identical to
  // the pre-flag mock (the whole suite's baseline is the blast-radius proof)
  if (!mockAsyncDispatch && !mockEchoOnWrites) return mockDispatch(cmd, args);
  return mockInvokeFidelity(cmd, args);
}

// SUB-771 instrumentation: run the traced command through the normal pipeline
// (hold gate + fidelity flags untouched) and record how it ended.
async function mockInvokeTraced(
  cmd: string,
  args: Record<string, unknown> | undefined,
  entry: MockTraceEntry
): Promise<unknown> {
  const held = mockHeldCommands.get(cmd);
  if (held) await held;
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
  // SUB-295 opt-in: real IPC handlers run on a thread pool — completion is
  // never synchronous and back-to-back commands carry no ordering guarantee.
  // "timeout" defers execution by a small random delay so ordering-sensitive
  // flows (the SUB-286 write-then-rename class) can actually race.
  // "microtask" (SUB-305) defers only to a microtask: still never synchronous,
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
  // SUB-296 opt-in: echo a completed note mutation like the engine watcher.
  // Template paths are excluded even for the write commands (watcher-blind).
  if (
    mockEchoOnWrites &&
    WATCHED_WRITE_COMMANDS.has(cmd) &&
    !templateStem(args?.path) &&
    (cmd !== "folder_dbs_rescan" || mockRescanChanged(result))
  ) {
    scheduleMockEcho(writtenPathsFor(cmd, args, result));
  }
  return result;
}

async function mockDispatch(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  // SUB-156 e2e hook: a spec-listed command rejects, reaching the UI error
  // surfaces (boot-error bar, save-failed pill, capture error) that an
  // always-succeeding mock leaves untestable
  if (window.__mockFail?.has(cmd)) throw new Error(`mock failure: ${cmd}`);
  const find = () => mockNotes.find((n) => n.path === args?.path);
  switch (cmd) {
    case "vault_root":
      return mockVaultRoot;

    /* first-run onboarding (SUB-436). The mock vault always exists, so the
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
      // opening silently (SUB-436 review #4).
      const isVault = /vault/i.test(path) && !/new|fresh|empty|checkout/i.test(path);
      const exists = !/new|fresh|missing/i.test(path);
      return {
        path,
        exists,
        is_vault: isVault,
        empty: !exists || /empty/i.test(path),
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
    case "vault_list":
      // Settings.md is indexed like the real engine indexes it (SUB-878) —
      // the App-side app-file filter is what conceals it by default
      return [...mockNotes.map(meta), mockSettingsMeta()].sort(
        (a, b) => b.updated_ms - a.updated_ms
      );
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
        // creates the template when missing, like the real engine (SUB-59)
        const t = (mockTemplates[stem] ??= { props: mockRecord(), body: "" });
        // mirrors the engine's SUB-93 conflict guard
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
      // mirrors the engine's SUB-94 rule: a missing file is never resurrected
      if (!n) throw new Error("note no longer exists");
      if (expectedBody !== null && n.body !== expectedBody) {
        throw new Error("conflict: file changed on disk");
      }
      n.body = args?.body as string;
      n.updated_ms = Date.now();
      // mirrors the engine's write_body → reindex_one → make_excerpt: lists
      // show the fresh excerpt after an edit, not the stale one (SUB-290)
      n.excerpt = mockMakeExcerpt(n.body);
      return meta(n);
    }
    case "vault_set_prop": {
      const key = args?.key as string;
      const value = args?.value as PropValue;
      // mirrors Engine::set_prop_guarded (SUB-477): `expected` present means
      // check, and its `value` is what the caller believes is on disk (null =
      // "expected absent"). A mismatch refuses the write, store untouched.
      const expected = args?.expected as { value: PropValue } | null | undefined;
      // mirrors the engine's write-domain match: strings, numbers, bools,
      // string lists, null. Anything else is refused there, so refuse here —
      // a mock that accepts more than the engine turns e2e into a lane that
      // proves nothing (the SUB-479 class of blind spot).
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
      // mirrors parse_props_for_write (SUB-215): a present-but-broken block
      // refuses every prop edit until the repair lane fixes it (SUB-430)
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
    case "vault_create": {
      // mirrors Engine::create_full: the title is filename-sanitized first,
      // then the create-time filename dedupe is scoped to the target folder —
      // Idea.md, Idea 2.md, Idea 3.md… — and case-insensitive like the
      // engine's exists-check on a case-insensitive filesystem. The note's
      // title/stem follow the deduped filename (create writes no `title:` prop)
      const rawTitle = (args?.title as string) ?? "Untitled";
      const title = mockSanitizeFilename(rawTitle);
      // mirrors Engine::create_full's SUB-223 guard
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
      // extra create-time props (SUB-17): schema-default chips + template
      // defaults; created/type/title stay engine-owned like in vault.rs
      for (const [k, v] of extraProps) {
        const key = k.trim();
        if (!key || isSystemPropName(key)) continue;
        n.props[key] = v;
      }
      n.excerpt = mockMakeExcerpt(body);
      mockNotes.push(n);
      return meta(n);
    }
    case "vault_template_read": {
      const stored = mockExistingTemplateName(((args?.noteType as string) ?? "").trim());
      const t = stored ? mockTemplates[stored] : undefined;
      return t ? JSON.parse(JSON.stringify(t)) : null;
    }
    case "vault_template_list":
      return Object.keys(mockTemplates).sort();
    // the mock lane never reaches the network: it answers with the same
    // historical rate the fixtures carry, so e2e baselines stay stable
    case "fx_usd_eur":
      return { usdEur: MOCK_FX.usdEur, asOf: MOCK_FX.asOf };
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
      // mirrors Engine::create_reference's SUB-223 guard
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
      const title = ((args?.title as string) ?? "").trim();
      if (!title) throw new Error("title cannot be empty");
      const slug = mockSanitizeFilename(title);
      // mirrors Engine::rename's SUB-223 guard — before any link rewrite
      mockValidateNoteTitle(title, slug);
      const newPath = n.folder ? `${n.folder}/${slug}.md` : `${slug}.md`;
      // case-insensitive like the engine's new_abs.exists() check on a
      // case-insensitive filesystem (and like mock vault_create's dedupe):
      // "Beta"→"ALPHA" collides with an existing "Alpha.md"; a case-only
      // rename of the note itself stays allowed (SUB-290)
      if (
        newPath.toLowerCase() !== n.path.toLowerCase() &&
        mockNotes.some((m) => m.path.toLowerCase() === newPath.toLowerCase())
      ) {
        throw new Error(`a note named “${slug}” already exists here`);
      }
      const oldNames = [n.title.toLowerCase(), n.stem.toLowerCase()];
      // mirrors Engine::rename: only relation props aimed at this note's
      // type follow the rename (SUB-216)
      const renamedType = (mockPropString(n.props, "type") ?? "").toLowerCase();
      // mirrors Engine::rename_tracked: every note the sweep actually rewrote,
      // the renamed one included, named by where it lands (SUB-515)
      const rewritten = new Set<MockNote>();
      for (const m of mockNotes) {
        // mirrors Engine::rename — ![[…]] embeds name assets, stay untouched
        const before = m.body;
        m.body = m.body.replace(/!?\[\[([^[\]]+)\]\]/g, (whole, inner) =>
          !whole.startsWith("!") && oldNames.includes(String(inner).trim().toLowerCase())
            ? `[[${title}]]`
            : whole
        );
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
      // post-move paths, renamed note first — same shape as RenameResult
      const touched = [n.path, ...[...rewritten].filter((m) => m !== n).map((m) => m.path)];
      return { meta: meta(n), touched };
    }
    case "vault_delete":
      return mockTrashNote(String(args?.path ?? ""), Date.now());
    /* SUB-577: mirrors Engine::trash_many — ONE stamp for the whole selection,
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
      // …and the note pins inside the subtree (SUB-410)
      for (const n of folderNotes) mockMoveSidebarPin(n.path, null);
      // …and every key bound into the subtree, the folder row included (SUB-467)
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
      });
      return id;
    }
    case "vault_trash_list":
      // engine parity (SUB-488): Engine::trash_list sorts `deleted_ms DESC,
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
      for (const n of t.folderNotes ?? []) {
        n.path = rel + n.path.slice(t.path.length);
        n.folder = mockFolderOf(n.path);
        n.updated_ms = Date.now();
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
      // a deleted database's template (SUB-781) — back into the template
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
      // machine-fence bodies are stripped like the engine's index (SUB-261)
      const tokens = ((args?.q as string) ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return [];
      const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const bound = "[\\p{L}\\p{N}]";
      // scope (SUB-566): the caller's structured filters, as a path allow-list.
      // Applied before the cap, exactly like the engine's `path IN (…)` clause —
      // otherwise the cap picks from the unfiltered set and filtered matches
      // that rank outside the top 30 vanish.
      const scope = (args?.scope as string[] | undefined) ?? null;
      const inScope = scope ? new Set(scope) : null;
      // conceal parity (SUB-907): the engine drops the app files before its
      // cap when asked, so the mock must too
      const skipAppFiles = (args?.excludeAppFiles as boolean | undefined) ?? false;
      return mockNotes
        .filter((n) => !(skipAppFiles && isAppFile(n.path)))
        .filter((n) => inScope === null || inScope.has(n.path))
        .filter((n) => {
          const hay = words(`${n.title}\n${stripMachineFences(n.body)}`);
          return tokens.every((t) => hay.some((w) => w.startsWith(t)));
        })
        // rank before capping, or the cap picks by insertion order (SUB-519)
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
      // scope (SUB-566): path allow-list applied before the cap, like the engine
      const fullScope = (args?.scope as string[] | undefined) ?? null;
      const fullInScope = fullScope ? new Set(fullScope) : null;
      // conceal parity (SUB-907): excluded before the count AND the cap, so
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
        // machine-fence bodies are stripped like the engine's index (SUB-261)
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
            hit: { path: n.path, title_parts: title.parts, total, matches },
            titleHit: title.count > 0,
            offset:
              title.count > 0
                ? mockFirstHit(n.title, terms, bound)
                : mockFirstHit(body, terms, bound),
            path: n.path,
          });
      }
      // rank before capping, or the cap picks by insertion order (SUB-519).
      // The count is of the whole match set, not the page (SUB-566) — the UI
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
                !match[0].startsWith("!") && names.includes(match[1].trim().toLowerCase())
            )
        )
        .map(meta)
        // engine parity (SUB-488): Engine::backlinks sorts by title before
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
      // engine parity (SUB-488): byte order like `str::cmp`, not localeCompare
      out.sort((a, b) =>
        a.title < b.title ? -1 : a.title > b.title ? 1 : a.prop < b.prop ? -1 : a.prop > b.prop ? 1 : 0
      );
      return out;
    }
    case "vault_resolve": {
      const needle = ((args?.name as string) ?? "").toLowerCase();
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
        for (const m of n.body.matchAll(re)) referenced.add(m[1].trim().toLowerCase());
      }
      return [...mockAssets.keys()]
        .filter((name) => !referenced.has(name.toLowerCase()))
        // engine parity (SUB-488): lowercased byte order (`to_lowercase().cmp`)
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
    // SUB-432: a small fixed report — one finding per kind, so the pane's
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
    /* SUB-479: asset delete moves into the trash as an `asset` entry keyed
       `<deleted_ms>/.assets/<name>`, mirroring Engine::assets_delete. */
    case "vault_assets_delete": {
      /* SUB-669: one entry per input name, in order — `Ok(id)` for a file that
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
        // engine parity (SUB-572): read from the parked merge, not from the
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
        // a push checks nothing out (engine parity, SUB-516)
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
        // engine parity (SUB-522): conflict_paths returns a BTreeSet, so this
        // list is sorted, not pull-order
        conflicted: ["Journal/2026-07-22.md", "Projects/Release plan.md"].sort(),
        head: "91c0f17ab4d2",
        // engine parity (SUB-516): this pull conflicts, so it parks the merge
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
      // engine parity (SUB-516): finishing checks the merge out, so every
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
      // (multi keeps them — SUB-79), relation needs a target, number validates
      // its display format (plain stores as absent, drops on other kinds), a
      // rollup (SUB-678) needs its relation (an existing relation-kind prop
      // of the same database), target prop and agg vocabulary, a
      // description (SUB-191) rides any kind trimmed (empty = absent), no
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
      // rollup wiring (SUB-678): three flat args like the IPC command sends
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
        // lead time (SUB-842) rides the same date-only rule: 0 clears it,
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
        // one home folder, one database (SUB-407)
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
      // SUB-501: the sweeps return a BulkSweep so a partial run can report its
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
      // …and so does the home folder (SUB-85)
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
      // a key bound to the database row follows the rename (SUB-467)
      mockMoveSidebarKeysDb(oldName, newName);
      if (templateOld) {
        mockTemplates[templateNew] = mockTemplates[templateOld];
        if (templateOld !== templateNew) delete mockTemplates[templateOld];
      }
      // folder-sync mappings follow the rename (SUB-71) — one left on the old
      // name would resurrect the database on the next rescan
      for (const m of mockFolderMappings) {
        if (m.dbType.trim().toLowerCase() === oldName.toLowerCase()) m.dbType = newName;
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
      // …and dies with the delete (SUB-467)
      mockMoveSidebarKeysDb(dbType, null);
      // the template goes through the trash like the engine's (SUB-781),
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
      // folder-sync mappings targeting the deleted type go with it (SUB-71) —
      // otherwise the next rescan feeds a ghost type
      mockFolderMappings = mockFolderMappings.filter(
        (m) => m.dbType.trim().toLowerCase() !== dbType.toLowerCase()
      );
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
      // …and every rollup in ANY database (SUB-740) whose relation points at
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
      // SUB-326: the remembered sort and hidden entries follow the rename too
      if (rnPref?.sorts) rnPref.sorts = rnPref.sorts.map((s) => (s.key.toLowerCase() === oldName.toLowerCase() ? { ...s, key: newName } : s));
      if (rnPref?.hidden) rnPref.hidden = rnPref.hidden.map((h) => (h.toLowerCase() === oldName.toLowerCase() ? newName : h));
      // SUB-642: per-layout hidden entries follow the rename too
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
      // SUB-326: the prop's sort key and hidden entry drop with it; emptied
      // lists leave the pref entirely (the engine's collapse-to-None rule)
      if (clPref?.sorts) {
        clPref.sorts = clPref.sorts.filter((s) => s.key.toLowerCase() !== prop.toLowerCase());
        if (clPref.sorts.length === 0) delete clPref.sorts;
      }
      if (clPref?.hidden) {
        clPref.hidden = clPref.hidden.filter((h) => h.toLowerCase() !== prop.toLowerCase());
        if (clPref.hidden.length === 0) delete clPref.hidden;
      }
      // SUB-642: per-layout sets lose the prop too — emptied sets collapse to
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
      // finance-folder links exist iff the mock folder still holds the file
      if (p.startsWith("~/Personal/Finance/")) {
        const name = p.split("/").pop() ?? "";
        return mockFolderFiles.some((f) => f.name === name);
      }
      // mock: anything with "missing" in the name is a broken link
      return !p.toLowerCase().includes("missing");
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
      // mirrors Engine::set_view_pref (SUB-326): bad sort dirs are refused,
      // empty lists collapse to absent, hidden entries trim (empties drop)
      const sorts = (args?.sorts as ViewsConfig[string]["sorts"] | null) ?? undefined;
      for (const s of sorts ?? []) {
        if (s.dir !== 1 && s.dir !== -1) throw new Error(`sort dir must be 1 or -1, got ${s.dir}`);
      }
      const hidden = ((args?.hidden as string[] | null) ?? undefined)
        ?.map((h) => h.trim())
        .filter(Boolean);
      // SUB-642: per-layout hidden sets sanitize like the flat list — entries
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
      // SUB-404: zero widths drop, wrap entries trim — Engine::set_view_pref
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
        hidden: hidden?.length ? hidden : undefined,
        widths: Object.keys(widths).length ? widths : undefined,
        wrap: wrap?.length ? wrap : undefined,
        // SUB-607: absent = follow the global db-grid setting
        grid: (args?.grid as boolean | null) ?? undefined,
        hidden_per_layout: hiddenPerLayout,
      };
      return { ...mockViews };
    }
    case "vault_folder_meta_read":
      return JSON.parse(JSON.stringify(mockFolderMeta));
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
      // engine parity (SUB-910): sanitize_folder_rel checks each RAW part,
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
      // engine parity (SUB-910): rename_folder sanitizes the new leaf and
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
    // SUB-698: a folder dragged under another parent ("" = vault root) keeps
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
      return meta(n);
    }
    case "vault_sidebar_order":
      return mockSidebarOrder;
    case "vault_set_sidebar_order": {
      mockSidebarOrder = args?.order as SidebarOrder;
      return mockSidebarOrder;
    }
    case "folder_dbs_list":
      return mockFolderMappings.map(mockFolderMappingWire);
    case "folder_dbs_add": {
      // mirrors Engine::add_folder_mapping (SUB-672): trimmed, empty path/type
      // refused, an exact path+type dupe refused case-insensitively
      const path = ((args?.path as string) ?? "").trim();
      const dbType = ((args?.dbType as string) ?? "").trim();
      if (!path || !dbType) {
        throw new Error("folder path and database type must be non-empty");
      }
      if (
        mockFolderMappings.some(
          (m) => m.path === path && m.dbType.toLowerCase() === dbType.toLowerCase()
        )
      ) {
        throw new Error(`“${path}” is already mapped to “${dbType}”`);
      }
      const globs = (Array.isArray(args?.globs) ? (args.globs as unknown[]) : [])
        .map((g) => String(g).trim())
        .filter(Boolean);
      mockFolderMappings.push({
        path,
        dbType,
        ...(globs.length ? { globs } : {}),
        ...(args?.watch ? { watch: true } : {}),
      });
      return mockFolderMappings.map(mockFolderMappingWire);
    }
    case "folder_dbs_rescan": {
      // mirrors Engine::sync_folders: one stats entry per mapping, and the
      // mapping's own path/db_type drive everything — never a hardcoded type,
      // so a rename/delete can't resurrect a database here (SUB-71). Dedupe
      // by the file prop, refresh stamps on change, flag vanished files
      // missing (engine SYNC_PROPS: synced props never become empty chips)
      const syncProps = new Set(["type", "title", "file", "modified", "size", "missing", "created"]);
      const out: FolderScanStats[] = [];
      for (const mapping of mockFolderMappings) {
        let created = 0;
        let updated = 0;
        let missing = 0;
        // the engine names the vault folder after the watched folder's
        // sanitized basename, falling back to the type
        const base = mapping.path.split("/").pop() ?? "";
        const vaultFolder = base ? mockSanitizeFilename(base) : mapping.dbType;
        const schemaEmpties = Object.keys(mockSchema[mapping.dbType] ?? {}).filter(
          (k) => !syncProps.has(k)
        );
        const seen = new Set<string>();
        for (const f of mockFolderFiles) {
          const filePath = `${mapping.path}/${f.name}`;
          seen.add(filePath);
          const existing = mockNotes.find((n) => n.props["file"] === filePath);
          if (existing) {
            if (existing.props["missing"] === "true" || existing.props["size"] !== String(f.size)) {
              existing.props["size"] = String(f.size);
              existing.props["modified"] = f.modified;
              delete existing.props["missing"];
              existing.updated_ms = Date.now();
              updated++;
            }
            continue;
          }
          const stem = f.name.replace(/\.[^.]+$/, "");
          let path = `${vaultFolder}/${stem}.md`;
          let i = 2;
          while (mockNotes.some((n) => n.path === path)) path = `${vaultFolder}/${stem} ${i++}.md`;
          // the engine's first stub write creates the vault folder on disk
          mockAddFolder(vaultFolder);
          mockNotes.push({
            path,
            stem: path.slice(vaultFolder.length + 1, -".md".length),
            title: stem,
            folder: vaultFolder,
            props: {
              created: day(0),
              type: mapping.dbType,
              file: filePath,
              modified: f.modified,
              size: String(f.size),
              ...Object.fromEntries(schemaEmpties.map((k) => [k, ""])),
            },
            updated_ms: Date.now(),
            excerpt: "",
            body: "",
          });
          created++;
        }
        for (const n of mockNotes) {
          const file = n.props["file"];
          if (typeof file !== "string" || !file.startsWith(`${mapping.path}/`)) continue;
          if (seen.has(file)) continue;
          if (n.props["missing"] !== "true") n.props["missing"] = "true";
          missing++;
        }
        out.push({
          folder: mapping.path,
          db_type: mapping.dbType,
          scanned: mockFolderFiles.length,
          created,
          updated,
          missing,
        });
      }
      return out;
    }
    case "agenda_open_note":
      // the real backend surfaces the main window with this note open
      console.info("[mock] open note from tray agenda", args?.path);
      return null;
    case "agenda_open_capture":
      console.info("[mock] open capture from tray agenda");
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
    case "history_list": {
      const n = find();
      if (n) return mockEntries(n.path, snapsFor(n));
      // off-disk paths (trashed/deleted notes) keep their snapshots, like the engine
      const path = args?.path as string;
      return mockEntries(path, mockHistory.get(path) ?? []);
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
      const snap = snaps.find((s) => s.id === args?.id);
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

/* SUB-516 — own-write attribution lives here, at the one place every vault
   mutation passes through. The alternative was tagging each of the ~30
   `refresh()` call sites in App.tsx with the paths it just wrote, which is the
   same knowledge derived twice and drifts the first time a call site forgets.
   Here the command and its result are already in hand, and the reach of a
   write is exactly what `writtenPathsFor` reads off them. */
const rawInvoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = isTauri
  ? tauriInvoke
  : (mockInvoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>);

export const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const result = await rawInvoke<T>(cmd, args);
  // only watcher-visible mutations echo back as vault:changed, so only they
  // need attributing; a template or asset write never returns to us at all
  if (WATCHED_WRITE_COMMANDS.has(cmd) && !templateStem(args?.path)) {
    noteOwnWrite(writtenPathsFor(cmd, args, result));
  }
  return result;
};

/* Mock event registry (SUB-158): the real listen() bridges the engine's file
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

/* e2e-only surface (SUB-156/SUB-158): installed only outside Tauri, so the
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
  };
  // the file vanishing under the app (SUB-506): same outside-the-app bypass as
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
    mockNotes.push({
      ...source,
      path,
      stem,
      title: stem,
      folder,
      props: { ...source.props },
      updated_ms: Date.now(),
    });
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
  window.__mockTouchAsset = (name) => {
    mockAssetMtimes.set(name, (mockAssetMtimes.get(name) ?? 1) + 1);
  };
  // an asset appearing on disk without an app write (SUB-289): no echo
  // window, so the next __mockEmit refreshes immediately
  window.__mockSaveAsset = (name, data) => {
    mockAssets.set(name, data);
  };
  // SUB-296/SUB-295 opt-ins; off by default, reset by the next page load
  window.__mockSetEchoOnWrites = (on) => {
    mockEchoOnWrites = on;
    if (!on) window.clearTimeout(mockEchoTimer); // a pending echo dies with the flag
  };
  window.__mockSetAsync = (on) => {
    mockAsyncDispatch = on === true ? "timeout" : on;
  };
  // SUB-771 instrumentation: start/read the write-lane command trace
  window.__mockTraceCommands = () => {
    mockCmdTrace = [];
    mockCmdTraceT0 = Date.now();
  };
  window.__mockReadCommandTrace = () => mockCmdTrace ?? [];
  // SUB-550: park a command mid-flight so a spec can navigate away while it is
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
  window.__mockReleaseCommand = (cmd) => {
    mockHeldCommands.delete(cmd);
    mockHoldReleases.get(cmd)?.();
    mockHoldReleases.delete(cmd);
  };
  // SUB-461: a windowing-sized list. Half the seeds carry a subtitle prop, so
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
  // SUB-566: a cap-sized match set. `where` decides the rank — a title hit
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
  // SUB-436: stage the no-vault state the real backend reaches on a machine
  // with neither VAULT_DIR, a stored choice, nor ~/Vault
  window.__mockSetFirstRun = (on) => {
    mockFirstRun = on;
  };
  window.__mockRelaunched = () => mockRelaunched;
  window.__mockAgentCommand = () => mockAgentCommand;
  // SUB-572: stage a merge that was parked before the app restarted. The
  // engine keeps it in git refs, so status still reports it; only the
  // session's last-result record is gone, which is exactly what this leaves.
  window.__mockParkConflicts = () => {
    mockConflicts = mockConflictSeed();
  };
}
