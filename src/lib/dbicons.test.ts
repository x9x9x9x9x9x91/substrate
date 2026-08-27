import { test } from "node:test";
import assert from "node:assert/strict";
import type { SchemaConfig } from "./types.ts";
import {
  autoGlyphLetter,
  dashboardIcon,
  defaultIcon,
  folderDefaultIcon,
  firstGrapheme,
  GLYPH_IDS,
  GLYPHS,
  ICON_TINTS,
  iconForType,
  iconsByType,
  optionColorVar,
  resolveIcon,
  tintVar,
  typeIcon,
  typeTint,
} from "./dbicons.ts";

test("typeIcon reads a stored icon and ignores malformed shapes", () => {
  assert.deepEqual(typeIcon(undefined), undefined);
  assert.deepEqual(typeIcon({}), undefined);
  // the reserved key riding among real props
  assert.deepEqual(
    typeIcon({
      status: { options: [] },
      icon: { glyph: "music", tint: "violet" },
    } as unknown as Record<string, never>),
    { glyph: "music", tint: "violet" }
  );
  // garbage in the reserved key reads as no icon, never an error
  for (const bad of [null, "music", 7, ["music"], {}, { glyph: "  " }, { tint: "teal" }]) {
    assert.deepEqual(
      typeIcon({ icon: bad } as unknown as Record<string, never>),
      undefined,
      `malformed ${JSON.stringify(bad)}`
    );
  }
  // blank strings normalize away; emoji alone is a full icon
  assert.deepEqual(
    typeIcon({ icon: { emoji: "🎵", glyph: "", tint: "" } } as unknown as Record<string, never>),
    { emoji: "🎵" }
  );
  // extra unknown fields are ignored, not fatal
  assert.deepEqual(
    typeIcon({ icon: { glyph: "star", future: true } } as unknown as Record<string, never>),
    { glyph: "star" }
  );
});

test("iconsByType maps types to their icons, skipping icon-less entries", () => {
  const schema = {
    release: {
      icon: { glyph: "music" },
      status: { options: [{ value: "live" }] },
    },
    gear: { manual: { options: [], kind: "file" } },
    event: { icon: { emoji: "🎵", tint: "pink" } },
  } as unknown as SchemaConfig;
  assert.deepEqual(iconsByType(schema), {
    release: { glyph: "music" },
    event: { emoji: "🎵", tint: "pink" },
  });
  assert.deepEqual(iconsByType({}), {});
});

test("iconsByType preserves a prototype-shaped database name as an own key", () => {
  const schema = JSON.parse('{"__proto__":{"icon":{"glyph":"star"}}}') as SchemaConfig;
  const icons = iconsByType(schema);
  assert.deepEqual(Object.keys(icons), ["__proto__"]);
  assert.deepEqual(icons.__proto__, { glyph: "star" });
  assert.equal(Object.getPrototypeOf(icons), Object.prototype);
});

test("iconForType folds schema/note casing with exact spelling first", () => {
  const upper = { glyph: "star" } as const;
  const lower = { glyph: "disc" } as const;
  const icons = Object.fromEntries([["Release", upper], ["release", lower]]);
  assert.deepEqual(iconForType(icons, "release"), lower);
  assert.deepEqual(iconForType(icons, "RELEASE"), upper);

  const protoIcons = iconsByType(
    JSON.parse('{"__proto__":{"icon":{"glyph":"star"}}}') as SchemaConfig
  );
  assert.deepEqual(iconForType(protoIcons, "__PROTO__"), { glyph: "star" });
  assert.equal(Object.getPrototypeOf(protoIcons), Object.prototype);
});

test("firstGrapheme keeps ZWJ sequences and flags whole", () => {
  assert.equal(firstGrapheme("🎵"), "🎵");
  assert.equal(firstGrapheme("🛒 extra text"), "🛒");
  assert.equal(firstGrapheme("👨‍👩‍👧‍👦"), "👨‍👩‍👧‍👦");
  assert.equal(firstGrapheme("🇩🇪"), "🇩🇪");
  assert.equal(firstGrapheme("  🎧  "), "🎧");
  assert.equal(firstGrapheme(""), "");
  assert.equal(firstGrapheme("abc"), "a");
});

test("autoGlyphLetter takes the first letter or digit, uppercased", () => {
  assert.equal(autoGlyphLetter("release"), "R");
  assert.equal(autoGlyphLetter("Release"), "R");
  assert.equal(autoGlyphLetter("99 problems"), "9");
  assert.equal(autoGlyphLetter("-weird-"), "W");
  assert.equal(autoGlyphLetter("über"), "Ü");
  assert.equal(autoGlyphLetter(""), "·");
});

