/* "New dashboard…" — the creatable kinds, and the note each one is born as.

   A dashboard is two frontmatter props (`type: dashboard`, `dashboard: <kind>`)
   over a body the kind reads, so creating one in-app needs no wizard: pick the
   kind, name the note, and the pane's own empty state says what to add next.
   This module owns the pick list and the starter note; the palette owns the
   two stages and App owns the write.

   The list mirrors BUILT_IN_KINDS minus the reserved names — `newdashboard`'s
   drift test asserts exactly that, so a kind added to the registry either gains
   an entry here or fails the gate rather than quietly staying uncreatable. The
   share-mirror fences match the registry's fences one for one: the public build
   offers the public kinds, and neither side can strip without the other.

   Pure TS, no DOM/node imports: runs in the app and under `node --test`. */

import { BUILT_IN_KINDS, RESERVED_KINDS } from "./kinds.ts";

export interface DashboardKindOption {
  /** the `dashboard:` value — also what the picker row is searched by */
  kind: string;
  /** one line of what the board does, shown as the row's hint */
  blurb: string;
  /** the note's title when the user names none */
  title: string;
  /** starter body: what this kind reads. The pane's empty state carries the
      "add a ```tile fence" style instruction, so the body never repeats it. */
  body: string;
}

/** The pick list, in the order the picker shows it: the kinds that work in any
    vault first, then the ones reading something outside it. */
export const NEW_DASHBOARD_KINDS: readonly DashboardKindOption[] = [
  {
    kind: "tasks",
    blurb: "every `type: task` note, late work first",
    title: "Tasks",
    body: "A working board over the `type: task` notes in this vault: overdue, due today, the hand-picked `now: true` list, then a section per `area:`.\n\nOptional frontmatter: `areas:` to allow-list the sections, `stale_days:` for when age raises a row.\n",
  },
  {
    kind: "hub",
    blurb: "a designed home page of live fences",
    title: "Home",
    body: "A home page laid out from ordinary markdown: `## ` headings become sections, a run of callouts becomes a card row, and ` ```view `, ` ```chart `, ` ```cards `, ` ```progress ` and ` ```calendar ` fences render live between them.\n",
  },
  {
    kind: "metrics",
    blurb: "stat cards over a sheet's summaries",
    title: "Metrics",
    body: "Stat cards over a sheet. Each card binds one named summary — `{{Holdings.total}}` — from a `cards:` list in this note's frontmatter.\n",
  },
  {
    kind: "charts",
    blurb: "bar and line charts over a database or sheet",
    title: "Charts",
    body: "Charts over a database or a sheet. Each ` ```chart ` fence in this body is one plot: `source:`, an `x:` and `y:`, and `kind: bar|line`.\n",
  },
  {
    kind: "yield-apr",
    blurb: "APR from an append-only snapshot log",
    title: "Yield",
    body: "A yield tracker that owns its data: the snapshots live in a csv fence in this body, and the form appends to it. The pane computes per-interval APR and the projected day, week, month and year.\n",
  },
  {
    kind: "food",
    blurb: "daily net kcal from a log sheet",
    title: "Food",
    body: "A daily net-kcal tracker. This note holds only config — the rows live in a log sheet the pane reads and appends to (`date,food,kcal,protein_g`), with a second sheet of stable kcal bases behind the autocomplete.\n",
  },
  {
    kind: "feed",
    blurb: "a curated newsfeed from an items sheet",
    title: "News",
    body: "A curated newsfeed, newest day first. This note holds only config — the items live in a sheet an external curator writes (`date,topic,title,source,url,blurb,why,fb`).\n",
  },
  {
    kind: "tax",
    blurb: "tax-year totals and what evidence is still owed",
    title: "Tax Readiness",
    body: "Read-only over two sheets: the year's aggregates, and the rows still missing evidence. The app writes to neither — the books stay canonical. Carries the head's Print action.\n",
  },
  {
    kind: "music-work",
    blurb: "the work index, pivoted by year, client and job",
    title: "Music Work",
    body: "A read-only board over a work-index sheet an external scanner writes (`category,client,job,year,last_active,files,size_mb,flags`), pivoted into the axes the folder tree cannot answer.\n",
  },
  {
    kind: "sync",
    blurb: "a window onto an external sync runner",
    title: "Sync",
    body: "A control surface over a sync system this app does not run: what each remote and leg last did, whether the schedule is loaded, recent errors, and buttons to sweep or pause. Every binding is this note's own frontmatter.\n",
  },
  {
    kind: "coding",
    blurb: "per-repo git health under one folder",
    title: "Coding",
    body: "One row per repository under the folder this note's `root:` names: branch, last commit, and chips for dirty files, unmerged branches, extra worktrees and ahead/behind.\n",
  },
  {
    kind: "jobs",
    blurb: "the scheduled jobs on this machine",
    title: "Jobs",
    body: "A window onto the machine's own scheduler (launchd, macOS only): one row per agent under the `prefixes:` this note lists, with schedule, last exit and freshness probes.\n",
  },
];

/** Kinds the picker offers, as a set — the drift test's left-hand side. */
export const NEW_DASHBOARD_KIND_IDS: ReadonlySet<string> = new Set(
  NEW_DASHBOARD_KINDS.map((o) => o.kind)
);

/** The kinds the picker is expected to cover: every built-in the app dispatches
    to. `charts` is reserved in the dispatch chain — no branch of its own — but
    it is a real `dashboard:` value with a real renderer behind it, so it is
    creatable like any other; nothing else in RESERVED_KINDS is. */
export function creatableKinds(): string[] {
  return [...BUILT_IN_KINDS].filter((k) => k === "charts" || !RESERVED_KINDS.has(k));
}

export function dashboardKindOption(kind: string): DashboardKindOption | undefined {
  return NEW_DASHBOARD_KINDS.find((o) => o.kind === kind);
}

/** The frontmatter a new dashboard is born with, beside `type: dashboard`.
    Just the kind: config props differ per kind and per vault, and guessing one
    wrong is worse than an empty state that says what to add. */
export function newDashboardProps(kind: string): [string, string][] {
  return [["dashboard", kind]];
}
