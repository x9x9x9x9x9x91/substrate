import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PANE_CONTROLS,
  collect,
  componentFile,
  crossCheck,
  paneSource,
  parsePaneControls,
  parseTipSelectors,
  rendersClass,
  selectorClasses,
  tipsByClass,
  type Inventories,
} from "./check-infotips.ts";
import { STRIP_START, STRIP_END } from "./check-kinds.ts";

/* ── the registry ───────────────────────────────────────────────────────── */

const TIPS_SRC = [
  "export const TIPS: TipEntry[] = [",
  '  { selector: ".alpha", tip: { title: "A", body: "b" } },',
  "  {",
  '    selector: ".beta, .beta-inner",',
  "    tip: { title: 'B', body: 'b' },",
  "  },",
  "  {",
  `    selector: '.note-tool[aria-label="History"]',`,
  "  },",
  `  // ${STRIP_START}`,
  "  {",
  '    selector: ".secret-row",',
  "  },",
  `  // ${STRIP_END}`,
  "];",
].join("\n");

test("tip selectors are parsed with their privacy, in both quote styles", () => {
  const entries = parseTipSelectors(TIPS_SRC, "fixture");
  assert.deepEqual(
    entries.map((e) => e.selector),
    [".beta, .beta-inner", '.note-tool[aria-label="History"]', ".secret-row"]
  );
  assert.deepEqual(
    entries.map((e) => e.private),
    [false, false, true]
  );
});

test("a registry with no parseable selector throws rather than reporting full coverage", () => {
  assert.throws(() => parseTipSelectors("export const TIPS = [];", "fixture"), /no tip selectors/);
});

test("a selector's class names are read from every part of it", () => {
  assert.deepEqual(selectorClasses(".a, .b"), ["a", "b"]);
  assert.deepEqual(selectorClasses(".assets .trash-danger"), ["assets", "trash-danger"]);
  assert.deepEqual(selectorClasses(".db-switch button"), ["db-switch"]);
  assert.deepEqual(selectorClasses('.note-tool[aria-label="History"]'), ["note-tool"]);
});

test("classes index every entry that names them", () => {
  const byClass = tipsByClass(parseTipSelectors(TIPS_SRC, "fixture"));
  assert.equal(byClass.get("beta-inner")?.length, 1);
  assert.equal(byClass.get("secret-row")?.[0].private, true);
  assert.equal(byClass.get("nothing-here"), undefined);
});

/* ── the declaration ────────────────────────────────────────────────────── */

const CONTROLS_SRC = [
  "export const PANE_CONTROLS: ReadonlyMap<string, readonly string[]> = new Map([",
  '  ["food", ["food-del", "food-daynav-btn"]],',
  `  // ${STRIP_START}`,
  '  ["ledger", ["ledger-row"]],',
  `  // ${STRIP_END}`,
  "]);",
].join("\n");

test("the declaration is parsed with its controls and its privacy", () => {
  const parsed = parsePaneControls(CONTROLS_SRC, "fixture");
  assert.deepEqual(parsed.get("food"), { classes: ["food-del", "food-daynav-btn"], private: false });
  assert.deepEqual(parsed.get("ledger"), { classes: ["ledger-row"], private: true });
});

test("a moved, doubled or empty declaration throws", () => {
  assert.throws(() => parsePaneControls("const OTHER = new Map([]);", "fixture"), /not found/);
  assert.throws(
    () =>
      parsePaneControls(
        ["export const PANE_CONTROLS = new Map([", '  ["food", ["a"]],', '  ["food", ["b"]],', "]);"].join("\n"),
        "fixture"
      ),
    /declared twice/
  );
  assert.throws(
    () => parsePaneControls(["export const PANE_CONTROLS = new Map([", '  ["food", []],', "]);"].join("\n"), "fixture"),
    /declares no controls/
  );
});

/* ── what a pane renders ────────────────────────────────────────────────── */

test("a component is located by its own file, or by the file that declares it", () => {
  const files = ["src/components/FoodDashboard.tsx", "src/components/DashboardPane.tsx"];
  const read = (p: string) =>
    p.endsWith("DashboardPane.tsx") ? "function YieldDashboard({\n" : "export default function FoodDashboard() {\n";
  assert.equal(componentFile("FoodDashboard", files, read), "src/components/FoodDashboard.tsx");
  assert.equal(componentFile("YieldDashboard", files, read), "src/components/DashboardPane.tsx");
  assert.throws(() => componentFile("GhostDashboard", files, read), /no component file declares/);
});

