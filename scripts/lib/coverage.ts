// Ranking and reporting for the coverage pass (`npm run coverage`).
//
// WHY THIS EXISTS. The suite's own coverage output is a per-file table in
// source order, which answers "how covered is agefill.ts" and not the question
// worth asking — which parts of the tree no test has ever executed. This turns
// the run's lcov into a ranked least-covered view, and it is REPORT-ONLY by
// construction: nothing here returns a pass/fail, so no percentage can ever
// fail a build. A floor, if one is ever wanted, is a separate decision.
//
// THE GAP THIS CLOSES. lcov names only the files the run actually loaded, so
// the files worth knowing about — the ones no test has ever imported — are
// exactly the ones missing from it, and a report built from lcov alone would
// describe the tested tree as if it were the tree. (Node can synthesise those
// rows with `--test-coverage-include-all`, but its walk reaches `.ts` and never
// `.tsx`, i.e. it misses the components, which is most of the surface in
// question.) So the lcov rows are unioned with an inventory read off the tree:
// a source file with no lcov record is a file no test loaded, and it is listed
// as such rather than silently omitted.
//
// The two halves stay comparable on purpose: the suite's lcov reports a file's
// PHYSICAL line count as its total (verified against the tree — every `LF`
// record equals the file's line count), so a never-loaded file is counted the
// same way rather than by some stricter notion of an executable line. One
// ruler, so the ranking means one thing.

/** One file's coverage, from lcov or synthesised for a file no test loaded. */
export type FileCoverage = {
  path: string;
  lines: number;
  covered: number;
  functions: number;
  functionsCovered: number;
  /** False when no test imported the file, so every count is a floor of zero. */
  loaded: boolean;
};

/** One directory's roll-up, the shape the headline numbers are read from. */
export type AreaSummary = {
  area: string;
  files: number;
  neverLoaded: number;
  lines: number;
  covered: number;
};

/**
 * The suite's own total duration out of its spec log — the LAST `duration_ms`
 * the reporter printed, which is the run summary (per-test lines print the
 * same key earlier). This exists because the wall clock around the run is not
 * the run: the runner re-execs under the machine-wide gates lock, so wall
 * time includes however long the lock was contended, and publishing that as
 * the instrumented cost overstates it by whatever the queue was doing.
 */
export function suiteDurationMs(specLog: string): number | undefined {
  let last: number | undefined;
  for (const match of specLog.matchAll(/duration_ms:?[ \t]+([\d.]+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) last = value;
  }
  return last;
}

/** Percent covered, with an empty file reported as fully covered rather than NaN. */
export function percent(covered: number, total: number): number {
  if (total <= 0) return 100;
  return (covered / total) * 100;
}

/**
 * Read the `SF`/`LF`/`LH`/`FNF`/`FNH` records out of an lcov file.
 *
 * Only those five matter here — the per-line `DA` and per-branch `BRDA` detail
 * is what a viewer renders, and this produces a ranking, not a viewer. A record
 * missing its totals is kept with zeroes rather than dropped: a file the run
 * saw is a file the report should name.
 */
export function parseLcov(text: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: FileCoverage | undefined;
  /* A covered count can outlive its total when malformed input drops one half
     of the pair (an `LF:` with no value while its `LH:3` lands). Clamping at
     push time keeps the invariant covered ≤ lines whatever order or subset of
     the pair survived — a phantom 100% row would rank below every real gap
     and inflate the headline totals. */
  const push = (record: FileCoverage) => {
    record.covered = Math.min(record.covered, record.lines);
    record.functionsCovered = Math.min(record.functionsCovered, record.functions);
    files.push(record);
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      /* A new record without an end_of_record for the last one is malformed,
         but the file it named is still a file the run saw — pushing here means
         corrupt input costs a record's terminator, never a whole row. */
      if (current !== undefined) push(current);
      current = { path: line.slice(3), lines: 0, covered: 0, functions: 0, functionsCovered: 0, loaded: true };
      continue;
    }
    if (current === undefined) continue;
    if (line === "end_of_record") {
      push(current);
      current = undefined;
      continue;
    }
    const split = line.indexOf(":");
    if (split < 0) continue;
    const raw = line.slice(split + 1);
    /* Number("") is 0, so `LF:` with no value would read as a zero-line
       file. A count is a whole number or it is not a count — and whichever
       half of a pair survives the drop, the push-time clamp keeps covered
       from ever exceeding its total. */
    const value = Number(raw);
    if (raw === "" || !Number.isInteger(value) || value < 0) continue;
    switch (line.slice(0, split)) {
      case "LF":
        current.lines = value;
        break;
      case "LH":
        current.covered = value;
        break;
      case "FNF":
        current.functions = value;
        break;
      case "FNH":
        current.functionsCovered = value;
        break;
    }
  }
  /* A truncated lcov (a killed run) leaves the last record unterminated —
     keep it rather than lose a file to a missing final line. */
  if (current !== undefined) files.push(current);
  /* `--test-coverage-include-all` synthesises a record for a `.ts` the suite
     never imported: present, every line at zero. Left alone those rows would
     read as "measured and uncovered" while an unimported `.tsx` — absent from
     lcov entirely — reads as "never loaded", so the same fact would be told
     two ways depending on the extension, and the report's own never-loaded
     count would name only half of them. Importing a module executes at least
     its top-level lines, so nothing covered in a non-empty file means nothing
     loaded it. */
  return files.map((file) => (file.lines > 0 && file.covered === 0 ? { ...file, loaded: false } : file));
}

