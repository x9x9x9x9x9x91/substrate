import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  fenceDbType,
  fenceExit,
  fenceInner,
  fenceKeysUsed,
  fenceLang,
  inCodeContext,
  slashCommands,
  slashOptions,
  slashQuery,
  viewFenceKeys,
  viewKeyOptions,
  viewKeyQuery,
  viewQueryPropOptions,
  viewSortDirOptions,
  viewTypeOptions,
  viewTypeQuery,
  viewValueQuery,
} from "./slashmenu.ts";
import { KNOWN_KEYS } from "./embeds.ts";
import { todayIso } from "./dates.ts";

/** The editor's own parser config (Editor.tsx), so the node types these tests
    see are the ones the app sees — inside a highlighted ```bash fence the
    cursor's node is anonymous and only its `FencedCode` parent names it. */
function stateAt(doc: string) {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, codeLanguages: languages })],
  });
  ensureSyntaxTree(state, doc.length, 8000);
  return state;
}

/** Would the slash palette open with the cursor at the end of `doc`? Both
    halves of the real gate: the text trigger and the syntax-tree check. */
function opensAt(doc: string): string | null {
  const query = slashQuery(doc);
  if (query === null) return null;
  const state = stateAt(doc);
  const node = syntaxTree(state).resolveInner(doc.length, -1);
  return inCodeContext(node) ? null : query;
}

/** `viewTypeQuery` as Editor calls it — fence identity off the tree. */
function typeQueryAt(doc: string): string | null {
  const state = stateAt(doc);
  const node = syntaxTree(state).resolveInner(doc.length, -1);
  return viewTypeQuery(doc, fenceLang(node, (from, to) => state.sliceDoc(from, to)));
}

test("slashQuery: only a line-initial /", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/vi"), "vi");
  // a fresh line, and an indented one (list item continuation), both open it
  assert.equal(slashQuery("prose\n/da"), "da");
  assert.equal(slashQuery("prose\n  \t/t"), "t");
  // mid-line prose, URLs and closed paths must never pop the menu
  assert.equal(slashQuery("see /vi"), null);
  assert.equal(slashQuery("https://x.dev/a"), null);
  assert.equal(slashQuery("prose /"), null);
  // a space ends the guess, and non-letters aren't command names
  assert.equal(slashQuery("/view "), null);
  assert.equal(slashQuery("/2"), null);
  // no slash at all
  assert.equal(slashQuery("plain text"), null);
});

test("slash palette stays shut inside code", () => {
  // a leading `/` in a shell fence is a path, not a command: typing /usr and
  // pressing Enter for a newline must not rewrite the line
  assert.equal(opensAt("```bash\nls\n/usr"), null);
  assert.equal(opensAt("```js\n/re"), null);
  assert.equal(opensAt("```\n/"), null);
  // the fence the feature itself just inserted — firing here would nest a
  // second fence inside the embed spec
  assert.equal(opensAt("```view\ntype: release\n/da"), null);
  // an indented (4-space) code block, and an inline `…` span mid-sentence
  assert.equal(opensAt("    /usr"), null);
  assert.equal(opensAt("`/da"), null);
  // …and still opens everywhere it should: prose, and after a fence closes
  assert.equal(opensAt("prose\n/da"), "da");
  assert.equal(opensAt("```bash\nls\n```\n\n/da"), "da");
});

test("fence identity comes off the tree, not a backward ``` scan", () => {
  // B2: a ```view line inside a ```bash block is shell text. A scan for the
  // nearest ``` finds that opener and can't tell it from a closer.
  assert.equal(typeQueryAt("```bash\ncat <<'EOF'\n```view\ntype: rel"), null);
  assert.equal(typeQueryAt("```view\ntype: rel"), "rel");
  assert.equal(typeQueryAt("```view\ntype: "), "");
  assert.equal(typeQueryAt("prose\n\n```view\nquery: x\ntype: rel"), "rel");
  // other keys, other languages, and a fence that has already closed
  assert.equal(typeQueryAt("```view\nsaved: x"), null);
  assert.equal(typeQueryAt("```ts\ntype: rel"), null);
  assert.equal(typeQueryAt("```view\ntype: release\n```\ntype: rel"), null);
  assert.equal(typeQueryAt("type: rel"), null);
});

