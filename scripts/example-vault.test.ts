import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSheet, findSummary, parseSheet } from "../src/lib/sheet.ts";
import { isErr, type FxResolver } from "../src/lib/formula.ts";
import { parseChartBlocks, sheetRows } from "../src/lib/chart.ts";
import {
  heatmapGrid,
  heatmapYears,
  parseHeatmapBlocks,
  pickHeatmapYear,
  tallyHeatmap,
} from "../src/lib/heatmap.ts";
import { parseTimelineConfig, timelineData } from "../src/lib/timeline.ts";
import { parseHub } from "../src/lib/hub.ts";
import { parseViewSpec } from "../src/lib/embeds.ts";
import { collectCardsFences, parseBind, parseCardsBlock } from "../src/lib/metriccards.ts";
import { parseProgressBlocks } from "../src/lib/progress.ts";
import { parseFoodRows } from "../src/lib/food.ts";
import { parseFoodDb } from "../src/lib/fooddb.ts";
import { isOpenableUrl, parseFeedItems } from "../src/lib/feed.ts";
import { buildTasksDashboard } from "../src/lib/tasksDashboard.ts";
import type { NoteMeta, SchemaConfig } from "../src/lib/types.ts";
import { GLYPH_IDS, ICON_TINTS } from "../src/lib/dbicons.ts";
import { BUILT_IN_KINDS, kindApiFit, parseKindManifest } from "../src/lib/kinds.ts";

// The example vault (examples/vault/) ships in the repo as the runnable demo
// for docs/dashboards.md. This suite parses every file through the same lib
// code the app renders with, so the demo can't drift from the formats.

const VAULT = fileURLToPath(new URL("../examples/vault", import.meta.url));
const fx: FxResolver = () => 0.9;

interface VaultNote {
  path: string; // vault-relative
  stem: string;
  props: Record<string, string | string[]>;
  body: string;
}

/** Just enough frontmatter for the hand-written demo files: `key: value`
    scalars and `key:` + `- item` string lists. The engine's YAML is a
    superset; anything this parser rejects, the engine would also frown at. */
function parseNote(rel: string, raw: string): VaultNote {
  const stem = basename(rel, ".md");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  assert.ok(m, `${rel}: frontmatter block must open the file`);
  const props: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^- (.+)$/.exec(line);
    if (item && listKey) {
      const cur = props[listKey];
      props[listKey] = Array.isArray(cur) ? [...cur, item[1]] : [item[1]];
      continue;
    }
    if (/^\s/.test(line)) continue; // nested mapping (cards:) — checked per-note below
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    listKey = kv[2] === "" ? kv[1] : null;
    if (kv[2] !== "") props[kv[1]] = kv[2].replace(/^'(.*)'$/, "$1");
  }
  return { path: rel, stem, props, body: m[2] };
}

function loadVault(): VaultNote[] {
  const notes: VaultNote[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(join(VAULT, dir), { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      // AGENTS.md is the seeded agent orientation file and CLAUDE.md
      // its seeded pointer — real notes to the engine but plain-prose
      // ones: no frontmatter, no type, nothing for the demo parsers to check.
      if (e.name === "AGENTS.md" || e.name === "CLAUDE.md") continue;
      const rel = prefix + e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel + "/");
      else if (e.name.endsWith(".md")) notes.push(parseNote(rel, readFileSync(join(VAULT, dir, e.name), "utf8")));
    }
  };
  walk(".", "");
  return notes;
}

const notes = loadVault();
const byStem = (s: string) => notes.find((n) => n.stem.toLowerCase() === s.toLowerCase());
const schema = JSON.parse(readFileSync(join(VAULT, ".vault/schema.json"), "utf8")) as Record<
  string,
  Record<string, unknown>
>;
const dbTypes = new Set(Object.keys(schema));
const loadSheet = (name: string) => {
  const n = byStem(name);
  return n ? parseSheet(n.body) : null;
};

test("every note parses and its type is schema'd or app-known", () => {
  assert.ok(notes.length >= 10, `expected the full demo set, found ${notes.length}`);
  const appTypes = new Set(["dashboard", "sheet", ...dbTypes]);
  for (const n of notes) {
    const t = n.props["type"];
    if (typeof t === "string") assert.ok(appTypes.has(t), `${n.path}: unknown type "${t}"`);
  }
});

test("the seeded agent files ship in the example vault, byte-identical (SUB-474)", () => {
  const seed = fileURLToPath(new URL("../src-tauri/src/seed", import.meta.url));
  for (const [src, dst] of [
    ["AGENTS.md", "AGENTS.md"],
    ["CLAUDE.md", "CLAUDE.md"],
    ["setup-skill.md", ".claude/skills/setup/SKILL.md"],
  ]) {
    assert.equal(
      readFileSync(join(VAULT, dst), "utf8"),
      readFileSync(join(seed, src), "utf8"),
      `${dst} has drifted from the seed the app writes`
    );
  }
});