/**
 * Lines in a file, counted the way the suite's lcov counts them.
 *
 * Used only for files no test loaded, where V8 supplies no count at all. The
 * `LF` total in the run's lcov is the file's physical line count rather than a
 * count of executable lines, so this matches it: a trailing newline closes the
 * last line rather than opening another. That agreement is what lets the two
 * halves of the report be ranked against each other at all.
 */
export function countSourceLines(source: string): number {
  if (source === "") return 0;
  const lines = source.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/**
 * Union the measured files with the tree's own inventory.
 *
 * A path in `inventory` that lcov never mentioned is a file no test imported;
 * it joins the list at zero. A path lcov reported wins on its own numbers —
 * the run measured it, the tree only counted its lines.
 */
export function withNeverLoaded(measured: FileCoverage[], inventory: Map<string, number>): FileCoverage[] {
  const seen = new Set(measured.map((file) => file.path));
  const synthesised: FileCoverage[] = [];
  for (const [path, lines] of inventory) {
    if (seen.has(path)) continue;
    synthesised.push({ path, lines, covered: 0, functions: 0, functionsCovered: 0, loaded: false });
  }
  return [...measured, ...synthesised].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Least-covered first, by UNCOVERED LINES rather than by percentage.
 *
 * Percentage alone puts a four-line helper at 0% above a 600-line pane at 20%,
 * which inverts the ordering a review or prune pass wants: the question is
 * where the largest unexercised surface is. Ties break to the lower percentage,
 * then to the path so the report is stable between runs.
 */
export function rankLeastCovered(files: FileCoverage[]): FileCoverage[] {
  return [...files].sort((a, b) => {
    const byUncovered = b.lines - b.covered - (a.lines - a.covered);
    if (byUncovered !== 0) return byUncovered;
    const byPercent = percent(a.covered, a.lines) - percent(b.covered, b.lines);
    if (byPercent !== 0) return byPercent;
    return a.path.localeCompare(b.path);
  });
}

/** The directory a file rolls up under — `src/components`, `scripts/lib`, and so on. */
export function areaOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "." : path.slice(0, cut);
}

/** Per-directory roll-up, largest uncovered surface first. */
export function summariseByArea(files: FileCoverage[]): AreaSummary[] {
  const areas = new Map<string, AreaSummary>();
  for (const file of files) {
    const area = areaOf(file.path);
    let summary = areas.get(area);
    if (summary === undefined) {
      summary = { area, files: 0, neverLoaded: 0, lines: 0, covered: 0 };
      areas.set(area, summary);
    }
    summary.files += 1;
    if (!file.loaded) summary.neverLoaded += 1;
    summary.lines += file.lines;
    summary.covered += file.covered;
  }
  return [...areas.values()].sort((a, b) => b.lines - b.covered - (a.lines - a.covered) || a.area.localeCompare(b.area));
}

function pad(text: string, width: number, right = false): string {
  if (text.length >= width) return text;
  const fill = " ".repeat(width - text.length);
  return right ? fill + text : text + fill;
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column].length)));
  /* Column 0 is a name and reads left-aligned; every other column is a number
     or a short tag and reads right-aligned against it. */
  const line = (cells: string[]) => cells.map((cell, column) => pad(cell, widths[column], column > 0)).join("  ").trimEnd();
  /* The rule under an unnamed column (the never-loaded tag) is left empty —
     underlining a heading that isn't there reads as a missing header. */
  const rule = widths.map((width, column) => (header[column] === "" ? "" : "-".repeat(width)));
  return [line(header), line(rule), ...rows.map(line)].join("\n");
}

