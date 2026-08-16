/* The in-app release history.
 *
 * This is a code module on purpose: the changelog is a property of the build,
 * not a note in the vault. Nothing here is written to, indexed by, or
 * reachable from search, lists, or databases — the pane renders this array and
 * calls no vault IPC at all.
 *
 * Entries are written in user language: what a person sees or gains, not which
 * module changed. Newest first; the first entry always matches the version in
 * package.json (asserted in changelog.test.ts).
 *
 * STRUCTURE. Each item carries a kind — new / improved / fixed — and
 * the surfaces group by it, so a reader can skim features without wading
 * through fixes. A release's flagship (usually the item its title alludes to)
 * is flagged `headline: true` and leads the release at full prominence; at most
 * two headlines per release (asserted in changelog.test.ts), and small patch
 * releases need none.
 *
 * HOW RELEASES UPDATE THIS. This array is the single source of truth
 * for the release history — the repo-root CHANGELOG.md is GENERATED from it and
 * any hand-edit there is lost on the next run. When you bump the version:
 *
 *   1. add the new release entry at the top of this array;
 *   2. bump package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml
 *      to the same version;
 *   3. run `node scripts/gen-changelog.ts` and commit the rewritten
 *      CHANGELOG.md alongside the bump.
 *
 * `npm test` fails when CHANGELOG.md is stale or those four versions disagree
 * (scripts/gen-changelog.test.ts), so a forgotten step is caught in CI, not by
 * a beta tester reading a changelog that stops three months short.
 */

export type ChangelogKind = "new" | "improved" | "fixed";

export interface ChangelogItem {
  text: string;
  kind?: ChangelogKind;
  /** the release's flagship — rendered first and larger, outside the groups */
  headline?: boolean;
  /** A machine-local surface not present in every install. Excluded
      from the generated CHANGELOG.md and release notes; the in-app pane shows
      it only on machines that actually have the surface. */
  private?: true;
}

export interface ChangelogRelease {
  version: string;
  /** ISO date of the version bump commit */
  date: string;
  /** one-line release name */
  title: string;
  items: ChangelogItem[];
}

/** Group order and labels shared by the pane and the Markdown render. */
export const KIND_ORDER: ChangelogKind[] = ["new", "improved", "fixed"];
export const KIND_LABEL: Record<ChangelogKind, string> = {
  new: "New",
  improved: "Improved",
  fixed: "Fixed",
};

export interface GroupedRelease {
  headlines: ChangelogItem[];
  groups: { kind: ChangelogKind; items: ChangelogItem[] }[];
}

/**
 * The one grouping both surfaces render from: headlines first (array order),
 * then the remaining items bucketed new → improved → fixed. Within a bucket
 * the array order is kept — it is the author's ranking. An item without a
 * kind sorts as "improved", matching the pane's historical default dot.
 */
export function groupRelease(release: ChangelogRelease): GroupedRelease {
  const headlines = release.items.filter((item) => item.headline);
  const rest = release.items.filter((item) => !item.headline);
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: rest.filter((item) => (item.kind ?? "improved") === kind),
  })).filter((group) => group.items.length > 0);
  return { headlines, groups };
}

/** A colon later than this is sentence punctuation, not an authored label. */
const LEAD_MAX = 60;

/**
 * Entries authored as "Lead phrase: detail" split here so the pane can render
 * the lead a step up — a release then scans as short bold phrases instead of a
 * wall of even sentences. Presentation-only: the generated
 * CHANGELOG.md keeps the raw text. No early colon → null, render plain.
 */
export function splitLead(text: string): { lead: string; rest: string } | null {
  const at = text.indexOf(": ");
  if (at <= 0 || at > LEAD_MAX) return null;
  return { lead: text.slice(0, at), rest: text.slice(at + 2) };
}

