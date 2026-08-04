import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collect,
  crossCheck,
  parseBuiltInKinds,
  parseDispatch,
  parseDocKinds,
  parseGlyphIds,
  parseIcons,
  stripFlags,
  STRIP_START,
  STRIP_END,
  ICON_EXEMPT,
  RESERVED_KINDS,
  type Inventories,
} from "./check-kinds.ts";

/* ── strip regions ──────────────────────────────────────────────────────── */

test("stripFlags marks the region, the markers included", () => {
  const src = ["a", `// ${STRIP_START}`, "b", `// ${STRIP_END}`, "c"].join("\n");
  const f = stripFlags(src);
  assert.equal(f[src.indexOf("a")], false);
  assert.equal(f[src.indexOf("b")], true);
  assert.equal(f[src.indexOf("c")], false);
  // the marker lines themselves are dropped by share-mirror.sh too
  assert.equal(f[src.indexOf(`// ${STRIP_START}`)], true);
  assert.equal(f[src.indexOf(`// ${STRIP_END}`)], true);
});

test("stripFlags reads the markdown comment spelling the same way", () => {
  const src = [`<!-- ${STRIP_START} -->`, "x", `<!-- ${STRIP_END} -->`, "y"].join("\n");
  const f = stripFlags(src);
  assert.equal(f[src.indexOf("x")], true);
  assert.equal(f[src.indexOf("y")], false);
});

test("stripFlags throws on unbalanced or nested markers, never guesses", () => {
  assert.throws(() => stripFlags(`// ${STRIP_START}\nx`), /unterminated/);
  assert.throws(() => stripFlags(`x\n// ${STRIP_END}`), /without a start/);
  assert.throws(
    () => stripFlags(`// ${STRIP_START}\n// ${STRIP_START}\nx\n// ${STRIP_END}`),
    /nested/
  );
});

/* ── BUILT_IN_KINDS ─────────────────────────────────────────────────────── */

const KINDS_SRC = `
export const BUILT_IN_KINDS: ReadonlySet<string> = new Set([
  "metrics",
  // ${STRIP_START}
  "ledger",
  // ${STRIP_END}
  // reserved, never dispatched
  "charts",
]);
`;

test("parseBuiltInKinds reads names and their privacy", () => {
  const got = parseBuiltInKinds(KINDS_SRC, "t");
  assert.deepEqual([...got], [["metrics", false], ["ledger", true], ["charts", false]]);
});

test("parseBuiltInKinds throws rather than skipping what it cannot read", () => {
  assert.throws(() => parseBuiltInKinds("export const OTHER = 1;", "t"), /not found/);
  assert.throws(
    () => parseBuiltInKinds('export const BUILT_IN_KINDS = new Set([\n  ...OTHERS,\n]);', "t"),
    /unparseable/
  );
  assert.throws(
    () => parseBuiltInKinds('export const BUILT_IN_KINDS = new Set([\n  "a",\n  "a",\n]);', "t"),
    /listed twice/
  );
  assert.throws(() => parseBuiltInKinds("export const BUILT_IN_KINDS = new Set([]);", "t"), /empty/);
});

/* ── the dispatch chain ─────────────────────────────────────────────────── */

const PANE_SRC = `
function DashboardBody(props: DashboardPaneProps) {
  const kind = propStr(props.meta.props, "dashboard");
  if (kind === "metrics") return <MetricsDashboard {...props} />;
  // ${STRIP_START}
  if (kind === "ledger") return <LedgerDashboard {...props} />;
  // ${STRIP_END}
  return <ChartOrYield {...props} />;
}

function Other() {
  if (kind === "nope") return <Nope {...props} />;
}
`;

test("parseDispatch reads the branches, their components and the fallback", () => {
  const got = parseDispatch(PANE_SRC, "t");
  assert.deepEqual(got.kinds.get("metrics"), { component: "MetricsDashboard", private: false });
  assert.deepEqual(got.kinds.get("ledger"), { component: "LedgerDashboard", private: true });
  assert.equal(got.fallback, "ChartOrYield");
  // the block ends at the first column-0 }, so a later function is not read in
  assert.equal(got.kinds.has("nope"), false);
});

test("parseDispatch throws on a branch shape it does not understand", () => {
  assert.throws(
    () => parseDispatch(PANE_SRC.replace('kind === "ledger"', "kind === KINDS.ledger"), "t"),
    /unparseable dispatch branch/
  );
  assert.throws(
    () => parseDispatch(PANE_SRC.replace('if (kind === "ledger")', 'if (kind === "metrics")'), "t"),
    /dispatched twice/
  );
  assert.throws(() => parseDispatch(PANE_SRC.replace("return <ChartOrYield {...props} />;", ""), "t"), /fallback/);
  assert.throws(() => parseDispatch("function Nope() {\n}\n", "t"), /not found/);
});

/* ── icons ──────────────────────────────────────────────────────────────── */

