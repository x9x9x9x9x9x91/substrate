import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blankNonCode } from "../../scripts/check-ipc.ts";
import {
  FIXED_VIEW_COMMANDS,
  GENERATED_VIEW_KINDS,
  HOIST_MIN,
  hoistAboveContent,
  markLabel,
  markSnippet,
  onlyFallbacks,
  paletteShortcutIds,
  partsFromRuns,
  queryVariants,
  rankCommands,
  rankScore,
  synFuzzyScore,
} from "./palette.ts";
import { shortcutById, shortcutKeyLabel } from "./shortcuts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

type Row = { id: string; label: string; section: string; dest?: string };
const row = (id: string, section: string, label = id, dest?: string): Row => ({
  id,
  label,
  section,
  dest,
});

/** the command set the audit shot renders for query "release" */
function releaseCommands(): Row[] {
  return [
    row("cmd:new", "Commands", "New note “release”"),
    row("cmd:newfolder", "Commands", "New folder…"),
    row("cmd:tasks", "Commands", "Go to Tasks", "Tasks"),
    row("cmd:notes", "Commands", "Go to Scratch", "Scratch"),
    row("cmd:trash", "Commands", "Open Trash", "Trash"),
    row("cmd:db:release", "Commands", "Go to Release", "Release"),
  ];
}

test("rankScore: a destination name lifts its row into the prefix band", () => {
  const go = row("cmd:db:release", "Commands", "Go to Release", "Release");
  // the label alone is only a word-start match (< 700); the dest is a prefix
  assert.ok(rankScore("release", go) >= HOIST_MIN);

  const plain = row("cmd:new", "Commands", "New note “release”");
  assert.ok(rankScore("release", plain) < rankScore("release", go));
});

test("rankCommands: best score first, the exact db name beats New note", () => {
  const { ranked, hoisted } = rankCommands("release", releaseCommands());
  assert.equal(ranked[0].id, "cmd:db:release");
  assert.deepEqual(
    hoisted.map((c) => c.id),
    ["cmd:db:release"],
  );
});

test("rankCommands: an empty query keeps declaration order, hoists nothing", () => {
  const cmds = releaseCommands();
  const { ranked, hoisted } = rankCommands("   ", cmds);
  assert.deepEqual(ranked, cmds);
  assert.deepEqual(hoisted, []);
});

test("rankCommands: score ties keep declaration order", () => {
  // "Go to Tasks" and "Go to Scratch" are both prefix matches of equal length
  const { ranked } = rankCommands("go to", releaseCommands());
  assert.equal(ranked[0].id, "cmd:tasks");
  assert.equal(ranked[1].id, "cmd:notes");
});

test("rankCommands: non-destinations rank but never hoist", () => {
  const cmds = [row("cmd:rel", "Commands", "Release checklist…")];
  const { ranked, hoisted } = rankCommands("release", cmds);
  assert.equal(ranked.length, 1, "prefix match still ranks");
  assert.deepEqual(hoisted, []);
});

test("rankCommands: a mid-name substring matches without hoisting", () => {
  // "eleas" sits mid-word in both labels: both rank (500 band), neither hoists
  const { ranked, hoisted } = rankCommands("eleas", releaseCommands());
  assert.deepEqual(
    ranked.map((c) => c.id),
    ["cmd:db:release", "cmd:new"],
  );
  assert.deepEqual(hoisted, []);
});

/**
 * Labels say "New" / "Trash" / "Settings" but people type "create" /
 * "delete" / "preferences" — the rewrite maps verbs token-wise and drops
 * articles, and scoring takes the best of original and rewritten query.
 */
test("queryVariants: synonym verbs and articles rewrite, literals pass through", () => {
  assert.deepEqual(queryVariants("create database"), ["create database", "new database"]);
  assert.deepEqual(queryVariants("create a note"), ["create a note", "new note"]);
  assert.deepEqual(queryVariants("new database"), ["new database"]);
  assert.deepEqual(queryVariants("release"), ["release"]);
});

