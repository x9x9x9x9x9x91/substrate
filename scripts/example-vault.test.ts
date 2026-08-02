import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSheet, findSummary, parseSheet } from "../src/lib/sheet.ts";
import { isErr, type FxResolver } from "../src/lib/formula.ts";
import { parseChartBlocks } from "../src/lib/chart.ts";
import { parseHub } from "../src/lib/hub.ts";
import { parseViewSpec } from "../src/lib/embeds.ts";
import { parseFoodRows } from "../src/lib/food.ts";
import { parseFoodDb } from "../src/lib/fooddb.ts";
import { isOpenableUrl, parseFeedItems } from "../src/lib/feed.ts";
import { parseSnapshotsFromBody } from "../src/lib/dashboard.ts";
import { GLYPH_IDS, ICON_TINTS } from "../src/lib/dbicons.ts";

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
      // AGENTS.md is the seeded agent orientation file (SUB-474), a real note
      // to the engine but a plain-prose one — no frontmatter, no type, nothing
      // for the demo parsers below to check.
      if (e.name === "AGENTS.md") continue;
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
    ["setup-skill.md", ".claude/skills/setup/SKILL.md"],
  ]) {
    assert.equal(
      readFileSync(join(VAULT, dst), "utf8"),
      readFileSync(join(seed, src), "utf8"),
      `${dst} has drifted from the seed the app writes`
    );
  }
});

test("the seed's documented view example parses to the keys it claims (SUB-474)", () => {
  const seed = readFileSync(
    fileURLToPath(new URL("../src-tauri/src/seed/AGENTS.md", import.meta.url)),
    "utf8"
  );
  // Link tokens are safe to spell out now, but only inside code (SUB-495):
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
  assert.deepEqual(spec, { type: "release", query: "status:unreleased", view: "table" });
});

test("dashboard kinds are ones the app dispatches", () => {
  const kinds = new Set(["metrics", "yield-apr", "sync", "music", "hub", "food", "coding", "feed", "music-work", "charts"]);
  const dashboards = notes.filter((n) => n.props["type"] === "dashboard");
  assert.equal(dashboards.length, 8);
  for (const n of dashboards) {
    const k = n.props["dashboard"];
    assert.ok(typeof k === "string" && kinds.has(k), `${n.path}: unknown dashboard kind "${k}"`);
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

test("Release Charts fences parse clean and name real sources", () => {
  const n = byStem("Release Charts");
  assert.ok(n, "Dashboards/Release Charts.md missing");
  const blocks = parseChartBlocks(n.body);
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    assert.equal(b.error, null, `chart fence error: ${b.error}`);
    assert.ok(b.config, "chart fence produced no config");
    const src = b.config.source;
    if (src.kind === "db") assert.ok(dbTypes.has(src.type), `chart over unknown database "${src.type}"`);
    else assert.ok(loadSheet(src.name), `chart over unknown sheet "${src.name}"`);
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

test("Yield snapshots parse in order", () => {
  const n = byStem("Yield");
  assert.ok(n, "Dashboards/Yield.md missing");
  const { snapshots } = parseSnapshotsFromBody(n.body);
  assert.equal(snapshots.length, 4);
  for (const s of snapshots) assert.ok(isFinite(s.yieldUsd) && isFinite(s.principalUsd));
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