test("slashOptions: everything on a bare slash, fuzzy-narrowed after", () => {
  assert.deepEqual(
    slashOptions("").map((c) => c.name),
    [
      "asset",
      "calc",
      "calendar",
      "cards",
      "chart",
      "csv",
      "date",
      "formulas",
      "heatmap",
      "live",
      "progress",
      "table",
      "task",
      "timeline",
      "view",
    ]
  );
  assert.deepEqual(
    slashOptions("vi").map((c) => c.name),
    ["view"]
  );
  // "a" is a substring of several names — the prefix match ranks first
  assert.equal(slashOptions("a")[0].name, "asset");
  assert.deepEqual(slashOptions("zzz"), []);
});

test("slashCommands: insert text and cursor land where the next keystroke goes", () => {
  const by = (name: string) => slashCommands().find((c) => c.name === name)!;

  const view = by("view");
  assert.equal(view.insert, "```view\ntype: \n```");
  // cursor sits after `type: ` so the db-name completion fires immediately
  assert.equal(view.insert.slice(view.cursor), "\n```");

  // the task shape is the vault's markdown checkbox (docs/vault-format.md)
  assert.equal(by("task").insert, "- [ ] ");
  assert.equal(by("task").cursor, 6);

  assert.equal(by("date").insert, todayIso());

  // asset embeds are ![[name]] — cursor between the brackets
  const asset = by("asset");
  assert.equal(asset.insert, "![[]]");
  assert.equal(asset.insert.slice(0, asset.cursor), "![[");
});

test("/table scaffolds a real table with the cursor in the first header cell", () => {
  const table = slashCommands().find((c) => c.name === "table")!;
  assert.equal(table.insert, "|  |  |\n| --- | --- |\n|  |  |");
  // the cursor sits inside the first header cell, not on the pipe
  assert.equal(table.insert.slice(0, table.cursor), "| ");
  assert.equal(table.insert[table.cursor], " ");

  // and the parser agrees it is a table — an empty-celled header still counts,
  // which is what lets the columns be named after the fact
  const state = stateAt(table.insert);
  let found = false;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "Table") found = true;
    },
  });
  assert.ok(found, "scaffold must parse as a Table");

  // three lines: header, delimiter, one body row — the rendered grid reads the
  // delimiter for alignment and every line after it as a row
  const lines = table.insert.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0].split("|").length, lines[1].split("|").length);
});

test("fence scaffolds: well-formed fences, cursor on the first value, fenceExit walks out", () => {
  // every command that inserts a fence, without naming them one by one — so
  // this holds for whatever set of fences a given build of the app carries
  const fences = slashCommands().filter((c) => c.insert.startsWith("```"));
  assert.ok(fences.length >= 4);
  for (const cmd of fences) {
    // opener names the command, closer on its own line
    assert.ok(cmd.insert.startsWith("```" + cmd.name + "\n"), cmd.name);
    assert.ok(cmd.insert.endsWith("\n```"), cmd.name);
    // the cursor sits at the end of the first body line — typing continues
    // into the first config value, never into the opener or a later key
    const rest = cmd.insert.slice(cmd.cursor);
    assert.ok(rest === "\n```" || rest.startsWith("\n"), cmd.name);
    assert.ok(!cmd.insert.slice(0, cmd.cursor).endsWith("`"), cmd.name);
    // and the remainder is exactly what fenceExit knows how to step out of
    assert.ok(fenceExit(rest), cmd.name);
  }

  // one public exemplar pinned exactly: the chart parser requires source, x, y
  const chart = slashCommands().find((c) => c.name === "chart")!;
  assert.equal(chart.insert, "```chart\nsource: \nx: \ny: count\n```");
  assert.equal(chart.insert.slice(0, chart.cursor), "```chart\nsource: ");

  // and one bare-form fence: heatmap requires source, date, value
  const heatmap = slashCommands().find((c) => c.name === "heatmap")!;
  assert.equal(heatmap.insert, "```heatmap\nsource: \ndate: \nvalue: count\n```");
  assert.equal(heatmap.insert.slice(0, heatmap.cursor), "```heatmap\nsource: ");
});

