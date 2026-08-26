import { test } from "node:test";
import assert from "node:assert/strict";
import {
  areaOf,
  countSourceLines,
  coverageArgs,
  formatRanking,
  formatReport,
  isMeasured,
  parseLcov,
  percent,
  rankLeastCovered,
  summariseByArea,
  withNeverLoaded,
  type FileCoverage,
} from "./coverage.ts";

// The coverage pass is REPORT-ONLY, and these pin the two properties that make
// the report trustworthy rather than the formatting around them: that a file no
// test ever loaded still appears (node's own include-all walk cannot see an
// unloaded `.tsx`, which is most of the components), and that the ranking is by
// unexercised SURFACE rather than by percentage — otherwise a four-line helper
// at 0% outranks a 600-line pane at 20% and the view answers the wrong question.

const lcov = [
  "TN:",
  "SF:src/lib/agefill.ts",
  "FNF:3",
  "FNH:2",
  "DA:1,1",
  "LF:49",
  "LH:47",
  "end_of_record",
  "SF:src/components/LensSettings.tsx",
  "FNF:15",
  "FNH:15",
  "LF:120",
  "LH:96",
  "end_of_record",
  "",
].join("\n");

function file(path: string, lines: number, covered: number, loaded = true): FileCoverage {
  return { path, lines, covered, functions: 0, functionsCovered: 0, loaded };
}

test("lcov parses to per-file line and function totals", () => {
  assert.deepEqual(parseLcov(lcov), [
    { path: "src/lib/agefill.ts", lines: 49, covered: 47, functions: 3, functionsCovered: 2, loaded: true },
    { path: "src/components/LensSettings.tsx", lines: 120, covered: 96, functions: 15, functionsCovered: 15, loaded: true },
  ]);
});

// A run the watchdog kills mid-flush leaves the final record unterminated. The
// file it names is still a file the run saw, and dropping it would quietly
// shrink the report rather than say anything went wrong.
test("a truncated final record is kept, not dropped", () => {
  const cut = ["SF:src/lib/only.ts", "LF:10", "LH:4"].join("\n");
  assert.deepEqual(parseLcov(cut), [
    { path: "src/lib/only.ts", lines: 10, covered: 4, functions: 0, functionsCovered: 0, loaded: true },
  ]);
});

test("an empty lcov reports no files rather than throwing", () => {
  assert.deepEqual(parseLcov(""), []);
  assert.deepEqual(parseLcov("TN:\n"), []);
});

// THE GAP THE REPORT EXISTS TO CLOSE. lcov names only the files the run
// loaded, so the ones worth knowing about are exactly the ones missing from it.
// Unioning with the tree's inventory is what puts them back, flagged as never
// loaded so their line counts are never mistaken for V8's executable-line
// counts.
test("files the suite never loaded join the report at zero, flagged", () => {
  const measured = [file("src/lib/agefill.ts", 49, 47)];
  const inventory = new Map([
    ["src/lib/agefill.ts", 40],
    ["src/components/Untouched.tsx", 310],
  ]);
  assert.deepEqual(withNeverLoaded(measured, inventory), [
    { path: "src/components/Untouched.tsx", lines: 310, covered: 0, functions: 0, functionsCovered: 0, loaded: false },
    { path: "src/lib/agefill.ts", lines: 49, covered: 47, functions: 0, functionsCovered: 0, loaded: true },
  ]);
});

test("a measured file keeps its own numbers, not the inventory's line count", () => {
  const merged = withNeverLoaded([file("src/lib/a.ts", 49, 47)], new Map([["src/lib/a.ts", 40]]));
  assert.deepEqual(merged, [
    { path: "src/lib/a.ts", lines: 49, covered: 47, functions: 0, functionsCovered: 0, loaded: true },
  ]);
});

test("the ranking is by unexercised surface, so size beats percentage", () => {
  const ranked = rankLeastCovered([
    file("tiny.ts", 4, 0),
    file("pane.tsx", 600, 120),
    file("mid.ts", 100, 50),
  ]);
  assert.deepEqual(
    ranked.map((f) => f.path),
    ["pane.tsx", "mid.ts", "tiny.ts"],
  );
});