test("the seeded agent door matches editable-view and recoverable-asset contracts (SUB-996)", () => {
  const seed = readFileSync(
    fileURLToPath(new URL("../src-tauri/src/seed/AGENTS.md", import.meta.url)),
    "utf8"
  );
  assert.match(seed, /view fence[^\n]*live, editable/);
  assert.match(seed, /non-title cells edit\s+in place/);
  assert.match(seed, /Deleting one through the app moves it to `\.trash\/`/);
  assert.doesNotMatch(seed, /view fence[^\n]*live, read-only/);
  assert.doesNotMatch(seed, /Deleting one is permanent/);
  assert.doesNotMatch(seed, /machine-specific kinds/);
  // the roster wraps, so the gap between kinds is any run of whitespace
  assert.match(seed, /`tasks`, `sync`, `coding`,\s+`jobs`, `tax`, `charts`/);
  assert.match(seed, /unknown value shows an “unknown kind” card/);
  assert.doesNotMatch(seed, /dashboard: charts` is a conventional label/);
});

test("the seeded agent door keeps its sealed-scopes orientation (SUB-1099)", () => {
  const seed = readFileSync(
    fileURLToPath(new URL("../src-tauri/src/seed/AGENTS.md", import.meta.url)),
    "utf8"
  );
  // A rewrite that drops this section leaves an external agent treating
  // ciphertext as a corrupt note. Each assertion pins one claim
  // the reader has to arrive with, not the prose around it.
  assert.match(seed, /^## Sealed scopes/m, "the sealed-scopes section went missing");
  assert.match(seed, /`\.substrate-seal` file in a folder/, "the marker filename is unnamed");
  assert.match(seed, /inherits down the path/, "seal inheritance is unstated");
  assert.match(seed, /siblings are independent/, "sibling independence is unstated");
  assert.match(seed, /`SUBSTRATE-SEALED-1`/, "the ciphertext header is unnamed");
  assert.match(seed, /is not corruption/, "ciphertext is not called out as intact");
  assert.match(
    seed,
    /Never edit, "repair", reformat or delete a file you cannot read as\s+plaintext/,
    "the don't-repair-ciphertext rule went missing"
  );
  assert.match(seed, /`\.vault\/sealed-key\.age`/, "the recovery file is unnamed");
  assert.match(seed, /only password\s+recovery\s+path/, "the recovery path is not marked untouchable");
  assert.match(
    seed,
    /check for `\.substrate-seal` at the\s+vault root and on every folder of the target path/,
    "the pre-write seal check went missing"
  );
  assert.match(seed, /public `recipient` named in\s+the marker/, "the write path names no recipient");
  assert.match(seed, /never invent a second recipient/, "the one-recipient rule went missing");
  // Reads need an authorized key; writes do not — encrypting to the marker's
  // public recipient is enough. Conflating the two sent agents looking for a
  // key they never needed (review).
  assert.doesNotMatch(
    seed,
    /Reading or writing note content inside a sealed one\s+needs a key/,
    "the key claim is back to covering writes"
  );
});

test("the seed's documented view example parses to the keys it claims (SUB-474)", () => {
  const seed = readFileSync(
    fileURLToPath(new URL("../src-tauri/src/seed/AGENTS.md", import.meta.url)),
    "utf8"
  );
  // Link tokens are safe to spell out now, but only inside code:
  // literal code is not link syntax, so a fenced or `span`-wrapped link is
  // never indexed and never rewritten by a rename. Bare ones still would be.
  const outsideCode = seed.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`\n]*`/g, "");
  assert.equal(outsideCode.match(/\[\[/g), null, "seed carries a link token outside code");
  // vault_doctor's view-fence scan (broken-view-ref) is a separate mechanism
  // and still reads fenced content, so the view example stays backtick-less
  assert.equal(seed.match(/^```view$/m), null, "seed carries a real view fence");

  const m = /\(open fence, info string: view\)\n([\s\S]*?)\(close fence\)/.exec(seed);
  assert.ok(m, "the documented view example went missing");
  const spec = parseViewSpec(m[1].replace(/^ {4}/gm, ""));
  assert.deepEqual(spec, { type: "trip", query: "status:planned", view: "table" });
});

