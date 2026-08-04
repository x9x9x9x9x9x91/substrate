import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOrder,
  buildFolderTree,
  dashboardsHome,
  dashTreeFolder,
  mergeGroupOrder,
  migrateOrderId,
  moveId,
  orderedRootNodes,
  orderedSiblingFolders,
  pinTreeFolder,
  reorderIds,
  splitDashboards,
  splitPins,
} from "./sidebar.ts";

test("buildFolderTree nests paths and sorts siblings", () => {
  const tree = buildFolderTree(["Projects/Active", "Inbox", "Projects/Archive", "A"]);
  assert.deepEqual(
    tree.map((n) => n.name),
    ["A", "Inbox", "Projects"]
  );
  const projects = tree.find((n) => n.name === "Projects")!;
  assert.equal(projects.path, "Projects");
  assert.deepEqual(
    projects.children.map((n) => n.path),
    ["Projects/Active", "Projects/Archive"]
  );
});

test("buildFolderTree fills in missing ancestors", () => {
  const tree = buildFolderTree(["Projects/Active/Deep"]);
  const p = tree[0];
  assert.equal(p.path, "Projects");
  assert.equal(p.children[0].path, "Projects/Active");
  assert.equal(p.children[0].children[0].path, "Projects/Active/Deep");
});

test("applyOrder: stored order first, unknowns appended, stale ids dropped", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const out = applyOrder(items, ["c", "gone", "a"], (t) => t.id);
  assert.deepEqual(out.map((t) => t.id), ["c", "a", "b", "d"]);
  // empty stored order = incoming order untouched
  assert.deepEqual(applyOrder(items, [], (t) => t.id).map((t) => t.id), ["a", "b", "c", "d"]);
});

test("reorderIds moves before/after target and self-drop is stable", () => {
  assert.deepEqual(reorderIds(["a", "b", "c"], "a", "c", false), ["b", "a", "c"]);
  assert.deepEqual(reorderIds(["a", "b", "c"], "c", "a", false), ["c", "a", "b"]);
  assert.deepEqual(reorderIds(["a", "b", "c"], "b", "b", false), ["a", "b", "c"]);
  assert.deepEqual(reorderIds(["a", "b", "c"], "a", "c", true), ["b", "c", "a"]);
  // unknown target → appended at the end
  assert.deepEqual(reorderIds(["a", "b"], "a", "zzz", false), ["b", "a"]);
});

test("migrateOrderId retargets a moved id in place, keeping its position", () => {
  const order = ["Dashboards/Coding.md", "Dashboards/Overview.md", "Dashboards/Sync.md"];
  // SUB-466 finding 3: the moved dashboard keeps its slot instead of being
  // dropped by applyOrder and re-appearing at the end of the lane
  assert.deepEqual(
    migrateOrderId(order, "Dashboards/Overview.md", "Dashboards/Releases/Overview.md"),
    ["Dashboards/Coding.md", "Dashboards/Releases/Overview.md", "Dashboards/Sync.md"]
  );

  // untouched (same array back) when the moved id isn't listed, or is a no-op
  assert.equal(migrateOrderId(order, "Dashboards/Nope.md", "Other/Nope.md"), order);
  assert.equal(migrateOrderId(order, "Dashboards/Sync.md", "Dashboards/Sync.md"), order);
  assert.equal(migrateOrderId([], "a", "b").length, 0);

  // a move onto a path already in the list collapses rather than duplicating
  assert.deepEqual(migrateOrderId(["a", "b", "c"], "c", "a"), ["a", "b"]);

  // end to end: the retargeted order survives applyOrder → splitDashboards
  const moved = [
    { path: "Dashboards/Coding.md" },
    { path: "Dashboards/Releases/Overview.md" },
    { path: "Dashboards/Sync.md" },
  ];
  const next = migrateOrderId(order, "Dashboards/Overview.md", "Dashboards/Releases/Overview.md");
  const ordered = applyOrder(moved, next, (d) => d.path);
  assert.deepEqual(paths(ordered), next);
  const { flat, groups } = splitDashboards(ordered);
  assert.deepEqual(paths(flat), ["Dashboards/Coding.md", "Dashboards/Sync.md"]);
  assert.deepEqual(paths(groups[0].items), ["Dashboards/Releases/Overview.md"]);
});

