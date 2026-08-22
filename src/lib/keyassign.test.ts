import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ASSIGNABLE_KEYS,
  assignKey,
  comboForToken,
  freeKeys,
  keyForTarget,
  keyLabel,
  pinIndexForToken,
  pruneKeys,
  splitFreeKeys,
  targetForCombo,
  targetLabel,
  targetView,
  unassignKey,
} from "./keyassign.ts";
import { comboMatches, SHORTCUTS, type KeyEventLike } from "./shortcuts.ts";

const ev = (
  key: string,
  mods: Partial<Omit<KeyEventLike, "key">> = {}
): KeyEventLike => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

test("pool is the 14 documented keys in HUD order", () => {
  assert.deepEqual(
    ASSIGNABLE_KEYS.map((k) => k.token),
    [
      "mod+5",
      "mod+6",
      "mod+7",
      "mod+8",
      "mod+9",
      "ctrl+1",
      "ctrl+2",
      "ctrl+3",
      "ctrl+4",
      "ctrl+5",
      "ctrl+6",
      "ctrl+7",
      "ctrl+8",
      "ctrl+9",
    ]
  );
});

test("every pool combo pins all four modifier flags", () => {
  for (const k of ASSIGNABLE_KEYS) {
    const c = k.combo;
    assert.equal(c.mod, undefined, `${k.token} must not use the loose mod flag`);
    for (const flag of ["meta", "ctrl", "shift", "alt"] as const) {
      assert.equal(typeof c[flag], "boolean", `${k.token}.${flag} must be explicit`);
    }
  }
});

test("keyLabel renders ⌘ and ⌃ glyphs, unknown tokens pass through", () => {
  assert.equal(keyLabel("mod+5"), "⌘5");
  assert.equal(keyLabel("ctrl+3"), "⌃3");
  assert.equal(keyLabel("hyper+z"), "hyper+z");
  assert.equal(comboForToken("hyper+z"), null);
});

test("freeKeys drops assigned tokens, keeps order", () => {
  const free = freeKeys({ "mod+5": "today", "ctrl+2": "notes" });
  assert.equal(free.length, ASSIGNABLE_KEYS.length - 2);
  assert.ok(!free.some((k) => k.token === "mod+5" || k.token === "ctrl+2"));
  assert.equal(free[0].token, "mod+6");
});

/* `view-pins` binds the loose combo `{key, mod}` and `mod` means ⌘ OR
   ⌃, so BOTH halves of the pool land on the pin mapping at digits 5–9 — ⌃7
   reaches the third pin exactly like ⌘7 does. The HUD's warning has to cover
   both halves, so these tests assert the ⌃ side explicitly. */
test("pinIndexForToken maps digits 5-9 in both halves onto pins", () => {
  for (const [token, want] of [
    ["mod+5", 0],
    ["mod+7", 2],
    ["mod+9", 4],
    ["ctrl+5", 0],
    ["ctrl+7", 2],
    ["ctrl+9", 4],
  ] as const) {
    assert.equal(pinIndexForToken(token, 5), want, token);
  }
});

test("pinIndexForToken: digits past the pin count and 1-4 shadow nothing", () => {
  assert.equal(pinIndexForToken("mod+7", 2), null, "third pin does not exist");
  assert.equal(pinIndexForToken("ctrl+7", 2), null);
  assert.equal(pinIndexForToken("mod+5", 0), null, "no pins at all");
  for (const token of ["ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4"]) {
    // ⌃1–⌃4 shadow the fixed view entries, not pins — a different, static
    // collision the sheet already shows; nothing for the pin warning to say.
    assert.equal(pinIndexForToken(token, 5), null, token);
  }
  assert.equal(pinIndexForToken("hyper+z", 5), null, "outside the pool");
});

test("splitFreeKeys sorts free chips by what the drop would cost", () => {
  const { open, shadowing } = splitFreeKeys({}, 3);
  assert.deepEqual(
    shadowing.map((k) => k.token),
    ["mod+5", "mod+6", "mod+7", "ctrl+5", "ctrl+6", "ctrl+7"],
    "three pins claim digits 5-7 in both halves"
  );
  assert.deepEqual(
    open.map((k) => k.token),
    ["mod+8", "mod+9", "ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4", "ctrl+8", "ctrl+9"]
  );
  assert.equal(open.length + shadowing.length, ASSIGNABLE_KEYS.length);
});