/** The ranked view, as plain aligned text — the excerpt a reader quotes. */
export function formatRanking(files: FileCoverage[], limit: number): string {
  const rows = rankLeastCovered(files)
    .slice(0, limit)
    .map((file) => [
      file.path,
      String(file.lines - file.covered),
      String(file.lines),
      `${percent(file.covered, file.lines).toFixed(1)}%`,
      file.loaded ? "" : "never loaded",
    ]);
  if (rows.length === 0) return "(no files measured)";
  return renderTable(["file", "uncovered", "lines", "line %", ""], rows);
}

/** The per-directory headline table. */
export function formatAreas(files: FileCoverage[]): string {
  const rows = summariseByArea(files).map((area) => [
    area.area,
    String(area.files),
    String(area.neverLoaded),
    String(area.lines - area.covered),
    String(area.lines),
    `${percent(area.covered, area.lines).toFixed(1)}%`,
  ]);
  if (rows.length === 0) return "(no files measured)";
  return renderTable(["area", "files", "never loaded", "uncovered", "lines", "line %"], rows);
}

/** Everything a reader needs to know about the run that produced the report. */
export type ReportContext = {
  commit: string;
  generatedAt: string;
  durationS: number;
  testExitCode: number;
  rankingLimit: number;
};

/**
 * The published report.
 *
 * The preamble is not decoration: whoever reads this file next needs to know
 * that it measures nothing but the node suite (the browser suite's coverage is
 * not in here), that a never-loaded row is counted differently from a measured
 * one, and that none of it gates anything.
 */