test("moveId swaps one slot, edges and unknown ids are stable", () => {
  assert.deepEqual(moveId(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveId(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.deepEqual(moveId(["a", "b", "c"], "a", -1), ["a", "b", "c"], "top edge");
  assert.deepEqual(moveId(["a", "b", "c"], "c", 1), ["a", "b", "c"], "bottom edge");
  assert.deepEqual(moveId(["a", "b", "c"], "zzz", 1), ["a", "b", "c"], "unknown id");
});

/* ----- SUB-466: Dashboards subfolder grouping ----- */

const paths = (items: { path: string }[]) => items.map((d) => d.path);

test("splitDashboards splits flat rows from one-level subfolder groups", () => {
  const { home, flat, groups } = splitDashboards([
    { path: "Dashboards/Overview.md" },
    { path: "Dashboards/Releases/Label Accounting.md" },
    { path: "Dashboards/Sync.md" },
    { path: "Dashboards/Releases/Royalties.md" },
    { path: "Dashboards/Music/Downloader.md" },
  ]);
  assert.equal(home, "Dashboards");
  assert.deepEqual(paths(flat), ["Dashboards/Overview.md", "Dashboards/Sync.md"]);
  assert.deepEqual(
    groups.map((g) => [g.folder, g.name, paths(g.items)]),
    [
      ["Dashboards/Releases", "Releases", ["Dashboards/Releases/Label Accounting.md", "Dashboards/Releases/Royalties.md"]],
      ["Dashboards/Music", "Music", ["Dashboards/Music/Downloader.md"]],
    ]
  );
});

// SUB-466 review finding 2: home used to be the folder with the most DIRECT
// dashboards, so moving the second dashboard into a subfolder flipped home to
// that subfolder and the group the user had just created vanished. Home is now
// scored descendant-inclusive, so these four probe cases all keep their groups.
test("splitDashboards: home is descendant-scored — a growing subfolder can't steal it", () => {
  // case A — 2 in Dashboards, 1 in Dashboards/Releases (was already correct)
  const a = splitDashboards([
    { path: "Dashboards/Overview.md" },
    { path: "Dashboards/Sync.md" },
    { path: "Dashboards/Releases/Label.md" },
  ]);
  assert.equal(a.home, "Dashboards");
  assert.deepEqual(
    a.groups.map((g) => g.folder),
    ["Dashboards/Releases"]
  );

  // case B — 1 in Dashboards, 2 in Dashboards/Releases. Home used to flip to
  // the subfolder and flatten all three rows; it must stay Dashboards with the
  // Releases group VISIBLE
  const b = splitDashboards([
    { path: "Dashboards/Overview.md" },
    { path: "Dashboards/Releases/Label.md" },
    { path: "Dashboards/Releases/Royalties.md" },
  ]);
  assert.equal(b.home, "Dashboards");
  assert.deepEqual(paths(b.flat), ["Dashboards/Overview.md"]);
  assert.deepEqual(
    b.groups.map((g) => [g.folder, paths(g.items)]),
    [["Dashboards/Releases", ["Dashboards/Releases/Label.md", "Dashboards/Releases/Royalties.md"]]]
  );

  // case C — 1 in Dashboards/Music, 1 in Dashboards/Releases, nothing directly
  // in Dashboards. Home used to land on Music by alphabetical tiebreak and
  // neither grouped; the shared parent now scores 2 and BOTH group under it
  const c = splitDashboards([
    { path: "Dashboards/Music/Downloader.md" },
    { path: "Dashboards/Releases/Label.md" },
  ]);
  assert.equal(c.home, "Dashboards");
  assert.deepEqual(paths(c.flat), []);
  assert.deepEqual(
    c.groups.map((g) => [g.folder, paths(g.items)]),
    [
      ["Dashboards/Music", ["Dashboards/Music/Downloader.md"]],
      ["Dashboards/Releases", ["Dashboards/Releases/Label.md"]],
    ]
  );

  // case D — 1 in Dashboards, 1 in Dashboards/Releases, 2 in Finance. The
  // Dashboards tree scores 2 as well, and the depth tiebreak is a wash, so
  // Dashboards wins alphabetically and still groups Releases. Finance's two sit
  // OUTSIDE home, so SUB-605 hands them to the folder tree instead of the
  // section's flat list (pre-SUB-605 they rendered flat under Dashboards)
  const d = splitDashboards([
    { path: "Dashboards/Overview.md" },
    { path: "Dashboards/Releases/Label.md" },
    { path: "Finance/Ledger.md" },
    { path: "Finance/Taxes.md" },
  ]);
  assert.equal(d.home, "Dashboards");
  assert.deepEqual(paths(d.flat), ["Dashboards/Overview.md"]);
  assert.deepEqual(
    d.groups.map((g) => g.folder),
    ["Dashboards/Releases"]
  );
  assert.deepEqual(
    [...d.byFolder].map(([f, items]) => [f, paths(items)]),
    [["Finance", ["Finance/Ledger.md", "Finance/Taxes.md"]]]
  );
});

test("splitDashboards: deeper nesting collapses into the first segment's group", () => {
  const { groups } = splitDashboards([
    { path: "Dashboards/A.md" },
    { path: "Dashboards/Label/Deep/Nested.md" },
    { path: "Dashboards/Label/Direct.md" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].folder, "Dashboards/Label");
  assert.deepEqual(paths(groups[0].items), [
    "Dashboards/Label/Deep/Nested.md",
    "Dashboards/Label/Direct.md",
  ]);
});

test("splitDashboards: a dashboard outside the home folder goes to the tree (SUB-605)", () => {
  // the home folder is the one holding the most dashboards — a stray elsewhere
  // must not re-root everybody into groups. SUB-605: that stray now surfaces
  // under its own folder's tree row instead of in the Dashboards section
  const { home, flat, groups, byFolder } = splitDashboards([
    { path: "Dashboards/Overview.md" },
    { path: "Dashboards/Sync.md" },
    { path: "Finance/Ledger Dash.md" },
  ]);
  assert.equal(home, "Dashboards");
  assert.deepEqual(paths(flat), ["Dashboards/Overview.md", "Dashboards/Sync.md"]);
  assert.deepEqual(groups, []);
  assert.deepEqual(
    [...byFolder].map(([f, items]) => [f, paths(items)]),
    [["Finance", ["Finance/Ledger Dash.md"]]]
  );
});

test("splitDashboards: with home at the vault root, foldered ones go to the tree", () => {
  // home lands on "" only when dashboards actually sit at the vault root, and
  // the root has no tree row — so the root-level ones are the section's flat
  // rows and every foldered one belongs to its own folder's tree row (SUB-605;
  // pre-SUB-605 Releases/ rendered as a section subfolder GROUP instead)
  const { home, flat, groups, byFolder } = splitDashboards([
    { path: "Overview.md" },
    { path: "Releases/Label.md" },
  ]);
  assert.equal(home, "");
  assert.deepEqual(paths(flat), ["Overview.md"]);
  assert.deepEqual(groups, []);
  assert.deepEqual(
    [...byFolder].map(([f, items]) => [f, paths(items)]),
    [["Releases", ["Releases/Label.md"]]]
  );
});

test("splitDashboards: empty input and all-in-one-subfolder are stable", () => {
  assert.deepEqual(splitDashboards([]), {
    home: "",
    flat: [],
    groups: [],
    byFolder: new Map(),
  });
  // every dashboard in one subfolder: parent and subfolder score the same, so
  // the shallower parent takes home and the subfolder renders as one group.
  // (Before finding 2's fix home was the subfolder itself and both rows went
  // flat — stable only until a dashboard appeared beside them in the parent.)
  const { home, flat, groups } = splitDashboards([
    { path: "Dashboards/Releases/A.md" },
    { path: "Dashboards/Releases/B.md" },
  ]);
  assert.equal(home, "Dashboards");
  assert.deepEqual(flat, []);
  assert.deepEqual(
    groups.map((g) => [g.folder, paths(g.items)]),
    [["Dashboards/Releases", ["Dashboards/Releases/A.md", "Dashboards/Releases/B.md"]]]
  );
});

test("splitDashboards after a move: order survives, stale order entries drop", () => {
  const boot = [
    { path: "Dashboards/Overview.md" },
    { path: "Dashboards/Sync.md" },
    { path: "Dashboards/Coding.md" },
  ];
  // manual reorder persisted (SUB-401)
  let order = ["Dashboards/Coding.md", "Dashboards/Overview.md", "Dashboards/Sync.md"];
  assert.deepEqual(paths(applyOrder(boot, order, (d) => d.path)), order);

  // Sync.md is dragged into Dashboards/Releases/ — its path changed, so the
  // stored order entry for the old path is stale
  const moved = [
    { path: "Dashboards/Overview.md" },
    { path: "Dashboards/Releases/Sync.md" },
    { path: "Dashboards/Coding.md" },
  ];
  const ordered = applyOrder(moved, order, (d) => d.path);
  // stale id drops out, the moved dashboard keeps its incoming position at the
  // end of the ordered prefix — no crash, no dropped row
  assert.deepEqual(paths(ordered), [
    "Dashboards/Coding.md",
    "Dashboards/Overview.md",
    "Dashboards/Releases/Sync.md",
  ]);
  const { flat, groups } = splitDashboards(ordered);
  assert.deepEqual(paths(flat), ["Dashboards/Coding.md", "Dashboards/Overview.md"]);
  assert.deepEqual(paths(groups[0].items), ["Dashboards/Releases/Sync.md"]);

  // reorder still works inside the group after the move
  order = reorderIds(paths(ordered), "Dashboards/Releases/Sync.md", "Dashboards/Coding.md", false);
  assert.deepEqual(paths(applyOrder(moved, order, (d) => d.path)), [
    "Dashboards/Releases/Sync.md",
    "Dashboards/Coding.md",
    "Dashboards/Overview.md",
  ]);
});

/* ----- SUB-605: dashboards foldered in the main tree ----- */

test("dashTreeFolder: content folders get a tree row, the home subtree does not", () => {
  const home = "Dashboards";
  // a dashboard filed in a content folder belongs to that folder's tree row
  assert.equal(dashTreeFolder("Studio/Gear Health.md", home), "Studio");
  assert.equal(dashTreeFolder("Life/Money/Portfolio.md", home), "Life/Money");
  // the home folder and its subtree stay with the Dashboards section
  assert.equal(dashTreeFolder("Dashboards/Overview.md", home), null);
  assert.equal(dashTreeFolder("Dashboards/Releases/Label.md", home), null);
  // a sibling whose name merely PREFIXES home's is not inside it
  assert.equal(dashTreeFolder("Dashboards Archive/Old.md", home), "Dashboards Archive");
  // no tree row exists for the vault root or the hidden surfaces
  assert.equal(dashTreeFolder("Overview.md", home), null);
  assert.equal(dashTreeFolder("Journal/2026-07-30.md", home), null);
  assert.equal(dashTreeFolder("Dashboards/Overview.md", ""), null);
  // with home at the vault root every foldered dashboard is "outside" it, so
  // the tree owns all of them and the section keeps only the root-level ones
  assert.equal(dashTreeFolder("Studio/Gear Health.md", ""), "Studio");
});

test("splitDashboards: a content-folder dashboard renders in the tree, not the section", () => {
  const { home, flat, groups, byFolder } = splitDashboards([
    { path: "Dashboards/Overview.md" },
    { path: "Studio/Gear Health.md" },
    { path: "Dashboards/Releases/Label.md" },
    { path: "Life/Portfolio Dash.md" },
    { path: "Dashboards/Sync.md" },
    { path: "Studio/Sessions.md" },
  ]);
  assert.equal(home, "Dashboards");
  // the section keeps the home folder's own rows, in input order
  assert.deepEqual(paths(flat), ["Dashboards/Overview.md", "Dashboards/Sync.md"]);
  // …plus its one level of subfolder groups (SUB-466, unchanged)
  assert.deepEqual(
    groups.map((g) => [g.folder, paths(g.items)]),
    [["Dashboards/Releases", ["Dashboards/Releases/Label.md"]]]
  );
  // the content-folder ones go to the tree, keyed by folder, input order kept
  assert.deepEqual(
    [...byFolder].map(([f, items]) => [f, paths(items)]),
    [
      ["Studio", ["Studio/Gear Health.md", "Studio/Sessions.md"]],
      ["Life", ["Life/Portfolio Dash.md"]],
    ]
  );
});

test("splitDashboards: no dual render — every path lands in exactly one bucket", () => {
  const input = [
    { path: "Dashboards/Overview.md" },
    { path: "Dashboards/Sync.md" },
    { path: "Dashboards/Releases/Label.md" },
    { path: "Studio/Gear Health.md" },
    { path: "Life/Money/Portfolio.md" },
    { path: "Journal/Daily Dash.md" },
  ];
  const { home, flat, groups, byFolder } = splitDashboards(input);
  assert.equal(home, "Dashboards");
  const rendered = [
    ...paths(flat),
    ...groups.flatMap((g) => paths(g.items)),
    ...[...byFolder.values()].flatMap((items) => paths(items)),
  ];
  // same multiset as the input: nothing rendered twice, nothing dropped
  assert.equal(rendered.length, input.length, "one row per dashboard");
  assert.deepEqual([...rendered].sort(), paths(input).sort());
  // a hidden surface has no tree row at all, so the section keeps that one
  assert.ok(paths(flat).includes("Journal/Daily Dash.md"));
  // …and the two content folders each own their row
  assert.deepEqual([...byFolder.keys()], ["Studio", "Life/Money"]);
});

test("splitDashboards: content-folder dashboards don't move the home folder", () => {
  // 2 in Dashboards vs 3 in Studio. The counts used to decide this and Studio
  // took home (SUB-466); since SUB-1079 the explicit folder wins outright, so a
  // busy content folder no longer re-roots the section. The split stays a
  // single decision either way: no path renders on both surfaces
  const { home, flat, byFolder } = splitDashboards([
    { path: "Dashboards/Overview.md" },
    { path: "Dashboards/Sync.md" },
    { path: "Studio/A.md" },
    { path: "Studio/B.md" },
    { path: "Studio/C.md" },
  ]);
  assert.equal(home, "Dashboards");
  assert.deepEqual(paths(flat), ["Dashboards/Overview.md", "Dashboards/Sync.md"]);
  // Studio owns its own tree row, so its three nest there instead
  assert.deepEqual(
    [...byFolder.entries()].map(([f, items]) => [f, paths(items)]),
    [["Studio", ["Studio/A.md", "Studio/B.md", "Studio/C.md"]]]
  );
});

test("dashboardsHome matches the home splitDashboards uses", () => {
  const input = [
    { path: "Dashboards/Overview.md" },
    { path: "Dashboards/Releases/Label.md" },
    { path: "Life/Portfolio.md" },
  ];
  assert.equal(dashboardsHome(input), splitDashboards(input).home);
  assert.equal(dashboardsHome([]), "");
});

/* ----- SUB-1079: the explicit `Dashboards/` rule, inference as fallback ----- */

test("dashboardsHome: an existing Dashboards/ folder is home regardless of counts", () => {
  // the inference alone would hand home to Finance (3 dashboards vs 1), which
  // is exactly the surprise SUB-1006 answered away: the conventional folder is
  // the home, so piling dashboards up elsewhere can't re-root the section
  const input = [
    { path: "Dashboards/Overview.md" },
    { path: "Finance/Ledger.md" },
    { path: "Finance/Taxes.md" },
    { path: "Finance/Payouts.md" },
  ];
  assert.equal(dashboardsHome(input), "Dashboards");
  const split = splitDashboards(input, ["Dashboards", "Finance"]);
  assert.equal(split.home, "Dashboards");
  assert.deepEqual(paths(split.flat), ["Dashboards/Overview.md"]);
  // the heavier subtree stays where the user filed it — folder tree rows
  assert.deepEqual(
    [...split.byFolder].map(([f, items]) => [f, paths(items)]),
    [["Finance", ["Finance/Ledger.md", "Finance/Taxes.md", "Finance/Payouts.md"]]]
  );
});

test("dashboardsHome: an EMPTY Dashboards/ folder still wins when folders are known", () => {
  // nothing in it yet, so the paths alone can't see it — the folder list can,
  // and the header's drop target should send the next dashboard there
  const input = [{ path: "Finance/Ledger.md" }, { path: "Finance/Taxes.md" }];
  assert.equal(dashboardsHome(input, ["Dashboards", "Finance"]), "Dashboards");
  // without the folder list the same vault falls back to inference
  assert.equal(dashboardsHome(input), "Finance");
  assert.equal(splitDashboards(input, ["Dashboards", "Finance"]).home, "Dashboards");
});

test("dashboardsHome: no Dashboards/ folder → inference, exactly as before", () => {
  const input = [
    { path: "Finance/Ledger.md" },
    { path: "Finance/Taxes.md" },
    { path: "Studio/Gear.md" },
  ];
  // passing the folder list changes nothing when the convention isn't there
  assert.equal(dashboardsHome(input, ["Finance", "Studio"]), "Finance");
  assert.equal(dashboardsHome(input), "Finance");
  assert.deepEqual(splitDashboards(input, ["Finance", "Studio"]), splitDashboards(input));
  // and a folder that merely PREFIXES the convention is not the convention
  assert.equal(
    dashboardsHome([{ path: "Dashboards Archive/Old.md" }], ["Dashboards Archive"]),
    "Dashboards Archive"
  );
  // nor is a nested one — the rule is the TOP-LEVEL folder, so `Work/Dashboards`
  // goes through the inference like any other name (which roots at `Work`)
  assert.equal(dashboardsHome([{ path: "Work/Dashboards/A.md" }], ["Work/Dashboards"]), "Work");
});

test("pinTreeFolder is unaffected by the explicit home rule", () => {
  // pins split by their own folder, never by the dashboards home (SUB-594)
  assert.equal(pinTreeFolder("Finance", "Finance/Ledger.md"), "Finance");
  assert.equal(pinTreeFolder("Dashboards", "Dashboards/Overview.md"), null);
  assert.equal(
    pinTreeFolder("Finance", "Finance/Ledger.md", new Set(["Finance/Ledger.md"])),
    null
  );
});

test("splitDashboards: tree dashboards reorder in their own folder group (SUB-605)", () => {
  const boot = [
    { path: "Dashboards/Overview.md" },
    { path: "Dashboards/Sync.md" },
    { path: "Dashboards/Coding.md" },
    { path: "Studio/Gear Health.md" },
    { path: "Studio/Sessions.md" },
    { path: "Life/Portfolio.md" },
  ];
  // the persisted `dashboards` list holds every lane's group folded together
  // (mergeGroupOrder), so a folder group's reorder can't disturb the section
  const group = splitDashboards(boot).byFolder.get("Studio")!.map((d) => d.path);
  const swapped = reorderIds(group, "Studio/Sessions.md", "Studio/Gear Health.md", false);
  const order = mergeGroupOrder([], swapped);
  const split = splitDashboards(applyOrder(boot, order, (d) => d.path));
  assert.deepEqual(paths(split.byFolder.get("Studio")!), [
    "Studio/Sessions.md",
    "Studio/Gear Health.md",
  ]);
  // the section's own rows and the other folder's group are untouched
  assert.deepEqual(paths(split.flat), [
    "Dashboards/Overview.md",
    "Dashboards/Sync.md",
    "Dashboards/Coding.md",
  ]);
  assert.deepEqual(paths(split.byFolder.get("Life")!), ["Life/Portfolio.md"]);
});

test("splitDashboards: the SECTION's Move lane skips interleaved tree rows (SUB-605)", () => {
  // review finding: the section's reorder lane must be the rows the section
  // RENDERS, not the whole persisted `dashboards` list. With a tree-foldered
  // dashboard sitting between two section rows in the persisted order, feeding
  // the flat list to moveId swaps a section row against an id the section never
  // draws — Move up/down looks like a no-op to the user.
  const persisted = [
    { path: "Dashboards/Alpha.md" },
    { path: "Ideas/Sketch.md" },
    { path: "Dashboards/Beta.md" },
    { path: "Dashboards/Releases/Grouped.md" },
  ];
  const split = splitDashboards(persisted);
  assert.deepEqual(paths(split.byFolder.get("Ideas")!), ["Ideas/Sketch.md"]);

  // the lane both Sidebar.sectionIds and App.sectionMoveItems build: the
  // section's flat rows, then its group members, in render order
  const lane = [...split.flat, ...split.groups.flatMap((g) => g.items)].map((d) => d.path);
  assert.deepEqual(lane, [
    "Dashboards/Alpha.md",
    "Dashboards/Beta.md",
    "Dashboards/Releases/Grouped.md",
  ]);

  // Move up on Beta reaches Alpha — the tree row between them is invisible to
  // the lane. Against the raw persisted list it would have swapped Beta with
  // Ideas/Sketch.md and changed nothing on screen.
  assert.deepEqual(moveId(lane, "Dashboards/Beta.md", -1), [
    "Dashboards/Beta.md",
    "Dashboards/Alpha.md",
    "Dashboards/Releases/Grouped.md",
  ]);
  const naive = moveId(paths(persisted), "Dashboards/Beta.md", -1);
  assert.deepEqual(
    naive.filter((p) => p.startsWith("Dashboards/")),
    ["Dashboards/Alpha.md", "Dashboards/Beta.md", "Dashboards/Releases/Grouped.md"],
    "the old lane left every rendered row in place — the visible no-op"
  );

  // SUB-466 adjacency survives: Move down off the last flat row walks into the
  // first group member rather than stopping at the flat list's end
  assert.deepEqual(moveId(lane, "Dashboards/Beta.md", 1), [
    "Dashboards/Alpha.md",
    "Dashboards/Releases/Grouped.md",
    "Dashboards/Beta.md",
  ]);

  // …and the reordered lane, folded back through mergeGroupOrder, keeps the
  // tree row's own entry — the section's write no longer drops it
  const merged = mergeGroupOrder(
    paths(persisted),
    moveId(lane, "Dashboards/Beta.md", -1)
  );
  assert.ok(merged.includes("Ideas/Sketch.md"), "tree entry survives a section reorder");
  const after = splitDashboards(applyOrder(persisted, merged, (d) => d.path));
  assert.deepEqual(paths(after.flat), ["Dashboards/Beta.md", "Dashboards/Alpha.md"]);
  assert.deepEqual(paths(after.byFolder.get("Ideas")!), ["Ideas/Sketch.md"]);
});

test("splitDashboards + splitPins: a pinned tree dashboard doesn't nest twice (SUB-594)", () => {
  const dashboards = [{ path: "Dashboards/Overview.md" }, { path: "Studio/Gear Health.md" }];
  const { byFolder } = splitDashboards(dashboards);
  // SUB-605 gives this dashboard a row under the Studio tree row…
  assert.deepEqual([...byFolder.keys()], ["Studio"]);
  // …so its PIN must not add a SECOND row under that same folder. dashPaths
  // excludes it by path (SUB-594's rule, unchanged: the pin still shows in the
  // flat Pinned section, which is a different surface from the tree nest), and
  // a plain note pinned beside it keeps the nest SUB-585 gave it.
  const dashPaths = new Set(dashboards.map((d) => d.path));
  const split = splitPins(
    [
      { path: "Studio/Gear Health.md", folder: "Studio" },
      { path: "Studio/Notes.md", folder: "Studio" },
    ],
    dashPaths
  );
  assert.deepEqual(split.flat.map((n) => n.path), ["Studio/Gear Health.md"]);
  assert.deepEqual(split.byFolder.get("Studio")?.map((n) => n.path), ["Studio/Notes.md"]);
});

test("orderedRootNodes: persisted order applies to roots only, hidden surfaces out", () => {
  const folders = ["Projects/Active", "Inbox", "Projects/Archive", "Areas", "Journal", "Dashboards"];
  const out = orderedRootNodes(folders, ["Projects", "Areas"]);
  // ordered roots first, the rest append alphabetically; Journal/Dashboards
  // never render (they're first-class sidebar surfaces)
  assert.deepEqual(
    out.map((n) => n.path),
    ["Projects", "Areas", "Inbox"]
  );
  // nested levels keep buildFolderTree's alphabetical sort
  assert.deepEqual(
    out[0].children.map((n) => n.path),
    ["Projects/Active", "Projects/Archive"]
  );
  // no stored order = alphabetical, stale entries dropped
  assert.deepEqual(
    orderedRootNodes(folders, ["Gone", "Inbox"]).map((n) => n.path),
    ["Inbox", "Areas", "Projects"]
  );
});

test("orderedRootNodes: reorder round-trip (drag ids, then moveId, re-apply)", () => {
  const folders = ["Areas", "Inbox", "Projects"];
  // boot: alphabetical
  let order = orderedRootNodes(folders, []).map((n) => n.path);
  assert.deepEqual(order, ["Areas", "Inbox", "Projects"]);
  // drag "Projects" before "Areas", persist, re-apply on the next render
  order = reorderIds(order, "Projects", "Areas", false);
  assert.deepEqual(
    orderedRootNodes(folders, order).map((n) => n.path),
    ["Projects", "Areas", "Inbox"]
  );
  // Move down on the new first row swaps it back
  order = moveId(order, "Projects", 1);
  assert.deepEqual(
    orderedRootNodes(folders, order).map((n) => n.path),
    ["Areas", "Projects", "Inbox"]
  );
  // a folder created after the order was saved appends at the end
  assert.deepEqual(
    orderedRootNodes([...folders, "Beta"], order).map((n) => n.path),
    ["Areas", "Projects", "Inbox", "Beta"]
  );
});

/* ----- SUB-585: per-group nested ordering + pins in the tree ----- */

test("orderedSiblingFolders: each depth reads its own slice of one flat order", () => {
  const folders = ["Life/Fashion", "Life/Recipes", "Life/Person", "Inbox", "Areas"];
  // no order stored: alphabetical at every depth
  assert.deepEqual(orderedSiblingFolders(folders, [], ""), ["Areas", "Inbox", "Life"]);
  assert.deepEqual(orderedSiblingFolders(folders, [], "Life"), [
    "Life/Fashion",
    "Life/Person",
    "Life/Recipes",
  ]);
  // one flat list carries a root reorder AND a nested reorder; neither
  // disturbs the other, unknown parents yield []
  const order = ["Life", "Life/Recipes", "Life/Fashion"];
  assert.deepEqual(orderedSiblingFolders(folders, order, ""), ["Life", "Areas", "Inbox"]);
  assert.deepEqual(orderedSiblingFolders(folders, order, "Life"), [
    "Life/Recipes",
    "Life/Fashion",
    "Life/Person",
  ]);
  assert.deepEqual(orderedSiblingFolders(folders, order, "Gone"), []);
});

test("mergeGroupOrder: a group reorder folds into the flat list without touching others", () => {
  const global = ["Projects", "Life/Recipes", "Life/Fashion", "Inbox"];
  const next = mergeGroupOrder(global, ["Life/Fashion", "Life/Recipes"]);
  assert.deepEqual(next, ["Projects", "Inbox", "Life/Fashion", "Life/Recipes"]);
  // per-group application sees the change; the root group is untouched
  const folders = ["Projects", "Inbox", "Life/Recipes", "Life/Fashion"];
  assert.deepEqual(orderedSiblingFolders(folders, next, "Life"), [
    "Life/Fashion",
    "Life/Recipes",
  ]);
  assert.deepEqual(orderedSiblingFolders(folders, next, ""), ["Projects", "Inbox", "Life"]);
  // no-op merge returns the SAME array so callers can skip the write
  assert.equal(mergeGroupOrder(next, ["Life/Fashion", "Life/Recipes"]), next);
});

test("mergeGroupOrder: members new to the flat list still land in group order", () => {
  // a nested group reordered for the first time — nothing of it was persisted
  assert.deepEqual(mergeGroupOrder([], ["Life/B", "Life/A"]), ["Life/B", "Life/A"]);
  assert.deepEqual(mergeGroupOrder(["Inbox"], ["Life/B", "Life/A"]), [
    "Inbox",
    "Life/B",
    "Life/A",
  ]);
});

test("pinTreeFolder: home folder, except root and hidden surfaces", () => {
  assert.equal(pinTreeFolder("Life", "Life/Food Log.md"), "Life");
  assert.equal(pinTreeFolder("Life/Recipes", "Life/Recipes/Stew.md"), "Life/Recipes");
  assert.equal(pinTreeFolder("", "Scratch.md"), null);
  assert.equal(pinTreeFolder("Journal", "Journal/2026-01-01.md"), null);
  assert.equal(pinTreeFolder("Dashboards/Deep", "Dashboards/Deep/Sleep.md"), null);
});

test("splitPins: tree groups per folder, flat keeps root + hidden-surface pins", () => {
  const pins = [
    { folder: "Life", path: "Life/Food Log.md" },
    { folder: "", path: "Scratch.md" },
    { folder: "Life", path: "Life/Weight Log.md" },
    { folder: "Journal", path: "Journal/2026-01-01.md" },
    { folder: "Life/Recipes", path: "Life/Recipes/Stew.md" },
  ];
  const { flat, byFolder } = splitPins(pins);
  assert.deepEqual(
    flat.map((p) => p.path),
    ["Scratch.md", "Journal/2026-01-01.md"]
  );
  assert.deepEqual(
    byFolder.get("Life")!.map((p) => p.path),
    ["Life/Food Log.md", "Life/Weight Log.md"]
  );
  assert.deepEqual(
    byFolder.get("Life/Recipes")!.map((p) => p.path),
    ["Life/Recipes/Stew.md"]
  );
  // pins order is the single source of row order inside each bucket: a group
  // reorder merged into the flat pins list survives the round trip
  const reordered = mergeGroupOrder(
    pins.map((p) => p.path),
    ["Life/Weight Log.md", "Life/Food Log.md"]
  );
  const byPath = new Map(pins.map((p) => [p.path, p]));
  const applied = applyOrder(pins, reordered, (p) => p.path).map((p) => byPath.get(p.path)!);
  assert.deepEqual(
    splitPins(applied)
      .byFolder.get("Life")!
      .map((p) => p.path),
    ["Life/Weight Log.md", "Life/Food Log.md"]
  );
});

test("pinTreeFolder: a pinned dashboard gets no tree row, by path (SUB-594)", () => {
  const dashPaths = new Set(["Life/Health.md", "Life/Deep/Sleep.md", "Projects/Roadmap.md"]);
  // a dashboard has a Dashboards-section row wherever it lives — inside the
  // dashboards home, deeper in it, or in an unrelated folder entirely
  assert.equal(pinTreeFolder("Life", "Life/Health.md", dashPaths), null);
  assert.equal(pinTreeFolder("Life/Deep", "Life/Deep/Sleep.md", dashPaths), null);
  assert.equal(pinTreeFolder("Projects", "Projects/Roadmap.md", dashPaths), null);
  // plain notes keep their tree row, including ones sitting beside a dashboard
  assert.equal(pinTreeFolder("Life", "Life/Grocery.md", dashPaths), "Life");
  assert.equal(pinTreeFolder("Projects", "Projects/Plan.md", dashPaths), "Projects");
  // an empty set (or none at all) excludes nothing beyond the static roots
  assert.equal(pinTreeFolder("Life", "Life/Health.md", new Set()), "Life");
  assert.equal(pinTreeFolder("Life", "Life/Health.md"), "Life");
  assert.equal(pinTreeFolder("Dashboards", "Dashboards/Health.md", new Set()), null);
});

test("splitPins: pinned dashboards stay flat, their folder-mates still nest (SUB-594)", () => {
  // a vault whose dashboards live under Life/: a pinned dashboard renders in
  // the Dashboards section only — it must not ALSO nest under the Life tree
  // row. The path set tells a pinned dashboard from a plain note in the same
  // folder, so Life/Grocery.md keeps the nest SUB-585 gave it.
  const dashPaths = new Set(["Life/Health.md", "Life/Deep/Sleep.md"]);
  const pins = [
    { folder: "Life", path: "Life/Health.md" },
    { folder: "Life/Deep", path: "Life/Deep/Sleep.md" },
    { folder: "Life", path: "Life/Grocery.md" },
    { folder: "Projects", path: "Projects/Plan.md" },
  ];
  const { flat, byFolder } = splitPins(pins, dashPaths);
  assert.deepEqual(
    flat.map((p) => p.path),
    ["Life/Health.md", "Life/Deep/Sleep.md"]
  );
  assert.deepEqual(
    byFolder.get("Life")!.map((p) => p.path),
    ["Life/Grocery.md"]
  );
  assert.equal(byFolder.get("Life/Deep"), undefined);
  assert.deepEqual(
    byFolder.get("Projects")!.map((p) => p.path),
    ["Projects/Plan.md"]
  );
});

test("splitPins: a dashboard OUTSIDE the dashboards home also de-dupes (SUB-594)", () => {
  // splitDashboards homes this vault at Life/; the stray Projects/Roadmap.md
  // gets a row of its own either way — a flat section row before SUB-605, a
  // Projects tree row since — so pinning it double-rendered under the old
  // home-subtree rule. The path set covers it regardless of the surface.
  const dashboards = [
    { path: "Life/Health.md" },
    { path: "Life/Sleep.md" },
    { path: "Projects/Roadmap.md" },
  ];
  const { home, byFolder: dashTree } = splitDashboards(dashboards);
  assert.equal(home, "Life");
  assert.deepEqual(dashTree.get("Projects")?.map((d) => d.path), ["Projects/Roadmap.md"]);
  const dashPaths = new Set(dashboards.map((d) => d.path));
  const { flat, byFolder } = splitPins(
    [
      { folder: "Projects", path: "Projects/Roadmap.md" },
      { folder: "Projects", path: "Projects/Plan.md" },
    ],
    dashPaths
  );
  assert.deepEqual(
    flat.map((p) => p.path),
    ["Projects/Roadmap.md"]
  );
  assert.deepEqual(
    byFolder.get("Projects")!.map((p) => p.path),
    ["Projects/Plan.md"]
  );
});

test("splitPins: a standard Dashboards/ vault is unchanged (SUB-594)", () => {
  // regression — the static roots already hid Dashboards/, so passing the
  // dashboard paths leaves a standard vault's split exactly as before
  const pins = [
    { folder: "Dashboards", path: "Dashboards/Health.md" },
    { folder: "Dashboards/Deep", path: "Dashboards/Deep/Sleep.md" },
    { folder: "Life", path: "Life/Food Log.md" },
  ];
  const dashPaths = new Set(["Dashboards/Health.md", "Dashboards/Deep/Sleep.md"]);
  const { flat, byFolder } = splitPins(pins, dashPaths);
  assert.deepEqual(
    flat.map((p) => p.path),
    ["Dashboards/Health.md", "Dashboards/Deep/Sleep.md"]
  );
  assert.deepEqual(
    byFolder.get("Life")!.map((p) => p.path),
    ["Life/Food Log.md"]
  );
  assert.deepEqual(splitPins(pins, dashPaths), splitPins(pins));
});

test("dashgroups lane: applyOrder sorts group HEADERS by folder (SUB-698)", () => {
  const dashes = [
    { folder: "Dashboards", path: "Dashboards/Home.md" },
    { folder: "Dashboards/Money", path: "Dashboards/Money/Book.md" },
    { folder: "Dashboards/Music", path: "Dashboards/Music/Label.md" },
    { folder: "Dashboards/Rigs", path: "Dashboards/Rigs/Fleet.md" },
  ];
  const { groups } = splitDashboards(dashes);
  // the split hands them over alphabetically…
  assert.deepEqual(groups.map((g) => g.folder), [
    "Dashboards/Money",
    "Dashboards/Music",
    "Dashboards/Rigs",
  ]);

  // …and the persisted lane re-seats them, groups never dragged trailing in
  // the split's own order rather than being dropped
  const order = ["Dashboards/Rigs", "Dashboards/Money"];
  const seated = applyOrder(groups, order, (g) => g.folder);
  assert.deepEqual(seated.map((g) => g.folder), [
    "Dashboards/Rigs",
    "Dashboards/Money",
    "Dashboards/Music",
  ]);
  // a header's own dashboards ride along untouched
  assert.deepEqual(paths(seated[0].items), ["Dashboards/Rigs/Fleet.md"]);

  // a retired group's stale id is ignored rather than leaving a hole
  assert.deepEqual(
    applyOrder(groups, ["Dashboards/Gone", "Dashboards/Music"], (g) => g.folder).map(
      (g) => g.folder
    ),
    ["Dashboards/Music", "Dashboards/Money", "Dashboards/Rigs"]
  );

  // and a drag through reorderIds writes a lane applyOrder reads back
  const flipped = reorderIds(
    groups.map((g) => g.folder),
    "Dashboards/Rigs",
    "Dashboards/Money",
    false
  );
  assert.deepEqual(applyOrder(groups, flipped, (g) => g.folder).map((g) => g.folder), [
    "Dashboards/Rigs",
    "Dashboards/Money",
    "Dashboards/Music",
  ]);
});

test("dashgroups lane: migrateOrderId keeps a renamed group in place (SUB-698)", () => {
  const order = ["Dashboards/Rigs", "Dashboards/Money", "Dashboards/Music"];
  // renaming the middle group keeps its slot — without this the group would
  // fall out of the lane and reappear last after applyOrder
  const renamed = migrateOrderId(order, "Dashboards/Money", "Dashboards/Finance");
  assert.deepEqual(renamed, [
    "Dashboards/Rigs",
    "Dashboards/Finance",
    "Dashboards/Music",
  ]);

  const dashes = [
    { folder: "Dashboards/Finance", path: "Dashboards/Finance/Book.md" },
    { folder: "Dashboards/Music", path: "Dashboards/Music/Label.md" },
    { folder: "Dashboards/Rigs", path: "Dashboards/Rigs/Fleet.md" },
  ];
  const { groups } = splitDashboards(dashes);
  assert.deepEqual(applyOrder(groups, renamed, (g) => g.folder).map((g) => g.folder), renamed);

  // the same helper carries a group MOVED out of Dashboards/ — the entry is
  // retargeted, and applyOrder then drops it because it is no longer a group
  const moved = migrateOrderId(order, "Dashboards/Money", "Money");
  assert.deepEqual(moved, ["Dashboards/Rigs", "Money", "Dashboards/Music"]);

  // the collapse id travels the same way, id-shaped rather than path-shaped
  assert.deepEqual(
    migrateOrderId(
      ["dashgroup:Dashboards/Money", "dashgroup:Dashboards/Rigs"],
      "dashgroup:Dashboards/Money",
      "dashgroup:Dashboards/Finance"
    ),
    ["dashgroup:Dashboards/Finance", "dashgroup:Dashboards/Rigs"]
  );
});