test("splitFreeKeys: assigned keys leave both lists, no pins means all open", () => {
  const assigned = splitFreeKeys({ "mod+5": "today", "ctrl+2": "notes" }, 5);
  const tokens = [...assigned.open, ...assigned.shadowing].map((k) => k.token);
  assert.ok(!tokens.includes("mod+5") && !tokens.includes("ctrl+2"));
  assert.equal(tokens.length, ASSIGNABLE_KEYS.length - 2);

  const noPins = splitFreeKeys({}, 0);
  assert.deepEqual(noPins.shadowing, [], "nothing to shadow without pins");
  assert.equal(noPins.open.length, ASSIGNABLE_KEYS.length);
});

test("assignKey binds and returns a new map", () => {
  const before = {};
  const after = assignKey(before, "mod+5", "folder:Projects");
  assert.deepEqual(after, { "mod+5": "folder:Projects" });
  assert.deepEqual(before, {}, "input map is not mutated");
});

test("assignKey steals: one key per target, one target per key", () => {
  const map = { "mod+5": "folder:Projects", "ctrl+1": "today" };
  // dropping ⌃1 on a folder that already wears ⌘5 removes ⌘5 (one key per target)
  const stolen = assignKey(map, "ctrl+1", "folder:Projects");
  assert.deepEqual(stolen, { "ctrl+1": "folder:Projects" });
  // rebinding a key that already points elsewhere moves it (one target per key)
  const moved = assignKey(map, "mod+5", "notes");
  assert.deepEqual(moved, { "mod+5": "notes", "ctrl+1": "today" });
});

test("assignKey refuses tokens outside the pool", () => {
  const map = { "mod+5": "today" };
  assert.deepEqual(assignKey(map, "mod+0", "notes"), map);
});

test("unassignKey clears one binding, no-ops on unknown", () => {
  const map = { "mod+5": "today", "ctrl+1": "notes" };
  assert.deepEqual(unassignKey(map, "mod+5"), { "ctrl+1": "notes" });
  assert.equal(unassignKey(map, "ctrl+9"), map);
  assert.deepEqual(map, { "mod+5": "today", "ctrl+1": "notes" });
});

test("keyForTarget finds the chip a row wears", () => {
  const map = { "mod+7": "dash:Dashboards/Week.md" };
  assert.equal(keyForTarget(map, "dash:Dashboards/Week.md"), "mod+7");
  assert.equal(keyForTarget(map, "today"), null);
});

test("targetForCombo resolves assigned keys only", () => {
  const map = { "mod+5": "folder:Projects", "ctrl+3": "notes" };
  assert.equal(targetForCombo(map, ev("5", { metaKey: true })), "folder:Projects");
  assert.equal(targetForCombo(map, ev("3", { ctrlKey: true })), "notes");
  assert.equal(targetForCombo(map, ev("6", { metaKey: true })), null, "unassigned key");
  assert.equal(targetForCombo({}, ev("5", { metaKey: true })), null);
});

test("targetForCombo demands exact modifiers — no false matches", () => {
  const map = { "mod+5": "today", "ctrl+3": "notes" };
  assert.equal(targetForCombo(map, ev("5", { metaKey: true, shiftKey: true })), null, "⌘⇧5");
  assert.equal(targetForCombo(map, ev("5", { metaKey: true, ctrlKey: true })), null, "⌘⌃5");
  assert.equal(targetForCombo(map, ev("5", { metaKey: true, altKey: true })), null, "⌘⌥5");
  assert.equal(targetForCombo(map, ev("5", { ctrlKey: true })), null, "⌃5 is a different key");
  assert.equal(targetForCombo(map, ev("3", { ctrlKey: true, shiftKey: true })), null, "⌃⇧3");
  assert.equal(targetForCombo(map, ev("3", { ctrlKey: true, metaKey: true })), null, "⌘⌃3");
  assert.equal(targetForCombo(map, ev("5")), null, "bare 5");
});

test("targetView inverts viewKey for every navigable token", () => {
  assert.deepEqual(targetView("today"), { kind: "today" });
  assert.deepEqual(targetView("notes"), { kind: "notes" });
  assert.deepEqual(targetView("all"), { kind: "all" });
  assert.deepEqual(targetView("search"), { kind: "search" });
  assert.deepEqual(targetView("trash"), { kind: "trash" });
  assert.deepEqual(targetView("assets"), { kind: "assets" });
  assert.deepEqual(targetView("calendar"), { kind: "calendar" });
  assert.deepEqual(targetView("vaultsync"), { kind: "vaultsync" });
  assert.deepEqual(targetView("changelog"), { kind: "changelog" });
  assert.deepEqual(targetView("cookbook"), { kind: "cookbook" });
  assert.deepEqual(targetView("dbmanager"), { kind: "dbmanager" });
  assert.deepEqual(targetView("db:task"), { kind: "db", type: "task" });
  assert.deepEqual(targetView("sv:abc123"), { kind: "saved", id: "abc123" });
  assert.deepEqual(targetView("dash:Dashboards/Week.md"), {
    kind: "dashboard",
    path: "Dashboards/Week.md",
  });
  assert.deepEqual(targetView("folder:Projects/Active"), {
    kind: "folder",
    path: "Projects/Active",
  });
  // a tag folder row wears a key chip like every other destination row, so
  // the token it hands back has to resolve to the view that row opens
  assert.deepEqual(targetView("tagfolder:tf1"), { kind: "tagfolder", id: "tf1" });
});