export function formatReport(files: FileCoverage[], context: ReportContext): string {
  const loaded = files.filter((file) => file.loaded);
  const neverLoaded = files.length - loaded.length;
  const lines = files.reduce((total, file) => total + file.lines, 0);
  const covered = files.reduce((total, file) => total + file.covered, 0);
  const zero = files.filter((file) => file.covered === 0).length;

  return [
    "# Least-covered files",
    "",
    `- commit: ${context.commit}`,
    `- generated: ${context.generatedAt}`,
    `- suite: the node test battery (\`npm test\`), ${context.durationS}s under coverage` +
      (context.testExitCode === 0 ? "" : ` — EXIT ${context.testExitCode}, numbers are partial`),
    `- files: ${files.length} (${neverLoaded} that no test loaded)`,
    `- files at 0%: ${zero}`,
    `- lines: ${covered}/${lines} covered (${percent(covered, lines).toFixed(1)}%)`,
    "",
    "Report only. No threshold, no gate, nothing here can fail a build — it is a",
    "map of the unexercised surface for a review or prune pass to read.",
    "",
    "Two caveats worth carrying into any conclusion drawn from this:",
    "",
    "1. Only the node suite is measured. A surface exercised solely by the",
    "   browser suite reads as uncovered here and is not.",
    "2. `never loaded` rows are files no test imported. The suite's coverage",
    "   pass cannot see a `.tsx` it never loaded at all, so those rows are",
    "   filled from the tree instead. Line counts are physical lines on both",
    "   halves — that is what the run's own totals are — so the two rank",
    "   together, but a never-loaded row measures nothing beyond its size.",
    "",
    "## By area",
    "",
    "```",
    formatAreas(files),
    "```",
    "",
    `## Least covered — top ${context.rankingLimit}`,
    "",
    "Ordered by uncovered lines, so the largest unexercised surface is first.",
    "",
    "```",
    formatRanking(files, context.rankingLimit),
    "```",
    "",
    "The full per-file list, including everything below the cut, is in",
    "`least-covered.json` next to this file.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// What gets measured
// ---------------------------------------------------------------------------
//
// One definition, two readers: the flags handed to the suite, and the
// inventory scan that fills in the files the suite never loaded. If those two
// ever disagreed, every `.tsx` on the wrong side of the disagreement would
// vanish from the report or appear in it twice.

/** Tree roots the report covers. The browser suite's own surfaces are not here. */
export const COVERAGE_ROOTS = ["src", "scripts"] as const;

/** Extensions the report treats as source. */
export const COVERAGE_EXTENSIONS = [".ts", ".tsx"] as const;

/**
 * Is this repo-relative path part of the measured surface?
 *
 * Tests are excluded because a suite covering itself says nothing, declaration
 * files because they emit no code, and the script fixtures because they are
 * inputs rather than program.
 */
export function isMeasured(path: string): boolean {
  if (!COVERAGE_EXTENSIONS.some((extension) => path.endsWith(extension))) return false;
  if (path.endsWith(".d.ts")) return false;
  if (/\.test\.tsx?$/.test(path)) return false;
  if (path.startsWith("scripts/fixtures/")) return false;
  return COVERAGE_ROOTS.some((root) => path.startsWith(`${root}/`));
}

/**
 * The `node --test` flags that turn a suite run into a coverage run.
 *
 * Three reporters, because one destination cannot serve all three readers: lcov
 * to a file is what this module parses, the full spec log to a file is where a
 * failing test's detail lives, and the terse progress on stdout keeps the
 * console readable — node's own coverage table is many hundreds of columns wide
 * and is exactly what the ranked view replaces.
 */
export function coverageArgs(directory: string): string[] {
  return [
    "--experimental-test-coverage",
    /* Deliberately NOT --test-coverage-include-all. It would synthesise rows
       for unimported `.ts` files only, never `.tsx`, so the union with the
       tree has to exist regardless — and once it does, the flag adds nothing
       but a node floor newer than the one the suite itself needs. Leaving it
       off is what lets this run wherever `npm test` runs. */
    /* Spelled out by extension rather than `<root>/**`: the walk would
       otherwise reach a `.js` under these roots that the tree inventory —
       which is `isMeasured`, the same predicate — would not, and the two
       halves of the report would disagree about what the measured surface
       is. There is no such file today; this keeps it that way by
       construction. */
    ...COVERAGE_ROOTS.flatMap((root) =>
      COVERAGE_EXTENSIONS.map((extension) => `--test-coverage-include=${root}/**/*${extension}`),
    ),
    "--test-coverage-exclude=**/*.test.ts",
    "--test-coverage-exclude=**/*.test.tsx",
    "--test-coverage-exclude=**/*.d.ts",
    "--test-coverage-exclude=scripts/fixtures/**",
    "--test-reporter=lcov",
    `--test-reporter-destination=${directory}/lcov.info`,
    "--test-reporter=spec",
    `--test-reporter-destination=${directory}/test-run.log`,
    "--test-reporter=dot",
    "--test-reporter-destination=stdout",
  ];
}