// BUILT_IN_KINDS rather than a hand-copied set: the copy had
// already drifted from it. Reading the constant also makes the check honest
// in the public mirror, where the machine-specific kinds are stripped out of
// it — a demo dashboard on a private kind would ship a note that build cannot
// render, and this now fails instead of passing against a stale list.
test("dashboard kinds are ones the app dispatches", () => {
  const kinds = BUILT_IN_KINDS;
  // a vault may also carry its own renderer at `.vault/kinds/<id>/`
  // (vault-format §5.8) — this vault ships one, so the demo boards may name it
  const resident = new Set(
    readdirSync(join(VAULT, ".vault", "kinds"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  );
  const dashboards = notes.filter((n) => n.props["type"] === "dashboard");
  assert.equal(dashboards.length, 20);
  for (const n of dashboards) {
    const k = n.props["dashboard"];
    assert.ok(
      typeof k === "string" && (kinds.has(k) || resident.has(k)),
      `${n.path}: unknown dashboard kind "${k}"`
    );
  }
});

test("the vault-resident kind bundles parse through the real manifest parser", () => {
  const dir = join(VAULT, ".vault", "kinds");
  const ids = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(ids.length > 0, "the demo vault should ship at least one custom kind");
  for (const id of ids) {
    const res = parseKindManifest(id, readFileSync(join(dir, id, "kind.json"), "utf8"));
    assert.ok(res.ok, `${id}/kind.json is invalid: ${res.ok ? "" : res.reason}`);
    assert.equal(kindApiFit(res.manifest.api), "ok", `${id}: api ${res.manifest.api} is out of range`);
    // every file the manifest names has to be in the folder, or the pane the
    // recipe installs is a card explaining what is missing
    const files = new Set(readdirSync(join(dir, id)));
    assert.ok(files.has(res.manifest.entry), `${id}: entry ${res.manifest.entry} is missing`);
    if (res.manifest.style) {
      assert.ok(files.has(res.manifest.style), `${id}: style ${res.manifest.style} is missing`);
    }
  }
});

test("Holdings evaluates; Portfolio's card binds all resolve to summaries", () => {
  const model = loadSheet("Holdings");
  assert.ok(model && model.headers.length > 0, "Holdings sheet missing or empty");
  const ev = evaluateSheet(model, fx);
  for (const s of ev.summaries) assert.ok(!isErr(s.value), `Holdings summary ${s.name}: ${JSON.stringify(s.value)}`);

  const portfolio = byStem("Portfolio");
  assert.ok(portfolio, "Dashboards/Portfolio.md missing");
  const binds = [...readFileSync(join(VAULT, portfolio.path), "utf8").matchAll(/\{\{([^.}]+)\.([^}]+)\}\}/g)];
  assert.ok(binds.length >= 3, "Portfolio should bind at least 3 cards");
  for (const [, sheet, name] of binds) {
    assert.equal(sheet, "Holdings", `bind targets unknown sheet "${sheet}"`);
    assert.ok(!isErr(findSummary(ev, name)), `bind {{${sheet}.${name}}} resolves no summary`);
  }
});

test("Label Accounting workbook: pages resolve, sheets evaluate, binds land", () => {
  const wb = byStem("Label Accounting");
  assert.ok(wb, "Dashboards/Label Accounting.md missing");
  const pages = wb.props["pages"];
  assert.ok(Array.isArray(pages) && pages.length >= 3, "workbook should carry pages:");
  for (const p of pages as unknown as Record<string, unknown>[]) {
    if (typeof p["note"] === "string") assert.ok(byStem(p["note"]), `page note "${p["note"]}" missing from vault`);
    if (typeof p["view"] === "string") assert.ok(dbTypes.has(p["view"]), `page view "${p["view"]}" not a schema'd type`);
  }
  for (const name of ["Label Statements", "Label Splits"]) {
    const model = loadSheet(name);
    assert.ok(model && model.headers.length > 0, `${name} sheet missing or empty`);
    const ev = evaluateSheet(model, fx);
    for (const s of ev.summaries) assert.ok(!isErr(s.value), `${name} summary ${s.name}: ${JSON.stringify(s.value)}`);
  }
});