const ICONS_SRC = `
export const GLYPHS: Record<string, readonly string[]> = {
  flame: ["M1 1"],
  "check-square": ["M1 1"],
  refresh: ["M1 1"],
  nested: [{ a: 1 }],
};

const DASHBOARD_ICONS: Record<string, DbIcon> = {
  food: { glyph: "flame" },
  // ${STRIP_START}
  ledger: { glyph: "refresh" },
  // ${STRIP_END}
  "music-work": { glyph: "check-square" },
};
`;

test("parseIcons reads quoted and bare keys, glyphs, and privacy", () => {
  const got = parseIcons(ICONS_SRC, "t");
  assert.deepEqual(got.get("food"), { glyph: "flame", private: false });
  assert.deepEqual(got.get("ledger"), { glyph: "refresh", private: true });
  assert.deepEqual(got.get("music-work"), { glyph: "check-square", private: false });
});

test("parseGlyphIds reads the top-level keys only", () => {
  const got = parseGlyphIds(ICONS_SRC, "t");
  assert.deepEqual([...got].sort(), ["check-square", "flame", "nested", "refresh"]);
});

test("parseIcons throws on an entry shape it does not understand", () => {
  assert.throws(() => parseIcons(ICONS_SRC.replace('{ glyph: "flame" }', "FLAME"), "t"), /unparseable/);
  assert.throws(() => parseIcons(ICONS_SRC.replace("  food:", "  ledger:"), "t"), /mapped twice/);
});

/* ── doc lists ──────────────────────────────────────────────────────────── */

const DOC = `
prose mentioning \`metrics\` in passing.

only these are dispatched: \`metrics\` → the cards; \`hub\` → the hub.
<!-- ${STRIP_START} -->
Builds that carry them add \`ledger\` → the ledger pane.
<!-- ${STRIP_END} -->
**Any other key, or a missing prop, looks at the body.**
`;

test("parseDocKinds arrow mode takes only the names an arrow follows", () => {
  const got = parseDocKinds(DOC, {
    label: "t",
    start: "only these are dispatched:",
    end: "**Any other key",
    mode: "arrow",
  });
  assert.deepEqual([...got], [["metrics", false], ["hub", false], ["ledger", true]]);
});

test("parseDocKinds list mode takes every backticked name in the region", () => {
  const got = parseDocKinds("names: `a`, `b` and `c`. END", {
    label: "t",
    start: "names:",
    end: "END",
    mode: "list",
  });
  assert.deepEqual([...got.keys()], ["a", "b", "c"]);
});

test("parseDocKinds throws when the prose it anchors on was reworded", () => {
  const o = { label: "t", start: "only these are dispatched:", end: "**Any other key", mode: "arrow" } as const;
  assert.throws(() => parseDocKinds(DOC.replace("only these are dispatched:", "these ship:"), o), /anchor/);
  assert.throws(() => parseDocKinds(DOC.replace("**Any other key", "**Anything else"), o), /closing anchor/);
  assert.throws(() => parseDocKinds("only these are dispatched: none.\n**Any other key", o), /empty/);
});

/* ── cross-check ────────────────────────────────────────────────────────── */

/** A tiny five-inventory tree that agrees with itself. */
function agreeing(): Inventories {
  return {
    builtIn: new Map([["metrics", false], ["ledger", true], ["charts", false]]),
    dispatch: {
      kinds: new Map([
        ["metrics", { component: "MetricsDashboard", private: false }],
        ["ledger", { component: "LedgerDashboard", private: true }],
      ]),
      fallback: "ChartOrYield",
    },
    icons: new Map([
      ["metrics", { glyph: "wallet", private: false }],
      ["ledger", { glyph: "refresh", private: true }],
    ]),
    glyphIds: new Set(["wallet", "refresh"]),
    // the published tables carry the reserved name too; the icon list does not
    formatDispatch: new Map([["metrics", false], ["ledger", true], ["charts", false]]),
    formatIcons: new Map([["metrics", false], ["ledger", true]]),
    seedAgents: new Map([["metrics", false], ["charts", false]]),
  };
}

/** The problems a mutated tree reports, as one string to match against. */
function problemsOf(mutate: (inv: Inventories) => void): string {
  const inv = agreeing();
  mutate(inv);
  const problems = crossCheck(inv);
  assert.ok(problems.length > 0, "expected at least one problem");
  return problems.join("\n");
}

test("crossCheck: a self-consistent tree reports nothing", () => {
  assert.deepEqual(crossCheck(agreeing()), []);
});

test("crossCheck: a dispatched kind missing from BUILT_IN_KINDS is a shadowing hole", () => {
  const out = problemsOf((inv) => inv.builtIn.delete("ledger"));
  assert.match(out, /BUILT_IN_KINDS omits it/);
  assert.match(out, /shadow a built-in that writes vault state/);
});

test("crossCheck: a built-in nothing dispatches names the escape hatch", () => {
  const out = problemsOf((inv) => inv.dispatch.kinds.delete("ledger"));
  assert.match(out, /never dispatches it/);
  assert.match(out, /RESERVED_KINDS/);
});