test("tintVar maps known tints to --opt-* tokens, unknowns untinted", () => {
  assert.equal(tintVar("teal"), "var(--opt-teal)");
  assert.equal(tintVar(undefined), undefined);
  assert.equal(tintVar(""), undefined);
  assert.equal(tintVar("hotpink"), undefined);
});

test("optionColorVar allowlists free-form frontmatter colors (SUB-619)", () => {
  for (const name of ICON_TINTS) {
    assert.equal(optionColorVar(name), `var(--opt-${name})`, name);
  }
  assert.equal(optionColorVar(undefined), undefined);
  assert.equal(optionColorVar(""), undefined);
  assert.equal(optionColorVar("   "), undefined);
  assert.equal(optionColorVar("hotpink"), undefined, "unknown name reads as no color");
  assert.equal(optionColorVar("Teal"), undefined, "case must match the token roster");
  assert.equal(optionColorVar("teal "), undefined, "no trailing-space smuggling");
  // hostile shapes: anything that would close the var() and inject its own
  // declaration must fall back, not reach CSS
  for (const hostile of [
    "red); background:url(https://evil.example/x.png",
    "teal) 55%, transparent); background-image:url(//evil",
    "gray);}body{display:none",
    "blue, var(--text-3)",
    "--opt-red",
    "url(https://evil.example)",
    "expression(alert(1))",
  ]) {
    assert.equal(optionColorVar(hostile), undefined, hostile);
  }
});

test("glyph registry: ids unique-ish, non-empty, well-formed path data", () => {
  assert.ok(GLYPH_IDS.length >= 20 && GLYPH_IDS.length <= 48, "modest curated set");
  assert.deepEqual(GLYPH_IDS.sort(), Object.keys(GLYPHS).sort(), "ids match registry keys");
  for (const [id, paths] of Object.entries(GLYPHS)) {
    assert.ok(paths.length > 0, `${id} has paths`);
    for (const d of paths) {
      assert.match(d, /^[Mm]/, `${id} path starts with a moveto`);
      assert.ok(d.length > 5, `${id} path is non-trivial`);
    }
  }
  // mock-seeded glyphs must exist (src/lib/tauri.ts relies on these)
  for (const id of ["music", "wrench", "check-square"]) assert.ok(GLYPHS[id], `${id} present`);
});

test("ICON_TINTS matches the --opt-* token vocabulary in styles.css", () => {
  assert.equal(ICON_TINTS.length, 10);
  assert.ok(ICON_TINTS.includes("teal") && ICON_TINTS.includes("gray"));
});

test("typeTint: explicit tint wins, then the curated default, else a stable hash (SUB-73/183)", () => {
  assert.equal(typeTint("release", { glyph: "music", tint: "teal" }), "var(--opt-teal)");
  // no schema icon → the curated default's tint
  assert.equal(typeTint("release"), "var(--opt-violet)");
  assert.equal(typeTint("contact"), "var(--opt-blue)");
  assert.equal(typeTint("inventory"), "var(--opt-orange)");
  // an explicit emoji carries no tint → the hash, same as before
  const t1 = typeTint("gear");
  const t2 = typeTint("gear", { emoji: "🎵" });
  assert.equal(t1, t2, "same name, same color");
  assert.match(t1, /^var\(--opt-[a-z]+\)$/);
  assert.notEqual(t1, "var(--opt-gray)");
  assert.notEqual(typeTint("gear"), typeTint("crate"), "different names diverge");
});

test("defaultIcon: exact names hit the curated map, case/whitespace-insensitive (SUB-183)", () => {
  assert.deepEqual(defaultIcon("release"), { glyph: "disc", tint: "violet" });
  assert.deepEqual(defaultIcon(" Recipe "), { glyph: "utensils", tint: "red" });
  assert.deepEqual(defaultIcon("CONTACT"), { glyph: "users", tint: "blue" });
  // plurals ride their singular's entry
  assert.deepEqual(defaultIcon("recipes"), { glyph: "utensils", tint: "red" });
  assert.deepEqual(defaultIcon("tasks"), { glyph: "check-square", tint: "green" });
  // near-misses stay default-free — exact match only, no substrings
  assert.equal(defaultIcon("finance-doc"), undefined);
  assert.equal(defaultIcon("released"), undefined);
  assert.equal(defaultIcon(""), undefined);
  // every map entry points at a real glyph with a real tint
  for (const name of [
    "release", "demo", "plugin", "contact", "contacts", "people", "person",
    "shopping", "inventory", "contract", "watchlist", "fashion", "recipe",
    "recipes", "event", "task", "tasks", "todo", "book", "books", "game",
    "games", "travel", "workout", "fitness", "finance", "money", "idea",
    "ideas", "photo", "photos", "music", "project", "projects",
  ]) {
    const d = defaultIcon(name);
    assert.ok(d?.glyph && GLYPHS[d.glyph], `${name} glyph exists`);
    assert.ok(d.tint && (ICON_TINTS as readonly string[]).includes(d.tint), `${name} tint valid`);
  }
});