test("targetView returns null for App-handled and stale tokens", () => {
  assert.equal(targetView("journal"), null);
  assert.equal(targetView("note:Inbox/Idea.md"), null);
  assert.equal(targetView("nonsense"), null);
});

test("pruneKeys drops bindings whose target vanished", () => {
  const map = { "mod+5": "folder:Gone", "ctrl+1": "today" };
  assert.deepEqual(pruneKeys(map, new Set(["today"])), { "ctrl+1": "today" });
  assert.deepEqual(pruneKeys(map, new Set()), {});
});

test("targetLabel names rows from live context", () => {
  const ctx = {
    dashboards: [{ path: "Dashboards/Week.md", title: "Week ahead" }],
    savedViews: [{ id: "sv1", name: "Overdue" }],
    pinned: [{ path: "Inbox/Idea.md", title: "Big idea" }],
    tagFolders: [{ id: "tf1", name: "Reading" }],
  };
  assert.equal(targetLabel("dash:Dashboards/Week.md", ctx), "Week ahead");
  assert.equal(targetLabel("sv:sv1", ctx), "Overdue");
  assert.equal(targetLabel("note:Inbox/Idea.md", ctx), "Big idea");
  assert.equal(targetLabel("journal", ctx), "Journal");
  assert.equal(targetLabel("today", ctx), "Today");
  assert.equal(targetLabel("dbmanager", ctx), "All databases");
  assert.equal(targetLabel("folder:Projects/Active", ctx), "Active");
  assert.equal(targetLabel("db:task", ctx), "Task");
  assert.equal(targetLabel("tagfolder:tf1", ctx), "Reading");
});

test("targetLabel falls back to the token tail when context misses", () => {
  assert.equal(targetLabel("dash:Dashboards/Week.md"), "Week");
  assert.equal(targetLabel("note:Inbox/Idea.md"), "Idea");
  assert.equal(targetLabel("sv:sv1"), "sv1");
  assert.equal(targetLabel("folder:Gone"), "Gone");
  assert.equal(targetLabel("tagfolder:tf-gone"), "tf-gone");
  assert.equal(targetLabel("nonsense"), "nonsense");
});

/* The pool deliberately layers over the view entries: `mod: true` means ⌘ OR
   ⌃, so ⌘1…⌘4 (view-today…view-calendar) also answer to ⌃1…⌃4, and view-pins'
   ⌘5…⌘9 answers to ⌃5…⌃9 too. Registry ORDER is the arbiter — `custom-key`
   must sit ahead of every entry it overlaps, or an assignment would be
   silently shadowed. Anything colliding that custom-key does NOT precede is a
   bug, so this test names the survivors rather than allow-listing ids. */
test("custom-key precedes every shortcut a pool combo can collide with", () => {
  const rank = new Map(SHORTCUTS.map((s, i) => [s.id, i]));
  const mine = rank.get("custom-key");
  assert.notEqual(mine, undefined, "custom-key must be in the registry");
  for (const k of ASSIGNABLE_KEYS) {
    const e = ev(k.combo.key, {
      metaKey: !!k.combo.meta,
      ctrlKey: !!k.combo.ctrl,
      shiftKey: !!k.combo.shift,
      altKey: !!k.combo.alt,
    });
    for (const s of SHORTCUTS) {
      if (s.id === "custom-key") continue;
      if (!s.combos.some((c) => comboMatches(c, e))) continue;
      assert.ok(
        rank.get(s.id)! > mine!,
        `${k.token} collides with ${s.id}, which dispatches first`
      );
    }
  }
});

/* The inverse guard: the pool must not swallow keys the app already owns.
   ⌘1…⌘4, ⌘\, ⌘K … must not match any pool combo. */
test("pool combos never match the app's own ⌘-digit shortcuts", () => {
  for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    const cmd = ev(key, { metaKey: true });
    const matched = ASSIGNABLE_KEYS.filter((k) => comboMatches(k.combo, cmd));
    assert.deepEqual(
      matched.map((k) => k.token),
      Number(key) >= 5 ? [`mod+${key}`] : [],
      `⌘${key}`
    );
  }
});