test("synFuzzyScore: 'create database' prefix-matches 'New database…'", () => {
  assert.ok(synFuzzyScore("create database", "New database…") >= HOIST_MIN);
  // the rewrite never beats a literal typed match on its own label
  assert.ok(synFuzzyScore("new database", "New database…") >= HOIST_MIN);
});

test("rankCommands: synonym queries surface the real command, not just fallbacks", () => {
  const cmds = [
    row("cmd:new", "Commands", "New note “create note”"),
    row("cmd:newdb", "Commands", "New database…"),
    row("cmd:newsheet", "Commands", "New sheet “create note”"),
    row("cmd:trashview", "Commands", "Open Trash", "Trash"),
    row("cmd:settings", "Commands", "Settings…"),
  ];
  assert.equal(rankCommands("create database", cmds).ranked[0].id, "cmd:newdb");
  assert.equal(rankCommands("create note", cmds).ranked[0].id, "cmd:new");
  assert.equal(rankCommands("delete", cmds).ranked[0].id, "cmd:trashview");
  assert.equal(rankCommands("preferences", cmds).ranked[0].id, "cmd:settings");
});

test("rankCommands: synonym rewrite never drops a literal match", () => {
  // "create" appears verbatim in the New-note fallback label — still ranks
  const cmds = [row("cmd:new", "Commands", "New note “create”")];
  assert.equal(rankCommands("create", cmds).ranked.length, 1);
});

/**
 * Ranking filtered on `s > 0`, but a real match late in a long label
 * scores negative (0.2 penalty per character of position) — so a row the query
 * genuinely matches vanished from the palette instead of ranking last.
 */
test("rankCommands: a weak late match ranks last, it does not vanish (SUB-1016)", () => {
  const long = "Spectral Granular Synthesis Notes from the Berlin Studio Session — Workflow Quirks";
  const cmds = [row("cmd:long", "Commands", long), row("cmd:wq", "Commands", "Wq shortcut")];
  const { ranked } = rankCommands("wq", cmds);
  assert.deepEqual(
    ranked.map((c) => c.id),
    ["cmd:wq", "cmd:long"],
    "the long label matches 'wq' as a subsequence — it ranks below the prefix hit, not out",
  );
});

test("rankCommands: a genuine miss is still dropped (SUB-1016)", () => {
  const { ranked } = rankCommands("zzqqxx", releaseCommands());
  assert.deepEqual(ranked, [], "nothing threads that query — every row drops");
});

test("hoistAboveContent: hoisted rows land directly under the Notes section", () => {
  const items = [
    row("note:a", "Notes"),
    row("note:b", "Notes"),
    row("hit:a", "Content"),
    row("cmd:searchall", "Search"),
    row("cmd:new", "Commands"),
    row("cmd:db:release", "Commands", "Go to Release", "Release"),
  ];
  const out = hoistAboveContent(items, [items[5]]);
  assert.deepEqual(
    out.map((i) => i.id),
    ["note:a", "note:b", "cmd:db:release", "hit:a", "cmd:searchall", "cmd:new"],
  );
});

test("hoistAboveContent: no Notes rows — hoisted goes above Content", () => {
  const items = [
    row("hit:a", "Content"),
    row("cmd:searchall", "Search"),
    row("cmd:db:release", "Commands", "Go to Release", "Release"),
  ];
  const out = hoistAboveContent(items, [items[2]]);
  assert.deepEqual(
    out.map((i) => i.id),
    ["cmd:db:release", "hit:a", "cmd:searchall"],
  );
});

test("hoistAboveContent: no sections at all — hoisted goes first", () => {
  const items = [row("cmd:new", "Commands"), row("cmd:tasks", "Commands", "Go to Tasks", "Tasks")];
  const out = hoistAboveContent(items, [items[1]]);
  assert.deepEqual(
    out.map((i) => i.id),
    ["cmd:tasks", "cmd:new"],
  );
});

test("hoistAboveContent: nothing hoisted leaves the list untouched", () => {
  const items = [row("note:a", "Notes"), row("cmd:new", "Commands")];
  assert.deepEqual(hoistAboveContent(items, []), items);
});

/**
 * The fallback rows echo the query in their labels, so they always
 * survive ranking. The banner used to key off an id whitelist and went dark
 * the moment "New sheet" joined them.
 */