// Two files with the same uncovered count are not equally interesting: the one
// where that is the whole file is. Path is the last tiebreak so two runs at the
// same commit produce the same report.
test("ties break to the lower percentage, then to the path", () => {
  const ranked = rankLeastCovered([file("b.ts", 100, 50), file("a.ts", 50, 0), file("c.ts", 50, 0)]);
  assert.deepEqual(
    ranked.map((f) => f.path),
    ["a.ts", "c.ts", "b.ts"],
  );
});

test("areas roll up by directory, largest uncovered surface first", () => {
  const summary = summariseByArea([
    file("src/lib/a.ts", 100, 90),
    file("src/lib/b.ts", 100, 80),
    file("src/components/C.tsx", 400, 0, false),
  ]);
  assert.deepEqual(summary, [
    { area: "src/components", files: 1, neverLoaded: 1, lines: 400, covered: 0 },
    { area: "src/lib", files: 2, neverLoaded: 0, lines: 200, covered: 170 },
  ]);
  assert.equal(areaOf("src/components/C.tsx"), "src/components");
  assert.equal(areaOf("bare.ts"), ".");
});

// An empty file is 100% covered, not NaN%: a report cannot rank on NaN, and
// "nothing to cover" is honestly full coverage.
test("percent handles the zero-line file", () => {
  assert.equal(percent(0, 0), 100);
  assert.equal(percent(1, 4), 25);
});

// The suite's lcov reports a file's PHYSICAL line count as its total, so the
// half of the report the tree supplies has to count the same way — otherwise
// the two halves are ranked against each other with different rulers.
test("never-loaded line counts match the run's own ruler: physical lines", () => {
  assert.equal(countSourceLines("a\nb\nc"), 3);
  assert.equal(countSourceLines("a\nb\nc\n"), 3);
  assert.equal(countSourceLines("\n"), 1);
  assert.equal(countSourceLines(""), 0);
});

// The measured surface has exactly one definition, because the suite's flags
// and the tree walk that fills in the unloaded files both read it. If they ever
// disagreed, files on the wrong side would vanish or appear twice.
test("the measured surface is source under src/ and scripts/, never tests or fixtures", () => {
  for (const path of ["src/lib/a.ts", "src/components/A.tsx", "scripts/check-ipc.ts", "scripts/lib/coverage.ts"]) {
    assert.equal(isMeasured(path), true, path);
  }
  for (const path of [
    "src/lib/a.test.ts",
    "scripts/lib/coverage.test.ts",
    "src/vite-env.d.ts",
    "scripts/fixtures/seed.ts",
    "e2e/hubdash.spec.ts",
    "src/styles.css",
    "README.md",
  ]) {
    assert.equal(isMeasured(path), false, path);
  }
});

// The console would otherwise carry node's own coverage table, which is one
// line several hundred columns wide — so the terse reporter goes to stdout and
// the readable one to a file, where a failing test's detail is still findable.
test("coverage flags name three reporters and route only the terse one to stdout", () => {
  const args = coverageArgs("coverage");
  assert.ok(args.includes("--experimental-test-coverage"));
  assert.ok(args.includes("--test-coverage-exclude=**/*.test.ts"));
  assert.ok(args.includes("--test-reporter-destination=coverage/lcov.info"));
  assert.ok(args.includes("--test-reporter-destination=coverage/test-run.log"));
  assert.equal(args.filter((arg) => arg === "--test-reporter-destination=stdout").length, 1);
});

test("the report names its caveats and never claims a pass or a threshold", () => {
  const report = formatReport([file("src/components/A.tsx", 300, 0, false), file("src/lib/b.ts", 100, 90)], {
    commit: "abc123",
    generatedAt: "2026-08-26T00:00:00Z",
    durationS: 700,
    testExitCode: 0,
    rankingLimit: 10,
  });
  assert.match(report, /Report only/);
  assert.match(report, /nothing here can fail a build/);
  assert.match(report, /never loaded/);
  assert.match(report, /Only the node suite is measured/);
  assert.match(report, /files: 2 \(1 that no test loaded\)/);
  assert.match(report, /90\/400 covered \(22\.5%\)/);
  assert.match(report, /physical lines on both/);
  assert.doesNotMatch(report, /threshold: /i);
});

test("a red suite marks the report partial rather than hiding it", () => {
  const report = formatReport([file("src/lib/b.ts", 100, 90)], {
    commit: "abc123",
    generatedAt: "2026-08-26T00:00:00Z",
    durationS: 12,
    testExitCode: 1,
    rankingLimit: 10,
  });
  assert.match(report, /EXIT 1, numbers are partial/);
});