test("crossCheck: the reserved name must be a built-in and must not be dispatched", () => {
  assert.match(problemsOf((inv) => inv.builtIn.delete("charts")), /reserved kind "charts" is missing/);
  const dispatched = problemsOf((inv) => {
    inv.dispatch.kinds.set("charts", { component: "ChartsDashboard", private: false });
    inv.formatDispatch.set("charts", false);
    inv.seedAgents.set("charts", false);
    inv.icons.set("charts", { glyph: "wallet", private: false });
    inv.formatIcons.set("charts", false);
  });
  assert.match(dispatched, /"charts" is reserved/);
  assert.match(dispatched, /ChartOrYield/);
});

test("crossCheck: the reserved name is still a documented value in both tables", () => {
  // `dashboard: charts` works, so the contract has to say so — that it reaches
  // the renderer through the fallback rather than a branch is internal.
  assert.match(problemsOf((inv) => inv.formatDispatch.delete("charts")), /dispatch table: missing "charts"/);
  assert.match(problemsOf((inv) => inv.seedAgents.delete("charts")), /AGENTS\.md: missing "charts"/);
  // but it owns no sidebar row, so a mark for it is still a dead entry
  assert.match(
    problemsOf((inv) => inv.icons.set("charts", { glyph: "wallet", private: false })),
    /"charts", which nothing dispatches — dead entry/
  );
});

test("crossCheck: a kind without a curated mark is caught, and the opt-out is named", () => {
  const out = problemsOf((inv) => {
    inv.icons.delete("ledger");
    inv.formatIcons.delete("ledger");
  });
  assert.match(out, /has no DASHBOARD_ICONS entry/);
  assert.match(out, /generic\s+chart glyph/);
  assert.match(out, /ICON_EXEMPT/);
});

test("crossCheck: a mark for a kind nothing dispatches, or on an unknown glyph", () => {
  assert.match(
    problemsOf((inv) => {
      inv.icons.set("gone", { glyph: "wallet", private: false });
      inv.formatIcons.set("gone", false);
    }),
    /which nothing dispatches — dead entry/
  );
  assert.match(
    problemsOf((inv) => inv.icons.set("ledger", { glyph: "nope", private: true })),
    /glyph "nope", which GLYPHS does not define/
  );
});

test("crossCheck: privacy that disagrees between two files is drift, not a detail", () => {
  assert.match(
    problemsOf((inv) => inv.dispatch.kinds.set("ledger", { component: "LedgerDashboard", private: false })),
    /the strip regions disagree/
  );
  assert.match(
    problemsOf((inv) => inv.icons.set("ledger", { glyph: "refresh", private: false })),
    /the strip regions disagree/
  );
  const leak = problemsOf((inv) => inv.formatDispatch.set("ledger", false));
  assert.match(leak, /the mirror would leak it/);
});

test("crossCheck: both doc lists are held to what the code actually does", () => {
  assert.match(problemsOf((inv) => inv.formatDispatch.delete("metrics")), /dispatch table: missing "metrics"/);
  assert.match(problemsOf((inv) => inv.formatDispatch.set("ghost", false)), /which is not there/);
  assert.match(problemsOf((inv) => inv.formatIcons.delete("metrics")), /icon list: missing "metrics"/);
});

test("crossCheck: the seeded AGENTS.md is held to the PUBLIC kinds, and only those", () => {
  // it carries no strip regions, so a private name there would ship as-is
  const leak = problemsOf((inv) => inv.seedAgents.set("ledger", false));
  assert.match(leak, /names the private kind "ledger"/);
  assert.match(leak, /no strip region, so the name would leak/);
  // and a public kind it forgets is still drift
  assert.match(problemsOf((inv) => inv.seedAgents.delete("metrics")), /AGENTS\.md: missing "metrics"/);
});

test("crossCheck: ICON_EXEMPT is itself checked, so a stale opt-out cannot linger", () => {
  // nothing is exempt today; the machinery is verified against a stand-in
  assert.equal(ICON_EXEMPT.size, 0);
  assert.deepEqual([...RESERVED_KINDS], ["charts"]);
});

/* ── the real tree ──────────────────────────────────────────────────────── */
// This is how the check reaches CI: `npm test` already runs scripts/*.test.ts,
// so the drift check rides the existing unit-tests job with no CI edit.

test("the checked-in tree parses and its five kind inventories agree", () => {
  const inv = collect();
  assert.ok(inv.builtIn.size >= 7, "BUILT_IN_KINDS parsed");
  assert.ok(inv.dispatch.kinds.size >= 6, "the dispatch chain parsed");
  assert.ok(inv.glyphIds.size >= 20, "GLYPHS parsed");
  const problems = crossCheck(inv);
  assert.equal(
    problems.length,
    0,
    `dashboard-kind inventories drifted — run \`npm run check:kinds\`:\n  • ${problems.join("\n  • ")}`
  );
});