export const CHANGELOG: ChangelogRelease[] = [
  {
    version: "0.24.0",
    date: "2026-08-11",
    title: "Search reads your properties, and bulk edits sign their work",
    items: [
      {
        text: "Search reaches into properties: plain-text search now answers from property values — text, numbers, even checkboxes — a property-only hit shows the value that matched and says so, and the \u2318K palette marks exactly what matched, accents and all, in the same match language as full search.",
        kind: "new",
        headline: true,
      },
      {
        text: "Bulk sweeps sign their work: a sweep that touches many notes commits under its own run summary — receipts and time travel name the run instead of blaming each note on an anonymous edit — and an outside tool writing through the agent door is credited as itself.",
        kind: "new",
        headline: true,
      },
      {
        text: "Changing a property's type warns before it costs you: the schema editor names what a retype will destroy — select options and their colors, a number's format, the risk a checkbox conversion overwrites values — before you press Save.",
        kind: "new",
      },
      {
        text: "Installing an update shows its download progressing — a slow fetch is no longer a click that looks dead.",
        kind: "improved",
      },
      {
        text: "Filing pickers rank by recency: the databases you touched last come first, instead of the biggest ones — and menu rows that carry an icon always draw it.",
        kind: "improved",
      },
      {
        text: "Scrolling got soft edges everywhere: board columns, list and gallery views and Today's day scroller fade at the scroll stops instead of clipping mid-glyph, keyboard walks — the \u2318K palette's included — land rows clear of sticky headers, footers and the fades, the palette stopped painting a duplicate section header on cold open, and the Music Work board uses its full pane width.",
        kind: "improved",
      },
      {
        text: "Calendar craft: month chips answer hover, an expanded day cell fades like everything else, the week view's opening scroll clears the first hour label, and hub head counts stopped over-promising.",
        kind: "improved",
      },
      {
        text: "Money tells the truth: footer sums say how many text cells they skipped, fractional currencies show both cents, the yen keeps its zero-decimal precision, an all-text numeric column keeps its footer marker — and a footer counts \"1 row\", not \"1 rows\".",
        kind: "fixed",
      },
      {
        text: "History answers the question you asked: fact keys match case-insensitively in both tenses — history queries, receipts and live reads now agree — and a bulk sweep records only the notes it actually swept.",
        kind: "fixed",
      },
      {
        text: "Fixes with names: the + property chip keeps a bare-key draft — Enter turns it into a real key instead of eating it; backlinks refresh while you watch, stop re-fetching on your own autosaves, and their header counts right; palette actions, failed copies and schema-save refusals surface as toasts instead of console lines; rollups survive being configured on a mounted database; the hidden import stamp neither poses as a property row nor answers search; and an empty gallery result says so across the pane, not inside one cell.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.23.0",
    date: "2026-08-08",
    title: "Every fact shows its receipts, and agents get a proper front door",
    items: [
      {
        text: "Receipts: every property remembers who set it. Hover a chip and a small clock appears — click it for the value's history, each change as value, author and time (\"You\", \"Claude (via MCP)\", an outside tool by name), newest first. Click a row to jump time travel to that exact moment; the footer links the note's full history and always says how far back the record goes.",
        kind: "new",
        headline: true,
      },
      {
        text: "Agents get a front door: a built-in MCP server — with a headless CLI twin — lets Claude and other assistants read and write the vault through the app's own rules, never behind its back. You grant each client its folders in Settings and revoke them there; a client without a grant cannot connect at all. The door's manual ships with the public repo.",
        kind: "new",
        headline: true,
      },
      {
        text: "The calendar gains a day view — one day, laid out by hour, alongside month and week — and events stretch: drag an event's edge to set how long it runs, or set an end time in the peek.",
        kind: "new",
      },
      {
        text: "Today grew into its job: notes can be picked into the day from other lists, dateless notes can be picked at all, and the whole pane drives from the keyboard.",
        kind: "new",
      },
      {
        text: "Notes grow tags: #hashtags typed in prose and a tags: property both count, and tag folders in the sidebar collect every note carrying theirs — saved queries you never have to write.",
        kind: "new",
      },
      {
        text: "Prose can compute: an inline code span opening with = renders its answer in place (`= Masters.count` reads as a number inside the sentence), and numbers understand units — columns carry one, sums and averages respect it, and 25 USD in EUR is an expression, not a search.",
        kind: "new",
      },
      {
        text: "A folder of audio plays as a playlist, and a mini-player keeps it going while you work anywhere else in the app.",
        kind: "new",
      },
      {
        text: "Reach, in both directions: substrate:// links open the app from anywhere onto a note or a prefilled capture box; search sees into mounted folders; sheets gain a totals row, filtered sums, and column notifications that open the sheet at the row that fired; property kinds can ship as bundles inside the vault; dashboards compose on a grid; hub notes render calendar and timeline fences, a month grid and a date-axis arc drawn live from the data they query; a settings dial picks the one locale every date renders in; and a glow dial with curated accent tones joins Settings.",
        kind: "new",
      },
      {
        text: "The design refresh: the big empty states draw purpose-made hero marks in the app's lit-slab language, onboarding leads with the product mark, hover copy on the main surfaces moved into instant styled tooltips, the front-door empties offer their one clear action as a real button, live database embeds on hub pages edit like the editor's own tables, and back and undo gained mouse paths.",
        kind: "improved",
      },
      {
        text: "Fixes with names: dashboards paint from the snapshot they already hold instead of flashing blank; a failed bulk write says which notes failed and why; property edits from the palette report their errors; editing a chip shows the new value immediately instead of snapping back; and mounted folders behave on case-insensitive disks.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.22.0",
    date: "2026-08-03",
    title: "Time travel for the whole vault, and a calendar that follows your feeds",
    items: [
      {
        text: "Time travel: scrub the whole vault back to any past snapshot and read it as it was — notes, dashboards and sheets all render from that moment, past mode is strictly read-only with a clear cue, and restoring takes a safety snapshot first so the present is never lost.",
        kind: "new",
        headline: true,
      },
      {
        text: "The calendar can subscribe to external calendar feeds (ICS): subscribed events appear alongside your vault's own dates, day cells count everything they show and say when a day is busy, and feeds are fetched carefully — capped, contained, and every outbound fetch named in the docs.",
        kind: "new",
        headline: true,
      },
      {
        text: "Remind me before it's due: date properties take a lead time, and the reminder fires that many days ahead of the day-of alert.",
        kind: "new",
      },
      {
        text: "Charts split into series with by: — one measure pivoted by a second column — and hovering or keyboard-focusing any point answers with an exact-value tooltip card.",
        kind: "new",
      },
      {
        text: "Sheet summaries grew up: formula lines group by blank lines, the summary bar ranks its chips, and one shared error reports once instead of cascading down every dependent line.",
        kind: "new",
      },
      {
        text: "Two designed PDF exports join the generic print: a note one-sheet (artwork, title block, quiet fact rows) and a clean database table sheet.",
        kind: "new",
      },
      {
        text: "A fresh vault seeds a reading + travel showcase — a small realistic library and trip log — instead of the old demo theme.",
        kind: "improved",
      },
      {
        text: "The app stopped being picky about typed input: German-style decimals (1,5) are understood in sheet grids, hand-edited log rows, settings and the terminal-size box, and frontmatter and Settings.md keys are no longer case-sensitive — queries, filters, rollups, charts, dashboards and notification schedules read Status and status alike.",
        kind: "fixed",
      },
      {
        text: "Edge-case markdown now survives everywhere it renders: link URLs containing parentheses stay intact, notes saved with Windows line endings show their views and charts, and numbered lists that follow bullet lists keep their numbering in print.",
        kind: "fixed",
      },
      {
        text: "Notification times accept single-digit hours (9:00), and a hand-edited out-of-range lead time can no longer silently stop the reminder scheduler.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.21.0",
    date: "2026-08-03",
    title: "Send a note as a link, and a tasks board that knows what's urgent",
    items: [
      {
        text: "Send as link: any note becomes an encrypted, self-expiring link you can hand to anyone — no account, no reader app. The relay only ever stores ciphertext (the key rides in the link fragment and never leaves your side), links can burn on first read or expire after 1–30 days, and you can point the app at your own self-hosted relay.",
        kind: "new",
        headline: true,
      },
      {
        text: "The tasks board leads with urgency now: overdue, today and this-week buckets come first, checkboxes are visible on every row, due dates and priority edit inline, quick-add lives at the top, and snoozed tasks park in their own section until their wake day.",
        kind: "new",
        headline: true,
      },
      {
        text: "Hub dashboards render view fences as live database tables — the same editable views notes get, now on your home hub.",
        kind: "new",
      },
      {
        text: "A public dashboard cookbook ships with the repo: eight copy-paste recipes for boards, feeds and trackers, with a section on the landing page to browse them.",
        kind: "new",
      },
      {
        text: "The built-in terminal grew up: drag it to the size you want, dock it at the bottom or the right edge, and give it its own font from Settings.",
        kind: "improved",
      },
      {
        text: "This What's-new pane is easier to scan — group labels read as section rules and only headlines carry dots.",
        kind: "improved",
      },
      {
        text: "Seeded vaults conceal the app's own files (Settings.md, agent instructions) from your notes list by default, and the seeded AGENTS.md now points agents at the repo docs and covers tasks.",
        kind: "improved",
      },
      {
        text: "An update package could carry stray macOS metadata files that made some installs fail with \"Update failed\" — release packaging now strips and gates against them.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.20.1",
    date: "2026-08-02",
    title: "The updater's first flight",
    items: [
      {
        text: "This release shipped through the new update channel. If a toast offered it and a restart brought you here, the updater has now proven itself end to end — signed artifact, verified signature, background install.",
        kind: "new",
        headline: true,
      },
      {
        text: "Fresh downloads get this version directly; everyone on 0.20.0 gets the toast.",
        kind: "improved",
      },
    ],
  },
  {
    version: "0.20.0",
    date: "2026-08-02",
    title: "It updates itself now",
    items: [
      {
        text: "Substrate keeps itself current: when a new version ships, a toast offers it, one click installs in the background, and a restart finishes the job. This is the last version you download by hand.",
        kind: "new",
        headline: true,
      },
      {
        text: "Database views inside notes are editable now — click a cell to change it, tick checkboxes in place, and add rows with + New, all without leaving the note.",
        kind: "new",
        headline: true,
      },
      {
        text: "Type /view to drop a database view into a note: a picker lists your databases, and choosing one builds the view and steps the cursor past it.",
        kind: "new",
      },
      {
        text: "Setting up a new vault can wire in your AI agent: the welcome flow asks which agent CLI you use and puts it one shortcut away in the built-in terminal.",
        kind: "new",
      },
      {
        text: "Agent instruction files (AGENTS.md, CLAUDE.md) stay out of your notes list — the app conceals them unless a settings toggle says otherwise, and the Welcome note now gives a fuller tour.",
        kind: "improved",
      },
      {
        text: "The command palette understands synonyms — create, make and add all find the New commands.",
        kind: "improved",
      },
      {
        text: "This changelog reads better: each release leads with its flagship, and the rest is grouped into New, Improved and Fixed.",
        kind: "improved",
      },
    ],
  },
  {
    version: "0.19.0",
    date: "2026-08-02",
    title: "A board that knows what's next",
    items: [
      {
        text: "The Tasks board knows what's next: a Now/Later split so today's list stays short, check-off straight from the board, and snooze to push a task out of sight until it matters.",
        kind: "new",
        headline: true,
      },
      {
        text: "Calendar peek opens beside the entry instead of covering it, and the click that dismisses a peek no longer starts composing a new entry underneath.",
        kind: "fixed",
      },
      {
        text: "First-run seed vault got a real flagship: a Label Overview dashboard (catalogue, releases, roster) replaces the abstract Yield APR sample.",
        kind: "improved",
      },
      {
        text: "Vault writes hardened end to end: exports, asset imports and template deletes are atomic (no half-written files on a crash), deleted templates route through the trash, and restoring an old version warns when it would bury a newer external edit.",
        kind: "fixed",
      },
      {
        text: "Security pass: credential stores are denied from asset scope, URLs are logged without embedded credentials, terminal palette quick actions respect the PTY trust check, and importers fail closed on a bad vault target.",
        kind: "fixed",
      },
      {
        text: "Notifications stay monotonic across the spring DST gap, and doctor's folder-mapping check understands ~ paths.",
        kind: "fixed",
      },
      {
        text: "The project is public now: AGPL-3.0 licensed, with contribution and security-reporting guidelines — and release builds carry no trace of the machine that built them.",
        kind: "new",
      },
    ],
  },
  {
    version: "0.18.0",
    date: "2026-08-02",
    title: "Sheets learn to compute",
    items: [
      {
        text: "Sheet formulas grew a real vocabulary: LOOKUP across sheets (and per row), SUMIF/COUNTIF with multiple criteria, wildcards and comparisons, SUMPRODUCT for weighted averages, LAST(), date arithmetic with TODAY(), and identifiers in any language.",
        kind: "new",
        headline: true,
      },
      {
        text: "Databases can roll up values from related databases — a rollup column derives counts, sums and lists from linked rows, straight from Notion imports too.",
        kind: "new",
        headline: true,
      },
      {
        text: "A new Attention dashboard surfaces the tasks that need a look.",
        kind: "new",
      },
      {
        text: "Map a folder: point the app at any folder of notes and it becomes a database, from the sidebar or the palette.",
        kind: "new",
      },
      {
        text: "The sidebar got a clarity pass — cleaner grouping, dashboard groups with their own menus and remembered order, and app-wide zoom. Calendar months render Notion-style lines with identity bars and done-states, and week blocks are as tall as their actual duration.",
        kind: "improved",
      },
      {
        text: "Food tracking: your weight curve overlays the 14-day strip, kcal expressions compute portions inline (a per-100g basis plus math), and typing negative kcal logs exercise directly.",
        kind: "improved",
      },
      {
        text: "Dashboards can print — agenda, food, and the other portable kinds produce a clean paper layout.",
        kind: "new",
      },
      {
        text: "Renaming a note no longer risks losing keystrokes typed mid-rename — the editor relabels in place instead of reloading, and carries in-flight text across a title change. Multi-file paste imports every file, and a dropped asset lands at the drop point, not the live cursor.",
        kind: "fixed",
      },
      {
        text: "Notifications got honest: recurring deadlines fire on each occurrence day, snoozes survive past midnight, nothing late-fires for a future day, and completed or calendar-hidden notes stay quiet.",
        kind: "fixed",
      },
      {
        text: "Number cells read German-style decimal commas, and audio files in database rows gained a play button.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.17.0",
    date: "2026-07-30",
    title: "Drag and drop, for real this time",
    items: [
      {
        text: "Dragging finally works in the app itself — reorder the sidebar, drop notes into folders, move dashboards, drag board cards. It always worked in tests and never on the Mac; the desktop shell was swallowing every drag before the app could see it.",
        kind: "fixed",
        headline: true,
      },
      {
        text: "One straight icon column down the whole sidebar — dashboards, databases and folders line up instead of each section picking its own indent.",
        kind: "fixed",
      },
      {
        text: "Dashboards can live in your folders: drop one on any folder in the tree and it shows up right there, still opening as a dashboard.",
        kind: "new",
      },
    ],
  },
  {
    version: "0.16.0",
    date: "2026-07-30",
    title: "Dates get a second half",
    items: [
      {
        text: "A date can now be a range — pick a start and an end in the same picker, see it as a span across the calendar, and sort and filter by when it actually runs. Imports from Notion keep their end dates too.",
        kind: "new",
        headline: true,
      },
      {
        text: "Select text in a note for a floating menu: extract the selection into its own linked note, turn it into a heading or list, or copy it as Markdown.",
        kind: "new",
      },
      {
        text: "The sync dashboard reads as sentences — each backup leg states its finding in plain words, with hairline rows and ticks that stay put at any window width.",
        kind: "improved",
      },
      {
        text: "Background git maintenance could repack a vault's history store; sidebar pins under a dashboard folder rendered twice; extracted-note titles could carry characters the engine refuses.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.15.0",
    date: "2026-07-25",
    title: "Dashboards become instruments",
    items: [
      {
        text: "Dashboards share one design language — a single header, mono micro-labels, hairline structure, and round state dots instead of boxed cards.",
        kind: "improved",
        headline: true,
      },
      {
        text: "Notes with broken frontmatter now say so in the app and offer a repair, instead of quietly refusing property edits.",
        kind: "new",
      },
      {
        text: "Drag a file into a note while holding Shift to link it in place rather than copying it into the vault; a hint pill teaches the gesture.",
        kind: "new",
      },
      {
        text: "A contextual info view explains whatever the pointer is over, docked in the lower-left.",
        kind: "new",
      },
      {
        text: "Table cells can be edited in place, columns resized by dragging their header, and text wrapped per column.",
        kind: "new",
      },
      {
        text: "A terminal HUD (⌘⇧T), a settings sheet (⌘,), and palette quick actions.",
        kind: "new",
      },
      {
        text: "\"Remove from sidebar\" un-homes a database from its folder row, and root folders can be reordered.",
        kind: "new",
      },
      {
        text: "The menu bar gets a proper monochrome tray icon, and vault writes survive power loss.",
        kind: "fixed",
      },
      {
        text: "Text typed straight into a new note is no longer cut mid-word into its title, and keystrokes aimed at the note list are no longer swallowed by the editor — the brief auto-focus delay after a note opens now yields the moment you type or click.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.14.0",
    date: "2026-07-23",
    title: "Sheets and sidebar tidy-up",
    items: [
      {
        text: "Sheet rows and columns can be deleted and reordered from the context menu.",
        kind: "new",
      },
      {
        text: "The sidebar de-nests saved views, wears curated folder and dashboard icons, and drops the Sketchpad entry — Notes now lists only untyped, unfiled notes.",
        kind: "improved",
      },
      {
        text: "The coding dashboard aligns lane age, behind-count, and commit age to shared rails.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.13.0",
    date: "2026-07-23",
    title: "New sheet, collapsible sidebar",
    items: [
      { text: "A \"New sheet\" command in the palette.", kind: "new" },
      { text: "The sidebar collapses to a slim rail and back.", kind: "new" },
      {
        text: "A shareable public mirror of the app, with a dashboards guide and an example vault.",
        kind: "new",
      },
    ],
  },
  {
    version: "0.12.1",
    date: "2026-07-23",
    title: "Context menus everywhere",
    items: [
      {
        text: "Right-click note rows on Today, Search, and Trash; calendar agenda rows gain a menu with Mark done.",
        kind: "new",
      },
      {
        text: "Currency conversion is cached globally and never written into your notes as a property.",
        kind: "fixed",
      },
      {
        text: "Sidebar counts tuck after the label when a shortcut shares the row.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.12.0",
    date: "2026-07-23",
    title: "Smarter calorie logging",
    items: [
      {
        text: "Quick-add remembers what you eat — autocomplete with a quantity grammar, so \"200g oats\" logs itself.",
        kind: "new",
        headline: true,
      },
      {
        text: "The calorie surface shows distance to your goal and a week-vs-goal figure, and exercise can be logged the same way.",
        kind: "new",
      },
    ],
  },
  {
    version: "0.11.1",
    date: "2026-07-23",
    title: "Wider dashboards",
    items: [
      {
        text: "Dashboards use the full content width — grids stopped truncating on normal windows.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.11.0",
    date: "2026-07-23",
    title: "Vault sync, phones, and food",
    items: [
      {
        text: "Vault sync: push and pull your vault against your own server over authenticated HTTPS, with the token held in the OS keychain.",
        kind: "new",
        headline: true,
      },
      {
        text: "Substrate runs on a phone — single-pane navigation, readable calendar days, and layouts that stack instead of squeezing.",
        kind: "new",
        headline: true,
      },
      {
        text: "A calorie surface: log meals against a daily band, with undo, a day strip, and a seven-day average.",
        kind: "new",
      },
      {
        text: "A coding dashboard listing your repositories sorted by what needs attention.",
        kind: "new",
      },
      {
        text: "Every control is reachable by keyboard — sidebar, rows, calendar, pickers, search results, and backlinks.",
        kind: "improved",
      },
      {
        text: "Databases remember per-database column visibility and sort order.",
        kind: "new",
      },
      {
        text: "The yield board gains a two-click Claim with full undo history.",
        kind: "new",
      },
    ],
  },
  {
    version: "0.10.6",
    date: "2026-07-21",
    title: "Density and honesty pass",
    items: [
      {
        text: "Gallery covers stay square at any density, and the placeholder recedes so the title leads the card.",
        kind: "fixed",
      },
      {
        text: "Journal ghost days say they are writable instead of looking empty and dead.",
        kind: "improved",
      },
      {
        text: "Line charts space points by real time — irregular snapshots stopped lying about their shape.",
        kind: "fixed",
      },
      {
        text: "⌘/ opens the shortcuts overlay in the editor without toggling comments.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.10.5",
    date: "2026-07-20",
    title: "Stability and polish under the hood",
    items: [{ text: "Alignment fixes across the status pane.", kind: "fixed" }],
  },
  {
    version: "0.10.4",
    date: "2026-07-20",
    title: "Stability and polish under the hood",
    items: [{ text: "Quota lines show when each window resets.", kind: "improved" }],
  },
  {
    version: "0.10.3",
    date: "2026-07-20",
    title: "Stability and polish under the hood",
    items: [{ text: "Usage bars fill by real usage, not an estimate.", kind: "fixed" }],
  },
  {
    version: "0.10.2",
    date: "2026-07-20",
    title: "Stability and polish under the hood",
    items: [
      { text: "Real-vault polish round — aligned summary columns, compact chart numbers.", kind: "fixed" },
    ],
  },
  {
    version: "0.10.1",
    date: "2026-07-20",
    title: "Visual polish across every surface",
    items: [
      {
        text: "Charts get flat fills, status-coloured bars, and a disciplined axis.",
        kind: "improved",
      },
      {
        text: "Tables gain text hierarchy — quiet uppercase headers, dates a step dimmer.",
        kind: "improved",
      },
      {
        text: "A hairline seam separates database blocks from loose notes in lists.",
        kind: "improved",
      },
      {
        text: "The window opens maximized instead of at a fixed size, and a failed weekly verify reads as the alert it is.",
        kind: "fixed",
      },
      {
        text: "The calendar peek no longer dismisses itself the moment it opens.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.10.0",
    date: "2026-07-20",
    title: "Downloads, peeks, and view tabs",
    items: [
      {
        text: "A music download surface: queue albums, watch the transfer tail, cancel mid-run.",
        kind: "new",
        headline: true,
      },
      {
        text: "Click a calendar entry to peek at it — edit title, date, time, and status in place.",
        kind: "new",
      },
      {
        text: "Databases get a view tab bar and one consolidated toolbar.",
        kind: "new",
      },
      {
        text: "Note property rows follow the schema's order, with aligned labels.",
        kind: "improved",
      },
      {
        text: "Large databases paint lazily — 1400-row tables no longer stall the pane.",
        kind: "improved",
      },
      {
        text: "Select properties sort by their schema option order, not alphabetically.",
        kind: "fixed",
      },
      {
        text: "A wider reading measure and more air in cells.",
        kind: "improved",
      },
    ],
  },
  {
    version: "0.9.0",
    date: "2026-07-20",
    title: "Today, rebuilt",
    items: [
      {
        text: "Today is a day-agenda decision surface — what is scheduled, due, overdue, and picked, in one place.",
        kind: "new",
        headline: true,
      },
      {
        text: "The sync dashboard became a control surface: start, inspect, and hold your backup jobs from the app.",
        kind: "new",
      },
      {
        text: "Sync refuses to start a run while a sweep is already in flight.",
        kind: "fixed",
      },
      {
        text: "Restoring an old version of a note now lands in the open editor instead of being overwritten.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.8.1",
    date: "2026-07-19",
    title: "Sidebar homes and blank panes",
    items: [
      {
        text: "Saved views nest under the database they belong to.",
        kind: "improved",
      },
      {
        text: "Database panes stopped going blank on reserved schema keys.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.8.0",
    date: "2026-07-19",
    title: "Bulk edits, time of day, and the week view",
    items: [
      {
        text: "Select many table rows at once and set a property, or trash them, in one action.",
        kind: "new",
        headline: true,
      },
      {
        text: "Dates carry an optional time of day, preserved across calendar, menus, and every display surface.",
        kind: "new",
      },
      {
        text: "The week view renders day columns as cards.",
        kind: "new",
      },
      {
        text: "Wikilink autocomplete on [[, and find-in-note on ⌘F.",
        kind: "new",
      },
      {
        text: "Import a CSV as a database from inside the app; attach any file type as a chip.",
        kind: "new",
      },
      {
        text: "A filter that dead-ends at zero rows now says why, and search hits open in their home context with Esc returning to results.",
        kind: "improved",
      },
      {
        text: "Trashing, moving, and renaming notes flush pending edits first, and a toast offers Undo.",
        kind: "fixed",
      },
      {
        text: "Numbers, money, percentages, and file sizes all render in German formatting.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.7.0",
    date: "2026-07-18",
    title: "Live vault, faster open",
    items: [
      {
        text: "Embedded views rebuild themselves when the vault changes on disk.",
        kind: "fixed",
      },
      {
        text: "Today and Calendar re-render when the day rolls over at midnight.",
        kind: "fixed",
      },
      {
        text: "Switch saved views from inside the pane, and a freshly saved view reveals its pin.",
        kind: "new",
      },
      {
        text: "Audio notes open faster — waveform decoding is deferred off the first render.",
        kind: "improved",
      },
      {
        text: "Renaming a note no longer rewrites links inside embedded assets.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.6.1",
    date: "2026-07-18",
    title: "Charts stand up, menus calm down",
    items: [
      {
        text: "Bar charts stand on a baseline and stop skipping empty time buckets.",
        kind: "fixed",
      },
      {
        text: "Menus group destructive actions behind a hairline.",
        kind: "improved",
      },
      {
        text: "Markdown tables and view embeds speak the same card language, with a quiet open affordance.",
        kind: "improved",
      },
      {
        text: "The sidebar yields width in narrow windows.",
        kind: "fixed",
      },
    ],
  },
  /* 0.3.0 through 0.6.0 shipped before this array existed and were never
     written up in user language; CHANGELOG.md never covered them either, so
     there is nothing to recover. The two founding releases below are carried
     over verbatim from the hand-written CHANGELOG.md. */
  {
    version: "0.2.0",
    date: "2026-07-17",
    title: "Views, schemas, and sheets",
    items: [
      {
        text: "Added saved views, richer schemas and select fields, and spreadsheet-style sheets.",
        kind: "new",
      },
      {
        text: "Upgraded the editor and command palette, including faster capture workflows.",
        kind: "improved",
      },
      { text: "Added note history and trash recovery.", kind: "new" },
      {
        text: "Fixed drag interactions and expanded the app's keyboard-driven controls.",
        kind: "fixed",
      },
    ],
  },
  {
    version: "0.1.0",
    date: "2026-07-17",
    title: "The local-first vault",
    items: [
      {
        text: "Established the local-first Markdown vault, SQLite search, backlinks, and file watcher.",
        kind: "new",
      },
      {
        text: "Shipped the founding three-pane interface with editing and command palette basics.",
        kind: "new",
      },
    ],
  },
];