test("a pane's markup includes the siblings it renders, and nothing further", () => {
  const files = [
    "src/components/MetricsDashboard.tsx",
    "src/components/MetricCards.tsx",
    "src/components/Sidebar.tsx",
  ];
  const bodies: Record<string, string> = {
    "src/components/MetricsDashboard.tsx": 'import { MetricCardStrip } from "./MetricCards";\nconst x = 1;',
    "src/components/MetricCards.tsx": '<div className="metrics-strip">',
    "src/components/Sidebar.tsx": '<div className="side-item">',
  };
  const src = paneSource("src/components/MetricsDashboard.tsx", files, (p) => bodies[p]);
  assert.ok(rendersClass(src, "metrics-strip"), "the sibling's markup is in scope");
  assert.ok(!rendersClass(src, "side-item"), "an unrelated component's markup is not");
});

test("a class matches on its whole name, not as a prefix of a longer one", () => {
  assert.ok(rendersClass('className="tasks-check"', "tasks-check"));
  assert.ok(!rendersClass('className="tasks-checklist"', "tasks-check"));
  // a hyphen is part of the name, not a boundary: these names are built by
  // suffixing, so a file left holding only the error variant is a rename
  assert.ok(!rendersClass('<div className="sync-row-err">', "sync-row"));
  assert.ok(rendersClass('<section className={`sync-row${paused ? " is-paused" : ""}`}>', "sync-row"));
});

/* ── the cross-check ────────────────────────────────────────────────────── */

const inventories = (over: Partial<Inventories> = {}): Inventories => ({
  builtIn: new Map([
    ["food", false],
    ["ledger", true],
  ]),
  declared: new Map([
    ["food", { classes: ["food-del"], private: false }],
    ["ledger", { classes: ["ledger-row"], private: true }],
  ]),
  tips: [
    { selector: ".food-del", private: false },
    { selector: ".ledger-row", private: true },
  ],
  paneSources: new Map([
    ["food", '<button className="food-del">'],
    ["ledger", '<div className="ledger-row">'],
  ]),
  ...over,
});

test("a tree where every kind has its own tips reports nothing", () => {
  assert.deepEqual(crossCheck(inventories()), []);
});

test("a kind with no declared controls is named", () => {
  const inv = inventories();
  inv.builtIn.set("feed", false);
  assert.match(crossCheck(inv).join("\n"), /"feed" is a built-in dashboard kind with no PANE_CONTROLS entry/);
});

test("a declared control with no tip is named", () => {
  const inv = inventories({ tips: [{ selector: ".ledger-row", private: true }] });
  assert.match(crossCheck(inv).join("\n"), /"food" has no infotip entry for "\.food-del"/);
});

test("a control the pane stopped rendering is named", () => {
  const inv = inventories();
  inv.paneSources.set("food", '<button className="food-delete">');
  assert.match(crossCheck(inv).join("\n"), /"food" declares the control "\.food-del", which its pane no longer renders/);
});

test("a private pane whose tip ships to the mirror is named, and so is the reverse", () => {
  const leaking = inventories({
    tips: [
      { selector: ".food-del", private: false },
      { selector: ".ledger-row", private: false },
    ],
  });
  assert.match(crossCheck(leaking).join("\n"), /the tip for "\.ledger-row" is outside a strip region, but "ledger" is private/);

  const stranded = inventories({
    tips: [
      { selector: ".food-del", private: true },
      { selector: ".ledger-row", private: true },
    ],
  });
  assert.match(crossCheck(stranded).join("\n"), /the tip for "\.food-del" is inside a strip region, but "food" is public/);
});

test("privacy declared against the kind's own flag is compared too", () => {
  const inv = inventories();
  inv.declared.set("ledger", { classes: ["ledger-row"], private: false });
  assert.match(crossCheck(inv).join("\n"), /"ledger" is private in BUILT_IN_KINDS but public in PANE_CONTROLS/);
});

test("a declaration for a kind that no longer exists is named", () => {
  const inv = inventories();
  inv.declared.set("vintage", { classes: ["vintage-row"], private: false });
  assert.match(crossCheck(inv).join("\n"), /PANE_CONTROLS names "vintage", which is not a built-in dashboard kind/);
});

/* ── the real tree ──────────────────────────────────────────────────────── */

test("every dashboard kind in this tree has tips of its own", () => {
  const inv = collect();
  assert.ok(inv.builtIn.size >= 7, "BUILT_IN_KINDS parsed");
  assert.ok(inv.tips.length >= 100, "the registry parsed");
  assert.equal(inv.declared.size, PANE_CONTROLS.size, "the declaration parsed");
  const problems = crossCheck(inv);
  assert.equal(
    problems.length,
    0,
    `dashboard infotip coverage drifted — run \`npm run check:infotips\`:\n  • ${problems.join("\n  • ")}`
  );
});