test("Finance workbook: every sheet evaluates cross-sheet, pages resolve, binds land", () => {
  // This recipe is the one that reads across itself — Expected Returns looks
  // balances up in Accounts, Expenses subtracts Budget Limits' total — so it
  // is evaluated with a cross-sheet loader rather than in isolation. A missing
  // ref would otherwise pass as a lone sheet's own error-free evaluation.
  const load = (name: string) => {
    const n = byStem(name);
    return n ? parseSheet(n.body) : { err: `no sheet ${name}` };
  };
  const sheetNames = [
    "Accounts",
    "Expected Returns",
    "Expenses",
    "Budget Limits",
    "Debts",
    "Upcoming",
    "Forecast Cashflow",
    "Forecast Net Worth",
  ];
  const evals = new Map<string, ReturnType<typeof evaluateSheet>>();
  for (const name of sheetNames) {
    const model = loadSheet(name);
    assert.ok(model && model.headers.length > 0, `${name} sheet missing or empty`);
    assert.deepEqual(model.errors, [], `${name} has sheet-level errors`);
    const ev = evaluateSheet(model, fx, { self: name, load });
    for (const s of ev.summaries)
      assert.ok(!isErr(s.value), `${name} summary ${s.name}: ${JSON.stringify(s.value)}`);
    evals.set(name.toLowerCase(), ev);
  }

  // the three machine-written sheets say so where an editing agent will see it
  for (const name of ["Upcoming", "Forecast Cashflow", "Forecast Net Worth"]) {
    assert.match(byStem(name)!.body, /> \[!warn\] Machine-written/, `${name} lost its machine-written callout`);
  }
  // …and they carry the freshness stamp the workbook note promises the refresh
  // rewrites: without it "watch the job afterwards" has nothing to read
  for (const name of ["Upcoming", "Forecast Cashflow", "Forecast Net Worth"]) {
    const stamp = byStem(name)!.props["exported"];
    assert.ok(typeof stamp === "string" && !Number.isNaN(Date.parse(stamp)), `${name} has no parseable exported: stamp`);
  }
  // Debts holds no date arithmetic: its due column is optional, and
  // `due - TODAY()` would error on the blank cells the sample deliberately has
  assert.doesNotMatch(byStem("Debts")!.body.split("```formulas")[1] ?? "", /TODAY\(\)|due/);

  // Upcoming mixes both money directions, so no summary may sum across them:
  // a repayment coming in must never shrink what is going out. The sweep also
  // covers every Expenses row that carries a due_day — now all eight — plus
  // the dated open rows of Debts.
  const up = loadSheet("Upcoming")!;
  const colOf = (h: string) => {
    const i = up.headers.findIndex((x) => x.toLowerCase() === h);
    assert.ok(i >= 0, `Upcoming has no ${h} column`);
    return i;
  };
  const flowCol = colOf("flow");
  const amtCol = colOf("amount_eur");
  for (const r of up.rows) assert.match(String(r[flowCol]), /^(in|out)$/, "every Upcoming row names its direction");
  const sumFlow = (dir: string) =>
    up.rows.filter((r) => r[flowCol] === dir).reduce((a, r) => a + Number(r[amtCol]), 0);
  assert.equal(findSummary(evals.get("upcoming")!, "due_total"), sumFlow("out"), "due_total is outflows only");
  assert.equal(
    findSummary(evals.get("upcoming")!, "incoming_total"),
    sumFlow("in"),
    "inflows get their own summary",
  );
  assert.ok(sumFlow("in") > 0 && sumFlow("out") > 0, "the sample exercises both directions");
  // the bills that were swept are exactly Expenses' fixed monthly total, which
  // is what "every row now carries a due_day" means arithmetically
  assert.equal(
    findSummary(evals.get("upcoming")!, "from_bills"),
    findSummary(evals.get("expenses")!, "fixed_monthly"),
    "the sweep covers every Expenses row",
  );
  const exp = loadSheet("Expenses")!;
  const dueDay = exp.headers.findIndex((h) => h.toLowerCase() === "due_day");
  assert.ok(dueDay >= 0, "Expenses has no due_day column");
  for (const r of exp.rows) assert.match(String(r[dueDay]), /^\d+$/, "every sample expense carries a due_day");

  // The net-worth curve is rows a script wrote, so nothing in the sheet engine
  // can check it against the model its own prose promises. Pin the first two
  // points to that model instead: start at Accounts' total_eur, then compound
  // monthly at (growth_annual + accumulating) / total_eur from Expected
  // Returns — price growth plus the income an accumulating fund keeps — and
  // add Expenses' net_monthly_plan each month, sampling every third month.
  // A regenerated curve at some other rate or contribution fails here.
  const num = (sheet: string, name: string) => {
    const v = findSummary(evals.get(sheet.toLowerCase())!, name);
    assert.ok(typeof v === "number", `${sheet}.${name} is not a number: ${JSON.stringify(v)}`);
    return v;
  };
  const startEur = num("Accounts", "total_eur");
  const annualRate = (num("Expected Returns", "growth_annual") + num("Expected Returns", "accumulating")) / startEur;
  const contribution = num("Expenses", "net_monthly_plan");
  const nw = loadSheet("Forecast Net Worth")!;
  const col = nw.headers.findIndex((h) => h.toLowerCase() === "net_worth_eur");
  assert.ok(col >= 0, "Forecast Net Worth has no net_worth_eur column");
  assert.equal(nw.rows.length, 40, "forty quarters");
  assert.equal(Number(nw.rows[0][col]), startEur, "curve starts at Accounts.total_eur");
  let balance = startEur;
  for (let i = 0; i < 3; i++) balance = balance * (1 + annualRate / 12) + contribution;
  assert.equal(
    Number(nw.rows[1][col]),
    Math.round(balance),
    "second quarter is three months compounded at the modelled rate plus three contributions",
  );

  const wb = byStem("Finance");
  assert.ok(wb, "Dashboards/Finance.md missing");
  const pages = wb.props["pages"];
  assert.ok(Array.isArray(pages) && pages.length === 11, "workbook pages: one per other board and sheet");

  // every bind on every board of the workbook resolves to a real summary
  for (const board of ["Finance", "Forecast", "Budgets", "Who Owes Whom"]) {
    const n = byStem(board);
    assert.ok(n, `Dashboards/${board}.md missing`);
    const raw = readFileSync(join(VAULT, n.path), "utf8");
    const binds = [...raw.matchAll(/\{\{([^.}]+)\.([^}]+)\}\}/g)];
    assert.ok(binds.length >= 4, `${board} should bind at least 4 values`);
    for (const [, sheet, name] of binds) {
      const ev = evals.get(sheet.toLowerCase());
      assert.ok(ev, `${board} binds unknown sheet "${sheet}"`);
      assert.ok(!isErr(findSummary(ev, name)), `${board}: {{${sheet}.${name}}} resolves no summary`);
    }
  }

  // Forecast's two curves are charts over the machine-written sheets
  const charts = parseChartBlocks(byStem("Forecast")!.body);
  assert.equal(charts.length, 2);
  for (const b of charts) {
    assert.equal(b.error, null, `chart fence error: ${b.error}`);
    assert.ok(b.config && b.config.bind !== "history", "chart fence should name a source");
    const src = b.config.source;
    assert.ok(src.kind === "sheet" && loadSheet(src.name), "chart should read a bundled sheet");
  }

  // Budgets is a hub: one cards fence, one progress bar per category
  const cards = collectCardsFences(byStem("Budgets")!.body);
  assert.equal(cards.length, 1);
  assert.equal(parseCardsBlock(cards[0]).error, null);
  const bars = parseProgressBlocks(byStem("Budgets")!.body);
  assert.equal(bars.length, 5, "one bar per budget category");
  for (const b of bars) {
    assert.equal(b.error, null, `progress fence error: ${b.error}`);
    assert.equal(b.config!.target.kind, "bind", "a category's target is its own limit summary");
  }
  assert.equal(collectCardsFences(byStem("Finance")!.body).length, 1);
});

