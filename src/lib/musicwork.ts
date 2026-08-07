// Music work index data for the `dashboard: music-work` renderer:
// pure pivots over the Work Index sheet's csv fence.
//
// The filesystem behind this sheet is category-first (MASTERING/<artist>/<job>,
// MIXING/<artist>/<job>, …), which answers "everything for Mira" and hides
// "what did I do in 2025". The tree can't be reorganized — the sync backend
// has no server-side move, so a physical reorg re-uploads terabytes — so the
// second axis is built here instead: the same rows, pivoted three ways.
//
// An external agent's scan script owns the sheet; the app never writes
// it. That makes every function here a pure read, and a malformed row a
// skipped row rather than an error — the sheet stays hand-inspectable.
// Pure TS, erasable syntax only — runs in the app and under `node --test`.

import { numberLocale } from "./numberLocale.ts";
import { readNoteTable } from "./notetable.ts";

export interface WorkJob {
  /** top-level tree bucket: MASTERING, MIXING, OWN WORK, … */
  category: string;
  /** artist/client folder inside the category */
  client: string;
  /** the job folder itself */
  job: string;
  /** 4-digit year the job is dated to (folder name beats file mtime) */
  year: string;
  /** ISO day of the newest file, or "" when the scanner found none */
  lastActive: string;
  files: number;
  sizeMb: number;
  /** non-empty when the scanner's dating signals disagree */
  flags: string;
  /** data-row index in the csv fence (header excluded) */
  idx: number;
}

/** Which axis the board pivots on. Year is the default: it's the view the
    folder tree can't give. */
export type WorkView = "year" | "artist" | "category";

export const WORK_VIEWS: WorkView[] = ["year", "artist", "category"];

export function isWorkView(v: string): v is WorkView {
  return v === "year" || v === "artist" || v === "category";
}

const YEAR_RE = /^\d{4}$/;

function num(raw: string): number {
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : 0;
}

/** Every well-formed row of the Work Index sheet, in the sheet's own order.
    A row is skipped when it has no job name or no 4-digit year — those are the
    two fields every view groups or labels by. Missing counts read as 0 rather
    than dropping the job: a 0-byte job is still work that happened.

    Column lookup is name-based and case-insensitive so column order in the
    sheet stays free — the scanner may grow columns without breaking the pane. */
export function parseWorkJobs(body: string): WorkJob[] {
  const table = readNoteTable(body);
  if (!table) return [];
  const ji = table.col("job");
  const yi = table.col("year");
  if (ji < 0 || yi < 0) return [];
  const ci = table.col("category");
  const cli = table.col("client");
  const li = table.col("last_active");
  const fi = table.col("files");
  const si = table.col("size_mb");
  const fli = table.col("flags");
  const out: WorkJob[] = [];
  for (let r = 0; r < table.rows.length; r++) {
    const cells = table.rows[r];
    const job = table.text(cells, ji);
    const year = table.text(cells, yi);
    if (job === "" || !YEAR_RE.test(year)) continue;
    out.push({
      category: table.text(cells, ci),
      client: table.text(cells, cli),
      job,
      year,
      lastActive: table.text(cells, li),
      files: num(table.text(cells, fi)),
      sizeMb: num(table.text(cells, si)),
      flags: table.text(cells, fli),
      idx: r,
    });
  }
  return out;
}

/** Substring match over client and job — the two things people search by
    ("mira", "ruiner"). Case-insensitive; an empty query matches everything. */
export function filterWorkJobs(jobs: WorkJob[], query: string): WorkJob[] {
  const q = query.trim().toLowerCase();
  if (q === "") return jobs;
  return jobs.filter(
    (j) => j.client.toLowerCase().includes(q) || j.job.toLowerCase().includes(q),
  );
}

export interface WorkSubGroup {
  /** the inner axis value — a category or a year, depending on the view */
  label: string;
  jobs: WorkJob[];
}

export interface WorkGroup {
  /** the outer axis value: year, client, or category */
  label: string;
  jobs: WorkJob[];
  /** the group's two anchors */
  count: number;
  sizeMb: number;
  subs: WorkSubGroup[];
}

// Jobs inside a sub-group read newest-first: last_active DESC, and a job the
// scanner couldn't date sinks to the bottom rather than sorting as "".
function byLastActiveDesc(a: WorkJob, b: WorkJob): number {
  if (a.lastActive === b.lastActive) return a.job.localeCompare(b.job);
  if (a.lastActive === "") return 1;
  if (b.lastActive === "") return -1;
  return a.lastActive < b.lastActive ? 1 : -1;
}

const yearDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
// A–Z that reads right for "Álvaro" next to "Alberto" and ignores case
const alpha = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

function collect(
  jobs: WorkJob[],
  outerOf: (j: WorkJob) => string,
  innerOf: (j: WorkJob) => string,
  outerCmp: (a: string, b: string) => number,
  innerCmp: (a: string, b: string) => number,
): WorkGroup[] {
  const byOuter = new Map<string, Map<string, WorkJob[]>>();
  for (const j of jobs) {
    const o = outerOf(j) || "—";
    const i = innerOf(j) || "—";
    let inner = byOuter.get(o);
    if (inner === undefined) {
      inner = new Map();
      byOuter.set(o, inner);
    }
    const bucket = inner.get(i);
    if (bucket === undefined) inner.set(i, [j]);
    else bucket.push(j);
  }
  return [...byOuter.keys()].sort(outerCmp).map((label) => {
    const inner = byOuter.get(label) as Map<string, WorkJob[]>;
    const subs = [...inner.keys()].sort(innerCmp).map((sl) => ({
      label: sl,
      jobs: [...(inner.get(sl) as WorkJob[])].sort(byLastActiveDesc),
    }));
    const all = subs.flatMap((s) => s.jobs);
    return {
      label,
      jobs: all,
      count: all.length,
      sizeMb: all.reduce((t, j) => t + j.sizeMb, 0),
      subs,
    };
  });
}

/** The board's rows for one view.

    - `year`: years descending, categories inside (A–Z) — the answer the
      folder tree can't give.
    - `artist`: clients A–Z, their years descending — the per-artist model
      the tree already has, kept because it's the one the user thinks in.
    - `category`: categories A–Z, years descending inside. */
export function groupWork(jobs: WorkJob[], view: WorkView): WorkGroup[] {
  if (view === "artist")
    return collect(jobs, (j) => j.client, (j) => j.year, alpha, yearDesc);
  if (view === "category")
    return collect(jobs, (j) => j.category, (j) => j.year, alpha, yearDesc);
  return collect(jobs, (j) => j.year, (j) => j.category, yearDesc, alpha);
}

/** Sizes span 0 MB to ~250 GB in the real index, so the unit moves with the
    number: one decimal in GB, whole MB below, and nothing at all for 0 — a
    zero is dust (design principle 1.1), not a value worth aligning. */
export function fmtSizeMb(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "—";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toLocaleString(numberLocale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} GB`;
}