type FbRow = { id: string; label: string; fallback?: true };
const fb = (id: string, label: string): FbRow => ({ id, label, fallback: true });
/** a real match — no fallback flag */
const hit = (id: string, label: string): FbRow => ({ id, label });

test("onlyFallbacks: query-echoing rows alone mean zero real hits", () => {
  assert.equal(onlyFallbacks([fb("cmd:new", "New note “zzzqqq”")]), true);
  assert.equal(
    onlyFallbacks([
      fb("cmd:new", "New note “zzzqqq”"),
      fb("cmd:newsheet", "New sheet “zzzqqq”"),
      fb("cmd:searchall", "See all results for “zzzqqq”…"),
    ]),
    true,
  );
});

test("onlyFallbacks: a real hit next to the fallbacks is not 'no results'", () => {
  assert.equal(
    onlyFallbacks([
      hit("note:a", "Release plan"),
      fb("cmd:new", "New note “release”"),
      fb("cmd:newsheet", "New sheet “release”"),
    ]),
    false,
  );
});

test("onlyFallbacks: a non-echoing command is a real hit", () => {
  // "New folder…" only shows when the query fuzzy-matches it
  assert.equal(
    onlyFallbacks([hit("cmd:newfolder", "New folder…"), fb("cmd:new", "New note “fold”")]),
    false,
  );
});

test("onlyFallbacks: an empty list is not 'no results' (still loading)", () => {
  assert.equal(onlyFallbacks([]), false);
});

/**
 * Palette rows mark why they matched, in the search pane's
 * part language (alternating plain/hit runs).
 */
test("markLabel: substring match marks the run, original casing kept", () => {
  const parts = markLabel("mast", "Master Vessel Songs v3");
  assert.ok(parts);
  assert.deepEqual(parts![0], { text: "Mast", hit: true });
  assert.equal(parts!.map((p) => p.text).join(""), "Master Vessel Songs v3");
});

test("markLabel: synonym rewrite marks the real command label", () => {
  // people type "create database", the label says "New database…" — the
  // rewrite is what ranked it, so the rewrite is what marks it
  const parts = markLabel("create database", "New database…");
  assert.ok(parts, "the rewrite must thread through the label");
  assert.ok(parts!.some((p) => p.hit), "at least one marked run");
  assert.equal(parts!.map((p) => p.text).join(""), "New database…");
});

test("markLabel: no thread through the visible label → null (render plain)", () => {
  // a row can rank via its bare dest name or a daily's stem face while the
  // VISIBLE label never threads — null says "render plain", never guess
  assert.equal(markLabel("xyz", "Go to Release"), null);
  assert.equal(markLabel("", "anything"), null);
});

test("markSnippet: engine word-prefix language — whole token marked", () => {
  const parts = markSnippet("mast", "Two masters in, one artwork out");
  assert.ok(parts);
  const hit = parts!.filter((p) => p.hit);
  assert.deepEqual(hit, [{ text: "masters", hit: true }]);
  assert.equal(parts!.map((p) => p.text).join(""), "Two masters in, one artwork out");
});

test("markSnippet: every query token marks, mid-word never does", () => {
  const parts = markSnippet("art out", "Two masters in, one artwork out");
  assert.ok(parts);
  const hits = parts!.filter((p) => p.hit).map((p) => p.text);
  assert.deepEqual(hits, ["artwork", "out"]);
  // "ast" is mid-word in "masters" — the FTS tokenizer only prefix-matches
  assert.equal(markSnippet("ast", "Two masters in"), null);
});