test("the ranking renders as an aligned table with a never-loaded tag", () => {
  const table = formatRanking([file("src/components/A.tsx", 300, 0, false), file("src/lib/b.ts", 100, 90)], 10);
  const rows = table.split("\n");
  assert.match(rows[0], /^file\s+uncovered\s+lines\s+line %/);
  assert.match(rows[2], /^src\/components\/A\.tsx\s+300\s+300\s+0\.0%\s+never loaded$/);
  assert.match(rows[3], /^src\/lib\/b\.ts\s+10\s+100\s+90\.0%$/);
  assert.equal(formatRanking([], 10), "(no files measured)");
});

// The measured surface is named by extension rather than by directory, because
// the tree walk that fills in the never-loaded half is `isMeasured` — a `.js`
// the flags picked up but the walk did not would make the two halves disagree
// about what is being measured at all.
test("the include flags name the same extensions the inventory walks", () => {
  const args = coverageArgs("coverage");
  assert.deepEqual(
    args.filter((arg) => arg.startsWith("--test-coverage-include=")),
    [
      "--test-coverage-include=src/**/*.ts",
      "--test-coverage-include=src/**/*.tsx",
      "--test-coverage-include=scripts/**/*.ts",
      "--test-coverage-include=scripts/**/*.tsx",
    ],
  );
  // include-all would reach `.ts` and never `.tsx`, so the union has to exist
  // regardless — and off, the run needs no newer node than the suite does.
  assert.ok(!args.includes("--test-coverage-include-all"));
});

// A run configured with include-all (or a future node that synthesises rows on
// its own) reports an unimported file as measured-and-empty. Left alone it
// would read as "loaded, 0% covered" while an unimported `.tsx` — absent from
// lcov — reads as "never loaded": the same fact told two ways, and the report's
// never-loaded count naming only half of them.
test("an lcov row with nothing covered is a file nothing loaded", () => {
  const parsed = parseLcov(
    ["SF:scripts/probe.ts", "LF:302", "LH:0", "end_of_record", "SF:src/lib/b.ts", "LF:10", "LH:1", "end_of_record"].join(
      "\n",
    ),
  );
  assert.deepEqual(
    parsed.map((f) => [f.path, f.loaded]),
    [
      ["scripts/probe.ts", false],
      ["src/lib/b.ts", true],
    ],
  );
  // An empty file has nothing to cover and is not evidence of anything.
  assert.equal(parseLcov(["SF:src/empty.ts", "LF:0", "LH:0", "end_of_record"].join("\n"))[0].loaded, true);
});

// Corrupt input should cost a record's terminator, never a whole row: a report
// that silently shrinks is worse than one that names a file with zeroes.
test("a record cut off by the next SF: is kept, not overwritten", () => {
  const parsed = parseLcov(["SF:a.ts", "LF:10", "LH:1", "SF:b.ts", "LF:5", "LH:5", "end_of_record"].join("\n"));
  assert.deepEqual(
    parsed.map((f) => f.path),
    ["a.ts", "b.ts"],
  );
});

// `Number("")` is 0, so an LF with no value is dropped as a non-count — and
// the LH that landed without it is clamped at push time, so a half-surviving
// pair can never publish a row with more covered lines than lines.
test("a count that is not a count is ignored, and its orphaned twin is clamped", () => {
  const parsed = parseLcov(["SF:a.ts", "LF:", "LH:3", "LF:1.5", "LF:-2", "end_of_record"].join("\n"));
  assert.deepEqual(parsed, [
    { path: "a.ts", lines: 0, covered: 0, functions: 0, functionsCovered: 0, loaded: true },
  ]);
});

// The clamp holds for the function pair too, and for a record terminated by
// the next SF: rather than its own end_of_record.
test("covered never exceeds its total, whichever way the record ends", () => {
  const parsed = parseLcov(["SF:a.ts", "FNF:", "FNH:2", "LF:4", "LH:2", "SF:b.ts", "LF:1", "LH:1", "end_of_record"].join("\n"));
  assert.deepEqual(parsed, [
    { path: "a.ts", lines: 4, covered: 2, functions: 0, functionsCovered: 0, loaded: true },
    { path: "b.ts", lines: 1, covered: 1, functions: 0, functionsCovered: 0, loaded: true },
  ]);
});