test("viewTypeQuery: only the type: line, and only in a view fence", () => {
  // the line half, with the fence verdict passed in
  assert.equal(viewTypeQuery("```view\ntype: ", "view"), "");
  assert.equal(viewTypeQuery("```view\ntype: rel", "view"), "rel");
  assert.equal(viewTypeQuery("```view\n  type: rel", "view"), "rel");
  // other keys on that line stay quiet even inside the right fence
  assert.equal(viewTypeQuery("```view\nsaved: x", "view"), null);
  assert.equal(viewTypeQuery("```view\nquery: rel", "view"), null);
  // any other fence language, a fence with no info string, and no fence at all
  assert.equal(viewTypeQuery("```ts\ntype: rel", "ts"), null);
  assert.equal(viewTypeQuery("```\ntype: rel", ""), null);
  assert.equal(viewTypeQuery("type: rel", null), null);
});

test("viewTypeOptions: live db names, fuzzy, dupes and blanks dropped", () => {
  const types = ["release", "gear", "  ", "track", "release"];
  assert.deepEqual(viewTypeOptions("", types), ["gear", "release", "track"]);
  assert.deepEqual(viewTypeOptions("rel", types), ["release"]);
  assert.deepEqual(viewTypeOptions("zzz", types), []);
});

/* ---------- fenceExit ---------- */

// `after` is the doc from the cursor onward; the cursor sits on the `type:`
// line's value, so the first line of `after` is that line's remainder.

test("fenceExit: an existing blank line below the fence is the landing spot", () => {
  const after = "\n```\n\nnext paragraph";
  const exit = fenceExit(after);
  assert.deepEqual(exit, { anchor: 5, insertAt: 5, insert: "" });
  // anchor lands at the start of the blank line, outside the fence
  assert.equal(after.slice(0, exit!.anchor), "\n```\n");
});

test("fenceExit: text right below the fence gets a blank line opened for it", () => {
  const after = "\n```\nnext paragraph";
  const exit = fenceExit(after);
  assert.ok(exit);
  const doc = after.slice(0, exit.insertAt) + exit.insert + after.slice(exit.insertAt);
  assert.equal(doc, "\n```\n\nnext paragraph");
  assert.equal(doc.slice(0, exit.anchor), "\n```\n");
});

test("fenceExit: a fence closing the document opens a line to land on", () => {
  const after = "\n```";
  const exit = fenceExit(after);
  assert.ok(exit);
  const doc = after.slice(0, exit.insertAt) + exit.insert + after.slice(exit.insertAt);
  assert.equal(doc, "\n```\n");
  assert.equal(exit.anchor, doc.length);
});

test("fenceExit: extra fence body lines are skipped to reach the closer", () => {
  const after = "\nquery: status:live\nview: table\n```\n\ntail";
  const exit = fenceExit(after);
  assert.ok(exit);
  assert.equal(after.slice(0, exit.anchor), "\nquery: status:live\nview: table\n```\n");
});

test("fenceExit: no closer in the window leaves the cursor alone", () => {
  assert.equal(fenceExit("\ntype: release"), null);
  assert.equal(fenceExit(""), null);
});

/* ---------- the rest of the fence: keys and their values ---------- */

test("the key popup teaches exactly the keys the parser accepts", () => {
  const taught = viewFenceKeys().map((k) => k.name);
  assert.deepEqual([...taught].sort(), [...KNOWN_KEYS].sort());
  // every key carries a hint — a bare list of seven words teaches nothing
  for (const key of viewFenceKeys()) assert.ok(key.detail.length > 0, key.name);
});

test("viewKeyQuery: a bare word inside a view fence is a key being typed", () => {
  assert.equal(viewKeyQuery("```view\n", "view"), "");
  assert.equal(viewKeyQuery("```view\nco", "view"), "co");
  assert.equal(viewKeyQuery("```view\n  co", "view"), "co");
  // once the colon is typed the line is a value, not a key
  assert.equal(viewKeyQuery("```view\ncolumns:", "view"), null);
  // the fence's own lines never pop it
  assert.equal(viewKeyQuery("```view", "view"), null);
  assert.equal(viewKeyQuery("```view\ntype: release\n```", "view"), null);
  // and no other fence, or no fence at all, does either
  assert.equal(viewKeyQuery("```yaml\nco", "yaml"), null);
  assert.equal(viewKeyQuery("co", null), null);
});