test("Vault 2025 evaluates; Annual Report's binds resolve and fences parse", () => {
  const model = loadSheet("Vault 2025");
  assert.ok(model && model.headers.length > 0, "Vault 2025 sheet missing or empty");
  const ev = evaluateSheet(model, fx);
  for (const s of ev.summaries) assert.ok(!isErr(s.value), `Vault 2025 summary ${s.name}: ${JSON.stringify(s.value)}`);

  const report = byStem("Annual Report");
  assert.ok(report, "Dashboards/Annual Report.md missing");
  const binds = [...readFileSync(join(VAULT, report.path), "utf8").matchAll(/\{\{([^.}]+)\.([^}]+)\}\}/g)];
  assert.ok(binds.length >= 3, "Annual Report should bind at least 3 cards");
  for (const [, sheet, name] of binds) {
    assert.equal(sheet, "Vault 2025", `bind targets unknown sheet "${sheet}"`);
    assert.ok(!isErr(findSummary(ev, name)), `bind {{${sheet}.${name}}} resolves no summary`);
  }
  const blocks = parseChartBlocks(report.body);
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    assert.equal(b.error, null, `chart fence error: ${b.error}`);
    assert.ok(b.config, "chart fence produced no config");
    assert.ok(b.config.bind !== "history", "chart fence should name a source");
    const src = b.config.source;
    assert.ok(src.kind === "sheet" && loadSheet(src.name), "chart should read the bundled sheet");
  }
});

test("Release Charts fences parse clean and name real sources", () => {
  const n = byStem("Release Charts");
  assert.ok(n, "Dashboards/Release Charts.md missing");
  const blocks = parseChartBlocks(n.body);
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    assert.equal(b.error, null, `chart fence error: ${b.error}`);
    assert.ok(b.config, "chart fence produced no config");
    assert.ok(b.config.bind !== "history", "chart fence should name a source");
    const src = b.config.source;
    if (src.kind === "db") assert.ok(dbTypes.has(src.type), `chart over unknown database "${src.type}"`);
    else assert.ok(loadSheet(src.name), `chart over unknown sheet "${src.name}"`);
  }
});