test("resolveIcon: an explicit schema icon always beats the curated default (SUB-183)", () => {
  assert.deepEqual(resolveIcon("release", { emoji: "🎵" }), { emoji: "🎵" });
  assert.deepEqual(resolveIcon("release", { glyph: "star" }), { glyph: "star" });
  assert.deepEqual(resolveIcon("release", { glyph: "star", tint: "teal" }), {
    glyph: "star",
    tint: "teal",
  });
  // no explicit icon → the curated default; unmapped type → undefined
  assert.deepEqual(resolveIcon("release"), { glyph: "disc", tint: "violet" });
  assert.equal(resolveIcon("gear"), undefined);
});

test("glyph registry: SUB-183 shirt/utensils present and well-formed", () => {
  assert.ok(GLYPH_IDS.includes("shirt") && GLYPH_IDS.includes("utensils"));
  assert.equal(GLYPHS.shirt.length, 1, "shirt reads as one silhouette");
  assert.ok(GLYPHS.utensils.length >= 3, "fork + handle + spoon parts");
});

test("folderDefaultIcon: curated folder names, db-name fallthrough, plain-glyph miss (SUB-391)", () => {
  assert.deepEqual(folderDefaultIcon("Finance"), { glyph: "wallet", tint: "yellow" });
  assert.deepEqual(folderDefaultIcon("Inbox"), { glyph: "inbox", tint: "blue" });
  assert.deepEqual(folderDefaultIcon(" label "), { glyph: "disc", tint: "violet" });
  // names not in the folder map fall through to the db-name defaults
  assert.deepEqual(folderDefaultIcon("Recipes"), { glyph: "utensils", tint: "red" });
  // unmatched names return undefined → callers keep the plain folder glyph
  assert.equal(folderDefaultIcon("Misc"), undefined);
  assert.equal(folderDefaultIcon(""), undefined);
  // every folder-map entry points at a real glyph
  for (const name of ["inbox", "archive", "calendar", "journal", "docs", "downloads", "work", "life", "label"]) {
    const d = folderDefaultIcon(name);
    assert.ok(d?.glyph && GLYPHS[d.glyph], `${name} glyph exists`);
  }
});

test("dashboardIcon: icon prop wins, then the per-kind mark, else undefined (SUB-391)", () => {
  // per-kind curated marks — every mapped kind resolves to a real glyph
  for (const kind of [
    "food",
    "metrics",
    "hub",
    "feed",
    "music-work",
    "tasks",
  ]) {
    const d = dashboardIcon({ dashboard: kind });
    assert.ok(d?.glyph && GLYPHS[d.glyph], `${kind} glyph exists`);
  }
  // untinted by design — the sidebar set stays one quiet gray (2026-07-24)
  assert.deepEqual(dashboardIcon({ dashboard: "food" }), { glyph: "flame" });
  // an icon: prop overrides — glyph id when known, emoji otherwise
  assert.deepEqual(dashboardIcon({ dashboard: "food", icon: "zap" }), { glyph: "zap" });
  assert.deepEqual(dashboardIcon({ dashboard: "food", icon: "🔥" }), { emoji: "🔥" });
  // unknown kind / chart notes keep the generic mark (undefined here)
  assert.equal(dashboardIcon({ dashboard: "charts" }), undefined);
  assert.equal(dashboardIcon({}), undefined);
  // malformed props read as no icon, never an error
  assert.equal(dashboardIcon({ dashboard: 7, icon: ["x"] } as unknown as Record<string, unknown>), undefined);
});

test("dashboardIcon: normalizes the kind exactly as the dispatch does (SUB-1021)", () => {
  // trim, like resolveDashboardKind — surrounding whitespace is a hand-edit
  assert.deepEqual(dashboardIcon({ dashboard: "  food  " }), { glyph: "flame" });
  // but NO case-fold: lowercase is the id grammar (KIND_ID_RE), so `Tasks` is
  // an unknown kind the pane refuses — the sidebar must not promise its board
  assert.equal(dashboardIcon({ dashboard: "Tasks" }), undefined);
  assert.equal(dashboardIcon({ dashboard: "FOOD" }), undefined);
});