test("viewKeyOptions: fuzzy, and keys the fence already carries are dropped", () => {
  assert.deepEqual(
    viewKeyOptions("col").map((k) => k.name),
    ["columns"]
  );
  const fresh = viewKeyOptions("").map((k) => k.name);
  assert.equal(fresh.length, KNOWN_KEYS.length);
  const rest = viewKeyOptions("", ["type", "QUERY"]).map((k) => k.name);
  assert.ok(!rest.includes("type"));
  assert.ok(!rest.includes("query"));
  assert.equal(rest.length, KNOWN_KEYS.length - 2);
});

test("viewValueQuery: each key asks for the value list that fits it", () => {
  assert.deepEqual(viewValueQuery("```view\nsaved: umbra un", "view"), {
    slot: "saved",
    query: "umbra un",
  });
  assert.deepEqual(viewValueQuery("```view\nsort: rel", "view"), {
    slot: "sort",
    query: "rel",
  });
  // past the colon the sort line wants a direction, not another property
  assert.deepEqual(viewValueQuery("```view\nsort: released:de", "view"), {
    slot: "sortdir",
    query: "de",
  });
  // a columns list completes item by item, the separator's space excluded
  assert.deepEqual(viewValueQuery("```view\ncolumns: status, art", "view"), {
    slot: "columns",
    query: "art",
  });
  assert.deepEqual(viewValueQuery("```view\ncolumns: ", "view"), {
    slot: "columns",
    query: "",
  });
  // a filter term completes its property, then that property's used values
  assert.deepEqual(viewValueQuery("```view\nquery: stat", "view"), {
    slot: "query",
    query: "stat",
  });
  assert.deepEqual(viewValueQuery("```view\nquery: status:un", "view"), {
    slot: "queryvalue",
    prop: "status",
    query: "un",
  });
  // only the term under the cursor
  assert.deepEqual(viewValueQuery("```view\nquery: status:live art", "view"), {
    slot: "query",
    query: "art",
  });
});

test("viewValueQuery: the lines with nothing to offer stay quiet", () => {
  // type: is viewTypeQuery's; limit: is a number; view: renders as table today
  assert.equal(viewValueQuery("```view\ntype: rel", "view"), null);
  assert.equal(viewValueQuery("```view\nlimit: 5", "view"), null);
  assert.equal(viewValueQuery("```view\nview: ta", "view"), null);
  assert.equal(viewValueQuery("```view\nsortt: rel", "view"), null);
  assert.equal(viewValueQuery("```view\nnot a key line", "view"), null);
  // a comma-OR list or a quoted term: completing inside it would replace the
  // wrong slice of what was typed
  assert.equal(viewValueQuery('```view\nquery: status:live,"in re', "view"), null);
  assert.equal(viewValueQuery("```view\nquery: due < 7", "view"), null);
  // and never outside a view fence
  assert.equal(viewValueQuery("```yaml\nsort: rel", "yaml"), null);
  assert.equal(viewValueQuery("sort: rel", null), null);
});

test("viewSortDirOptions: both directions, fuzzy", () => {
  assert.deepEqual(viewSortDirOptions(""), ["asc", "desc"]);
  assert.deepEqual(viewSortDirOptions("de"), ["desc"]);
});

test("fenceInner: the fence body, closed or still being typed", () => {
  const doc = "text\n\n```view\ntype: release\nsort: released:desc\n```\n\ntail";
  const state = stateAt(doc);
  const at = doc.indexOf("sort:") + 5;
  const node = syntaxTree(state).resolveInner(at, -1);
  assert.equal(
    fenceInner(node, (from, to) => state.sliceDoc(from, to)),
    "type: release\nsort: released:desc"
  );
  // an unclosed fence has no closer line to drop
  const open = "```view\ntype: release\n";
  const openState = stateAt(open);
  const openNode = syntaxTree(openState).resolveInner(open.length, -1);
  assert.equal(
    fenceInner(openNode, (from, to) => openState.sliceDoc(from, to)),
    "type: release\n"
  );
  // outside any fence there is no body
  const prose = stateAt("just text");
  assert.equal(
    fenceInner(syntaxTree(prose).resolveInner(4, -1), (from, to) => prose.sliceDoc(from, to)),
    null
  );
});