test("Studio Year's heatmap fences tally the bundled session log (SUB-1241)", () => {
  const n = byStem("Studio Year");
  assert.ok(n, "Dashboards/Studio Year.md missing");
  const model = loadSheet("Studio Log");
  assert.ok(model, "Studio Log sheet missing — both grids read it");
  const rows = sheetRows(model, evaluateSheet(model, fx));
  assert.equal(rows.length, 134);

  const blocks = parseHeatmapBlocks(n.body);
  assert.equal(blocks.length, 2, "the year carries a minutes grid and a sessions grid");
  assert.deepEqual(
    blocks.map((b) => b.config?.value.fn),
    ["sum", "count"]
  );
  for (const b of blocks) {
    assert.equal(b.error, null, `heatmap fence error: ${b.error}`);
    assert.ok(b.config, "heatmap fence produced no config");
    assert.equal(b.config.source.kind, "sheet", "both grids read the bundled sheet");
    const tally = tallyHeatmap(rows, b.config);
    assert.equal(tally.missing, null, `heatmap binds a column the sheet lacks: ${tally.missing}`);
    assert.equal(tally.skipped, 0, "every logged row should land on a readable day");
    // The log straddles a year end on purpose, so the year picker has something
    // to pick and the grid isn't the only year that exists.
    assert.deepEqual(heatmapYears(tally), [2025, 2026]);
    assert.equal(pickHeatmapYear(tally, "2026-08-16"), 2026);
  }

  const sum = heatmapGrid(tallyHeatmap(rows, blocks[0].config!), 2026);
  assert.equal(sum.active, 106);
  assert.equal(sum.total, 15765);
  assert.equal(sum.max, 330);
  const count = heatmapGrid(tallyHeatmap(rows, blocks[1].config!), 2026);
  assert.equal(count.active, 106);
  assert.equal(count.max, 2, "a doubled-up day is what gives the count grid its top level");
});