test("markSnippet: accents read the way the tokenizer reads them", () => {
  // the FTS tokenizer runs `remove_diacritics 2`, so "cafe" is what matched
  // "café" in the first place — a literal mark leaves the row plain while the
  // full-search pane highlights the same hit
  const parts = markSnippet("cafe", "the café by the lake");
  assert.ok(parts, "an accent-folded query must still mark");
  assert.deepEqual(parts!.filter((p) => p.hit), [{ text: "café", hit: true }]);
  assert.equal(parts!.map((p) => p.text).join(""), "the café by the lake");

  // both directions: an accented query marks the plain word
  const back = markSnippet("café", "the cafe by the lake");
  assert.ok(back);
  assert.deepEqual(back!.filter((p) => p.hit), [{ text: "cafe", hit: true }]);

  // decomposed text (e + combining acute) marks whole, accent included
  const nfd = markSnippet("cafe", "the cafe\u0301 by the lake");
  assert.ok(nfd);
  assert.deepEqual(nfd!.filter((p) => p.hit), [{ text: "cafe\u0301", hit: true }]);
  assert.equal(nfd!.map((p) => p.text).join(""), "the cafe\u0301 by the lake");

  // folding never invents a hit where the tokenizer has none
  assert.equal(markSnippet("cafe", "the tearoom by the lake"), null);
});

test("markSnippet: regex metachars in the query stay literal", () => {
  const parts = markSnippet("c++", "notes on c++ builds");
  assert.ok(parts, "an escaped query must not throw or miss");
  assert.ok(parts!.some((p) => p.hit));
});

test("partsFromRuns: runs at the edges keep the whole text", () => {
  assert.deepEqual(partsFromRuns("abc", [{ start: 0, end: 3 }]), [{ text: "abc", hit: true }]);
  assert.deepEqual(partsFromRuns("abc", [{ start: 1, end: 2 }]), [
    { text: "a", hit: false },
    { text: "b", hit: true },
    { text: "c", hit: false },
  ]);
});

/* ── catalogue drift ──────────────────────────────────────────────────────
   The palette's destination list used to be hand-maintained JSX with nothing
   watching it, and it lost whole surfaces that way: Calendar had ⌘4 and no
   row, the journal had ⌘D and no row, Vault sync and What's new had sidebar
   glyphs and no row, saved views and tags had no keyboard route at all. These
   re-derive the truth from the two files that own it — the `View` union and
   the shortcut registry — so the next surface cannot go missing quietly. */

/** Every `kind:` in the `View` union, read out of the source. Matching runs
    on the comment- and string-blanked copy so prose in the union's doc
    comments cannot invent a kind, and each name is then cut out of the
    ORIGINAL at the offset that matched — blanking hollows string bodies out,
    it does not remove them. Kinds behind share-mirror fences need no special
    case: the palette catalogue fences the same ones, so both sides strip
    together. */
function viewKinds(): string[] {
  const src = readFileSync(resolve(HERE, "types.ts"), "utf8");
  const code = blankNonCode(src, "ts");
  const from = code.indexOf("export type View =");
  assert.ok(from !== -1, "the View union moved or was renamed");
  // the union ends at its first `;` OUTSIDE a member's braces — the `;`
  // separating `kind` from `type` in `{ kind: "db"; type: string }` is not it
  let to = -1;
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") depth -= 1;
    else if (code[i] === ";" && depth === 0) {
      to = i;
      break;
    }
  }
  assert.ok(to !== -1, "the View union has no terminator");
  const kinds: string[] = [];
  for (const m of code.slice(from, to).matchAll(/kind:\s*"[^"]*"/g)) {
    const at = from + (m.index ?? 0) + m[0].indexOf('"') + 1;
    kinds.push(src.slice(at, src.indexOf('"', at)));
  }
  assert.ok(kinds.length > 5, "the View union parsed to almost nothing");
  assert.ok(kinds.every((k) => /^[a-z]+$/.test(k)), `unparsed view kind: ${kinds}`);
  return kinds;
}

test("every view kind is either a fixed palette row or a named generator", () => {
  const fixed = new Set<string>(FIXED_VIEW_COMMANDS.map((c) => c.view.kind));
  const missing = viewKinds().filter((k) => !fixed.has(k) && !(k in GENERATED_VIEW_KINDS));
  assert.deepEqual(
    missing,
    [],
    `view kinds with no palette route: ${missing.join(", ")} — add a row to ` +
      "FIXED_VIEW_COMMANDS, or name the rows that generate it in GENERATED_VIEW_KINDS"
  );
});