test("fenceKeysUsed / fenceDbType: what the fence already says about itself", () => {
  const inner = "# a comment\ntype: Release\nsort: released:desc\n";
  assert.deepEqual(fenceKeysUsed(inner), ["type", "sort"]);
  assert.equal(fenceDbType(inner), "Release");
  // a saved: fence names its database through the pin
  const pins = [{ name: "Umbra unreleased", db: "release" }];
  assert.equal(fenceDbType("saved: umbra UNRELEASED\n", pins), "release");
  assert.equal(fenceDbType("saved: nothing-here\n", pins), null);
  // a fence that names neither has no database to offer properties from
  assert.equal(fenceDbType("sort: rel\n", pins), null);
  assert.equal(fenceDbType("type: \n", pins), null);
});

test("fenceDbType: a saved: line in ID form resolves too, id before name", () => {
  // what `savedViewFence` writes when the pin's name is ambiguous or carries
  // a `:` — the fence renders fine, so its completions must work too
  const pins = [
    { id: "rel-unreleased", name: "Umbra: unreleased", db: "release" },
    { id: "task-open", name: "Open work", db: "task" },
  ];
  assert.equal(fenceDbType("saved: rel-unreleased\n", pins), "release");
  assert.equal(fenceDbType("saved:   REL-Unreleased  \n", pins), "release");
  // name still resolves, and untrimmed
  assert.equal(fenceDbType("saved:  open WORK \n", pins), "task");
  // an id wins over a pin that merely carries the same string as its name
  const collide = [
    { id: "b", name: "a", db: "byname" },
    { id: "a", name: "z", db: "byid" },
  ];
  assert.equal(fenceDbType("saved: a\n", collide), "byid");
  assert.equal(fenceDbType("saved: nothing-here\n", pins), null);
});

test("viewQueryPropOptions: query: only offers names a filter term can name", () => {
  const universe = ["title", "status", "contact.email", "release.date", "Gebühr", "cat#"];
  const offered = viewQueryPropOptions("", universe);
  // the one-hop joins `columns:`/`sort:` resolve are not filterable — the
  // query grammar's key charclass has no dot, so the term matches no row
  assert.deepEqual(
    offered.filter((n) => n.includes(".")),
    []
  );
  assert.ok(offered.includes("status"));
  assert.ok(offered.includes("title"));
  // non-ASCII and `#` keys ARE filterable, so they stay on offer
  assert.ok(offered.includes("Gebühr"));
  assert.ok(offered.includes("cat#"));
  // and it still ranks like the other value lists
  assert.deepEqual(viewQueryPropOptions("stat", universe), ["status"]);
  assert.deepEqual(viewQueryPropOptions("contact.", universe), []);
});

test("/view inserts a well-formed fence with the cursor on the type: value", () => {
  const view = slashCommands().find((c) => c.name === "view")!;
  assert.equal(view.insert, "```view\ntype: \n```");
  assert.equal(view.insert.slice(0, view.cursor), "```view\ntype: ");
  // and the rest of the fence is exactly what fenceExit walks out of
  assert.ok(fenceExit(view.insert.slice(view.cursor)));
});

test("/calc and /live insert the two computing syntaxes, cursor ready to type", () => {
  const calc = slashCommands().find((c) => c.name === "calc")!;
  assert.equal(calc.insert, "= ");
  assert.equal(calc.cursor, calc.insert.length);

  const live = slashCommands().find((c) => c.name === "live")!;
  assert.equal(live.insert, "`= `");
  // inside the span, after the one documented space — where the name popup fires
  assert.equal(live.insert.slice(0, live.cursor), "`= ");
});

test("typing /ca ranks the calc command first", () => {
  assert.equal(slashOptions("ca")[0].name, "calc");
  assert.equal(slashOptions("live")[0].name, "live");
});