test("Release Arc's timeline fences span the demo releases (SUB-1241)", () => {
  const n = byStem("Release Arc");
  assert.ok(n, "Dashboards/Release Arc.md missing");
  const releases: NoteMeta[] = notes
    .filter((r) => r.props["type"] === "release")
    .map((r) => ({
      path: r.path,
      stem: r.stem,
      title: r.stem,
      folder: r.path.split("/").slice(0, -1).join("/"),
      props: r.props,
      updated_ms: 0,
      excerpt: "",
      sealed: false,
    }));
  assert.equal(releases.length, 5, `expected the demo release set, found ${releases.length}`);

  const inners = [...n.body.matchAll(/```timeline\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(inners.length, 2, "the arc carries the whole run and a shipped-only cut");

  const arc = timelineData(parseTimelineConfig(inners[0]), releases, schema as SchemaConfig);
  assert.equal(arc.error, null, `timeline error: ${arc.error}`);
  assert.equal(arc.skipped, 0, "every release should carry a readable recording_start");
  assert.equal(arc.items.length, 5);
  // Fern Static has no `released` date yet: a milestone dot at its start, not a
  // bar claiming a ship date nobody has committed to.
  const fern = arc.items.find((i) => i.label === "Fern Static");
  assert.ok(fern, "Fern Static missing from the arc");
  assert.equal(fern.end, null);
  assert.deepEqual(
    [...new Set(arc.items.map((i) => i.group))].sort(),
    ["live", "mastering", "sketch"],
    "the arc groups by status, so every demo status should show as a lane"
  );

  const shipped = timelineData(parseTimelineConfig(inners[1]), releases, schema as SchemaConfig);
  assert.equal(shipped.error, null, `timeline error: ${shipped.error}`);
  assert.equal(shipped.items.length, 3, "status:live narrows the run to the shipped three");
  for (const item of shipped.items) assert.ok(item.end, `${item.label} shipped but has no end`);
});

test("Home hub's cards and chart fences parse and bind to the bundled sheet", () => {
  const n = byStem("Home");
  assert.ok(n, "Dashboards/Home.md missing");
  const model = loadSheet("Holdings");
  assert.ok(model, "Holdings sheet missing — the hub's cards and chart read it");
  const ev = evaluateSheet(model, fx);

  const fences = collectCardsFences(n.body);
  assert.equal(fences.length, 1, "hub should carry one ```cards fence");
  for (const inner of fences) {
    const block = parseCardsBlock(inner);
    assert.equal(block.error, null, `cards fence error: ${block.error}`);
    assert.ok(block.cards.length >= 2, "cards fence should show at least 2 cards");
    for (const card of block.cards) {
      const bind = parseBind(card.bind);
      assert.ok(bind, `card "${card.label}" has an unparseable bind`);
      assert.equal(bind.sheet, "Holdings", `card bind targets unknown sheet "${bind.sheet}"`);
      assert.ok(!isErr(findSummary(ev, bind.name)), `bind {{Holdings.${bind.name}}} resolves no summary`);
    }
  }

  const charts = parseChartBlocks(n.body);
  assert.equal(charts.length, 1, "hub should carry one ```chart fence");
  for (const b of charts) {
    assert.equal(b.error, null, `chart fence error: ${b.error}`);
    assert.ok(b.config, "chart fence produced no config");
    assert.ok(b.config.bind !== "history", "chart fence should name a source");
    const src = b.config.source;
    assert.ok(src.kind === "sheet" && loadSheet(src.name), "hub chart should read the bundled sheet");
  }
});

test("Home hub parses into sections, card rows, and valid view fences", () => {
  const n = byStem("Home");
  assert.ok(n, "Dashboards/Home.md missing");
  const blocks = parseHub(n.body);
  assert.ok(blocks.some((b) => b.kind === "section"), "hub has no section labels");
  assert.ok(
    blocks.some((b) => b.kind === "cards" && b.callouts.length >= 3),
    "hub has no callout card row"
  );
  const fences = [...n.body.matchAll(/```view\n([\s\S]*?)```/g)];
  assert.equal(fences.length, 2);
  for (const [, inner] of fences) {
    const spec = parseViewSpec(inner);
    assert.ok(!("error" in spec), `view fence doesn't parse: ${"error" in spec ? spec.error : ""}`);
    assert.ok(spec.type && dbTypes.has(spec.type), `view fence targets unknown database "${spec.type}"`);
  }
});

test("Food dashboard config points at a log sheet that parses", () => {
  const dash = byStem("Food");
  assert.ok(dash, "Dashboards/Food.md missing");
  const log = byStem(String(dash.props["log"] ?? "Food Log"));
  assert.ok(log && log.props["type"] === "sheet", "food log sheet missing");
  const rows = parseFoodRows(log.body);
  assert.ok(rows.length >= 3, `food log parsed only ${rows.length} rows`);
  assert.ok(rows.some((r) => r.kcal < 0), "demo should include an exercise (negative) row");
  const floor = Number(dash.props["floor"]);
  const ceiling = Number(dash.props["ceiling"]);
  assert.ok(isFinite(floor) && isFinite(ceiling) && floor < ceiling, "floor/ceiling band malformed");
});

test("Feed dashboard items prop points at a sheet that parses (SUB-518)", () => {
  const dash = byStem("News");
  assert.ok(dash, "Dashboards/News.md missing");
  const sheet = byStem(String(dash.props["items"] ?? "News Items"));
  assert.ok(sheet && sheet.props["type"] === "sheet", "news items sheet missing");
  const items = parseFeedItems(sheet.body);
  assert.ok(items.length >= 5, `news sheet parsed only ${items.length} items`);
  // the stream must span days (so the demo exercises the date grouping) and
  // carry both a set and an unset verdict
  assert.ok(new Set(items.map((i) => i.date)).size >= 2, "demo should span more than one day");
  assert.ok(items.some((i) => i.fb === "up") && items.some((i) => i.fb === "down"), "demo should show both verdicts");
  assert.ok(items.some((i) => i.fb === ""), "demo should leave some items unrated");
  // every item is renderable: an openable url and a why-line the pane sets apart
  assert.ok(items.every((i) => isOpenableUrl(i.url)), "every demo item needs an http(s) url");
  assert.ok(items.every((i) => i.why !== "" && i.blurb !== ""), "every demo item needs a blurb and a why");
});

test("Food dashboard db prop points at a base sheet that parses (SUB-408)", () => {
  const dash = byStem("Food");
  assert.ok(dash, "Dashboards/Food.md missing");
  const db = byStem(String(dash.props["db"] ?? "Food DB"));
  assert.ok(db && db.props["type"] === "sheet", "food DB sheet missing");
  const bases = parseFoodDb(db.body);
  assert.ok(bases.length >= 3, `food DB parsed only ${bases.length} rows`);
  assert.ok(
    new Set(bases.map((b) => b.per)).size >= 2,
    "demo should show more than one basis kind (100g/100ml/x)"
  );
});

test("Tasks dashboard builds a board over the demo task notes (SUB-868/870)", () => {
  const dash = byStem("Tasks");
  assert.ok(dash, "Dashboards/Tasks.md missing");
  // Fixed clock: the demo's `due`/`created`/`snoozed_until` dates are pinned,
  // so buckets, ages, staleness and the snooze must not drift with the wall
  // clock. Everything below is an exact expectation against that clock.
  const now = new Date(2026, 7, 1, 12);
  const taskNotes: NoteMeta[] = notes
    .filter((n) => n.props["type"] === "task")
    .map((n) => ({
      path: n.path,
      stem: n.stem,
      title: n.stem,
      folder: n.path.split("/").slice(0, -1).join("/"),
      props: n.props,
      updated_ms: 0,
      excerpt: "",
      sealed: false,
    }));
  assert.ok(taskNotes.length >= 5, `expected the demo task set, found ${taskNotes.length}`);

  const model = buildTasksDashboard(taskNotes, dash.props, now);
  assert.equal(model.config.staleDays, 21);
  assert.deepEqual(model.config.areas, ["Label", "Studio"]);
  // the v3 spine, in render order: Overdue, Due today, Now, then area groups.
  // The demo deliberately ships no due-today task — a due-today row can only be
  // produced by a generated date, which would defeat the fixed clock — so the
  // "today" section is absent and every other kind is present.
  assert.deepEqual(
    model.sections.map((s) => [s.kind, s.label]),
    [
      ["overdue", "Overdue"],
      ["now", "Now"],
      ["area", "Studio"],
    ]
  );
  assert.equal(model.total, 4);
  assert.equal(model.overdue, 2);
  assert.equal(model.dueToday, 0);
  assert.equal(model.nowCount, 1);
  for (const s of model.sections) assert.ok(s.rows.length > 0, `${s.label} section is empty`);

  const section = (kind: string) => model.sections.find((s) => s.kind === kind);

  // Ordering inside a section is due bucket, then priority, then age.
  // Both overdue rows share a bucket, and the low-priority one is the *more*
  // overdue of the two — so this pins priority above both due depth and age.
  const overdue = section("overdue");
  assert.deepEqual(
    overdue?.rows.map((r) => [r.title, r.priority, r.dueDays]),
    [
      ["Slow Bloom EP repress decision", "high", -5],
      ["Recalibrate the monitor room", "low", -8],
    ]
  );

  // the hand-picked Now pin lands in its own section, out of the area groups.
  // Its due is upcoming, not late: urgency only outranks the pin for overdue
  // and due-today rows.
  const nowSection = section("now");
  assert.deepEqual(
    nowSection?.rows.map((r) => [r.title, r.area, r.dueBucket, r.dueDays]),
    [["Chase Night Circuit master v3", "Label", "upcoming", 13]]
  );
  const areaSections = model.sections.filter((s) => s.kind === "area");
  assert.ok(
    areaSections.every((s) => s.rows.every((r) => !r.now)),
    "a pinned task must not also sit in its area section"
  );

  // the dateless note surfaces as the `undated` finding, not as age zero, and
  // it is the only row left in an area group
  assert.deepEqual(
    areaSections.flatMap((s) => s.rows).map((r) => [r.title, r.finding, r.ageDays]),
    [["Archive the granular sketch stems", "undated", null]]
  );

  // two demo tasks are stale past the 21-day threshold; a pinned row never
  // carries a finding even when it is old
  assert.deepEqual(
    model.sections.flatMap((s) => s.rows).filter((r) => r.stale).map((r) => r.title).sort(),
    ["Recalibrate the monitor room", "Slow Bloom EP repress decision"]
  );
  assert.equal(nowSection?.rows[0]?.finding, null);

  // the snoozed row is counted and parked in its own collapsed list, never in
  // a section; the `done` one is excluded outright
  assert.equal(model.snoozed, 1);
  assert.deepEqual(
    model.snoozedRows.map((r) => [r.title, r.snoozedUntil]),
    [["Fern Static sleeve brief", "2027-03-01"]]
  );
  const titles = new Set(model.sections.flatMap((s) => s.rows).map((r) => r.title));
  assert.ok(!titles.has("Send Night Circuit metadata sheet"), "a done task must stay off the board");
  assert.ok(!titles.has("Fern Static sleeve brief"), "a snoozed task must stay off the sections");
});

test("schema.json uses only real glyphs, tints, colors, and kinds", () => {
  const kinds = new Set(["text", "date", "file", "relation", "multi", "url", "email", "phone", "checkbox", "number"]);
  const tints = new Set<string>(ICON_TINTS);
  for (const [type, entry] of Object.entries(schema)) {
    for (const [key, val] of Object.entries(entry)) {
      if (key === "icon") {
        const icon = val as { glyph?: string; emoji?: string; tint?: string };
        if (icon.glyph) assert.ok(GLYPH_IDS.includes(icon.glyph), `${type}: unknown glyph "${icon.glyph}"`);
        if (icon.tint) assert.ok(tints.has(icon.tint), `${type}: unknown tint "${icon.tint}"`);
        continue;
      }
      if (key === "home") continue;
      const prop = val as { kind?: string; type?: string; options?: { value: string; color?: string }[] };
      if (prop.kind) assert.ok(kinds.has(prop.kind), `${type}.${key}: unknown kind "${prop.kind}"`);
      if (prop.kind === "relation")
        assert.ok(prop.type && dbTypes.has(prop.type), `${type}.${key}: relation to unknown type "${prop.type}"`);
      for (const o of prop.options ?? [])
        if (o.color) assert.ok(tints.has(o.color), `${type}.${key}: unknown option color "${o.color}"`);
    }
  }
});

test("wikilinks and relation values resolve inside the vault", () => {
  const targets = new Set(notes.map((n) => n.stem.toLowerCase()));
  for (const t of dbTypes) targets.add(t.toLowerCase()); // db-name links open the database
  for (const n of notes) {
    for (const [, link] of n.body.matchAll(/\[\[([^[\]]+)\]\]/g))
      assert.ok(targets.has(link.trim().toLowerCase()), `${n.path}: dangling wikilink [[${link}]]`);
    const contact = n.props["contact"];
    for (const v of typeof contact === "string" ? [contact] : (contact ?? []))
      assert.ok(targets.has(v.toLowerCase()), `${n.path}: relation names missing note "${v}"`);
  }
});