test("the catalogue names no view kind the union dropped", () => {
  const kinds = new Set(viewKinds());
  const stale = [
    ...FIXED_VIEW_COMMANDS.map((c) => c.view.kind),
    ...Object.keys(GENERATED_VIEW_KINDS),
  ].filter((k) => !kinds.has(k));
  assert.deepEqual(stale, [], `palette rows for kinds the View union no longer has: ${stale}`);
});

test("each generated kind is generated the way it claims to be", () => {
  const src = readFileSync(resolve(HERE, "..", "components", "Palette.tsx"), "utf8");
  for (const [kind, how] of Object.entries(GENERATED_VIEW_KINDS)) {
    if (how === "row") {
      assert.match(src, new RegExp(`kind: "${kind}"`), `no palette row builds a ${kind} view`);
    } else {
      // the opener resolves database-or-mount, so neither kind is named here
      assert.doesNotMatch(
        src,
        new RegExp(`kind: "${kind}"`),
        `${kind} claims the opener but the palette builds the view itself`
      );
    }
  }
  // and the opener really is the door the database rows take
  assert.match(src, /run: \(\) => onOpenDb\(/);
});

test("no fixed destination is listed twice", () => {
  const ids = FIXED_VIEW_COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate palette row id");
  const kinds = FIXED_VIEW_COMMANDS.map((c) => c.view.kind);
  assert.equal(new Set(kinds).size, kinds.length, "two rows for one destination");
});

/** Every registry id the palette asks for a keycap, from BOTH sources: the
    catalogue's own `shortcut` fields and the ids written inline at the rows
    that aren't catalogue entries (undo, redo, the terminal toggle…). The
    inline half is read out of the component source rather than re-listed
    here, so a row added tomorrow is covered without anyone remembering to
    add it — the failure being guarded against is a lookup that THROWS, and
    it throws inside the palette's own render, which takes the whole overlay
    down with it. */
function paletteKeycapIds(): string[] {
  const src = readFileSync(resolve(HERE, "..", "components", "Palette.tsx"), "utf8");
  const calls = [...src.matchAll(/shortcutKeyLabel\("([^"]+)"\)/g)].map((m) => m[1]);
  // A call whose id is not a literal would read as zero call sites here and
  // pass in silence, so count the bare occurrences and demand they match.
  // Two occurrences are neither: the import, and the one lookup that reads a
  // catalogue entry's own field — that one is covered by paletteShortcutIds
  // below, and it is asserted by its exact text so it cannot quietly become
  // some other variable the sweep would then be blind to.
  assert.match(src, /hint: shortcutKeyLabel\(c\.shortcut\)/);
  const occurrences = [...src.matchAll(/shortcutKeyLabel\b/g)].length - 2;
  assert.equal(
    calls.length,
    occurrences,
    "a keycap lookup in Palette.tsx does not pass a literal id — this test cannot see it"
  );
  assert.ok(calls.length >= 7, "the keycap call sites vanished — did the regex go stale?");
  return [...new Set([...paletteShortcutIds(), ...calls])];
}

test("every keycap the palette prints resolves in the shortcut registry", () => {
  for (const id of paletteKeycapIds()) {
    // throws on an unknown id, which is the failure this test exists to catch
    // before a render does it in front of someone
    assert.ok(shortcutKeyLabel(id).length > 0, `${id} has no printable combo`);
  }
});

test("the keycap sweep sees the rows outside the catalogue", () => {
  // the catalogue's own fields would pass the test above on their own; these
  // are the inline ones, which is the half that had no cover
  const ids = paletteKeycapIds();
  for (const id of ["undo", "redo", "new-note", "terminal-toggle", "settings-open"]) {
    assert.ok(ids.includes(id), `the sweep missed the ${id} row`);
  }
});

test("a derived keycap matches the sheet's own spelling", () => {
  // the drift that started this: the redo row printed ⇧⌘Z while the sheet
  // spelled it the other way round. Derivation makes one of them impossible.
  const redo = shortcutById("redo");
  assert.ok(redo);
  assert.ok(redo!.keys.startsWith(shortcutKeyLabel("redo")));
  // and the keycap stays one combo, not the sheet's "… / ⌃Y" pair
  assert.doesNotMatch(shortcutKeyLabel("redo"), /\//);
});
