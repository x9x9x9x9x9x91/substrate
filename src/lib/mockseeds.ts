/** The mock backend's FIXTURE: every seed note, asset and loose file the app
    shows when it runs without a Tauri host (`npm run dev`, and every e2e spec).

    It was carved out of `tauri.ts`, which had grown to carry the production
    IPC bridge and the whole mock backend in one file. The DISPATCH — the
    `mockInvoke`/`mockDispatch` pair that answers a command with one of these
    fixtures — deliberately stays there: `scripts/check-ipc.ts` reads the mock
    case list out of `src/lib/tauri.ts` by name, and this lane may not edit
    `scripts/`.

    Nothing here is imported by the app's own code, only by the bridge. The
    public seam the e2e suite drives (`window.__mock*`) is unchanged, and so
    are the fixture's contents: this is a move, not an edit. */

import type { NoteMeta } from "./types.ts";
import { daysAgoIso } from "./dates.ts";

/** `sealed` is REQUIRED on `NoteMeta` but stays optional on the
    fixture: nearly a hundred seed notes are plaintext, and `meta()` below is
    the single boundary where a fixture becomes a `NoteMeta`, so it fills the
    default there rather than making every literal carry `sealed: false`. */
export interface MockNote extends Omit<NoteMeta, "sealed"> {
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

export const now = Date.now();

/** An ISO day `d` days from today — the ```progress fixtures need
    deadlines that stay in the future, since a fence's pace line reads against
    the real calendar and a hard-coded date would rot the fixture. Built on
    daysAgoIso so the day is a LOCAL calendar day: a UTC slice would land a day
    off near local midnight, against the todayIso() the pace line reads. */
const isoDay = (d: number) => daysAgoIso(-d, new Date(now));
/** local YYYY-MM-DD, `offset` days from today — keeps demo calendar entries
    near whatever day the app is opened */
export const day = (offset: number) => {
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
export const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const mockAssets = new Map<string, string>([
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
export const mockAssetMtimes = new Map<string, number>();

/* The loose (non-.md) files a folder view lists as rows, per folder.
   Notes live in mockNotes; these are the rest of what sits on disk beside
   them. Nothing under `.assets/` appears here and nothing here is an asset —
   that separation IS the dedupe rule the real engine enforces by skipping
   dot-paths, so the browser gate exercises the same shape.
   Deliberately a mix: two audio files (the playlist) and one that isn't
   (the open/reveal row). */
export const mockLooseFiles = new Map<string, string[]>([
  ["Projects", ["01 umbra rough.wav", "02 umbra bounce.wav", "umbra session.als"]],
]);

/** One stable mtime for every loose file: the player's cacheKey is built from
    path+size+mtime, so a value that moved between calls would rebind players
    mid-spec. */
export const mockLooseMtime = now - 3 * 86_400_000;

export const mockNotes: MockNote[] = [
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
    // sync dashboard seed: `dashboard: sync` — the SyncDashboard reads the
    // machine's sync state over IPC (the sync_state_read mock lane below), so
    // the body is prose only. Old updated_ms keeps it out of the Today
    // recency grid. This is the note syncmanager.spec navigates to.
    path: "Dashboards/Sync.md",
    stem: "Sync",
    title: "Sync",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "sync", created: "2026-07-17" },
    updated_ms: now - 9 * 86_400_000,
    excerpt: "sync control surface — legs, remotes, launchd automation.",
    body: "Backup-sync control surface. The dashboard reads the machine's live sync state — per-leg status, direction sweeps, launchd automation — so there is nothing to edit in this prose.\n",
  },
  {
    // coding dashboard seed: `dashboard: coding` — the CodingDashboard reads
    // the scan root's per-repo git health over IPC (the coding_scan mock lane
    // below), so the body is prose only. `root` is spelled out at its default
    // so the seed doubles as the example of the prop. Old updated_ms keeps it
    // out of the Today recency grid.
    path: "Dashboards/Coding.md",
    stem: "Coding",
    title: "Coding",
    folder: "Dashboards",
    props: {
      type: "dashboard",
      dashboard: "coding",
      created: "2026-07-21",
      root: "~/Coding",
    },
    updated_ms: now - 9 * 86_400_000,
    excerpt: "Per-repo git health for ~/Coding — dirty, lanes, ahead/behind.",
    body: "Per-repo git health for every project under ~/Coding. Point `root:` at another folder to scan it instead. The dashboard shells out to git over IPC, so there is nothing to edit in this prose.\n",
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
export const fixedDay = (daysBack: number): string =>
  new Date(Date.parse(`${FIXED_BASE}T00:00:00Z`) - daysBack * 86_400_000)
    .toISOString()
    .slice(0, 10);

const pick = <T,>(arr: readonly T[], i: number): T => arr[i % arr.length];

let genSeq = 0;
/** generated notes share one aging sequence: all 2+ days old and distinct, so
    Today's seeded recency top-8 and every recency-sorted list stay put */
export const genUpdated = () => now - 2 * 86_400_000 - ++genSeq * 47 * 60_000;

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
