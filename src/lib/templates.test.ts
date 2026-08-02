import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta } from "./types.ts";
import {
  buildEntryBody,
  buildEntryProps,
  canonicalTemplateType,
  defaultPropKeys,
  homeFolderFor,
  instantiate,
  mergeEntryProp,
  templateDefaults,
  templatePath,
  templateTypeOf,
  templateTypeOptions,
  type EntryTemplate,
} from "./templates.ts";

function note(props: Record<string, unknown>, folder = ""): NoteMeta {
  return {
    path: `${folder ? folder + "/" : ""}X.md`,
    stem: "X",
    title: "X",
    folder,
    props,
    updated_ms: 0,
    excerpt: "",
  };
}

test("instantiate substitutes title and date, leaves the rest", () => {
  assert.equal(
    instantiate("## {{title}}\ndue {{date}} — again {{date}}", "SMP-032", "2026-07-17"),
    "## SMP-032\ndue 2026-07-17 — again 2026-07-17"
  );
  assert.equal(instantiate("{{when}} stays", "T", "2026-07-17"), "{{when}} stays");
  assert.equal(instantiate("", "T", "2026-07-17"), "");
});

test("instantiate keeps JS replacement patterns and inner placeholders literal (SUB-237)", () => {
  // `$&` / `$$` in a title are plain characters, not String.replace syntax
  assert.equal(instantiate("# {{title}}", "Mix $& v2", "2026-07-17"), "# Mix $& v2");
  assert.equal(instantiate("# {{title}}", "a$$b", "2026-07-17"), "# a$$b");
  // a placeholder spelled inside the title is not double-substituted
  assert.equal(
    instantiate("# {{title}} — {{date}}", "x{{date}}y", "2026-07-17"),
    "# x{{date}}y — 2026-07-17"
  );
  // the same safety reaches prop defaults and bodies through their instantiate calls
  const tpl: EntryTemplate = { props: { status: "{{title}}" }, body: "# {{title}}" };
  assert.deepEqual(templateDefaults(tpl, "Mix $& v2", "2026-07-17"), [["status", "Mix $& v2"]]);
  assert.equal(buildEntryBody({ props: {}, body: "# {{title}}" }, "x{{date}}y", "2026-07-17"), "# x{{date}}y");
});

test("templateDefaults drops system keys, stringifies, instantiates", () => {
  const tpl: EntryTemplate = {
    props: {
      type: "release", // engine-owned at create
      title: "Hijack",
      created: "1999-01-01",
      status: "parked",
      due: "{{date}}",
      cards: [{ label: "x" }],
      blank: null,
    },
    body: "",
  };
  assert.deepEqual(templateDefaults(tpl, "T", "2026-07-17"), [
    ["status", "parked"],
    ["due", "2026-07-17"],
    ["cards", JSON.stringify([{ label: "x" }])],
    ["blank", ""],
  ]);
  assert.deepEqual(templateDefaults(null, "T", "2026-07-17"), []);
});

test("templateDefaults drops folded system spellings", () => {
  const tpl: EntryTemplate = {
    props: { Type: "hijack", TITLE: "Hijack", Created: "1999-01-01", Status: "todo" },
    body: "",
  };
  assert.deepEqual(templateDefaults(tpl, "T", "2026-07-17"), [["Status", "todo"]]);
});

test("buildEntryProps rejects folded duplicate template properties", () => {
  assert.throws(
    () =>
      buildEntryProps({
        typeSchema: { STATUS: { options: [] } },
        typeNotes: [],
        template: { props: { Status: "first", status: "second" }, body: "" },
        title: "T",
        date: "2026-07-17",
      }),
    /duplicate property “status”/
  );
});

test("defaultPropKeys: schema keys when defined, union of notes otherwise", () => {
  const schema = {
    contract: { options: [], kind: "file" as const },
    status: { options: [{ value: "live" }] },
    released: { options: [], kind: "date" as const },
  };
  // known props lead (status first), rest alphabetical
  assert.deepEqual(defaultPropKeys(schema, []), ["status", "contract", "released"]);

  const notes = [
    note({ type: "release", status: "live", "cat#": "SMP-030", created: "2026-07-17" }),
    note({ type: "release", status: "mastering", artist: "1k petals", title: "X" }),
  ];
  assert.deepEqual(defaultPropKeys(undefined, notes), ["status", "cat#", "artist"]);
  // an empty schema object is "no schema" → union fallback
  assert.deepEqual(defaultPropKeys({}, notes), ["status", "cat#", "artist"]);
  // schema present → union ignored even when notes carry extra props
  assert.deepEqual(defaultPropKeys({ status: { options: [] } }, notes), ["status"]);
  assert.deepEqual(defaultPropKeys(undefined, []), []);
});

test("defaultPropKeys: reserved schema keys are never born as chips (SUB-85)", () => {
  // icon/home ride the flat type entry as reserved keys — they must not
  // become empty frontmatter chips on new entries
  const schema = {
    status: { options: [{ value: "live" }] },
    icon: { glyph: "music" },
    home: "Umbra",
  };
  assert.deepEqual(defaultPropKeys(schema as never, []), ["status"]);
  // …and a schema holding ONLY reserved keys reads as "no schema" → union
  const notes = [note({ type: "release", artist: "1k petals" })];
  assert.deepEqual(defaultPropKeys({ icon: { emoji: "🛠" } } as never, notes), ["artist"]);
});

test("defaultPropKeys folds built-ins, reserved keys, lead order, and union identity", () => {
  const schema = {
    HOME: "Elsewhere",
    Icon: { glyph: "star" },
    Artist: { options: [] },
    Status: { options: [] },
    zebra: { options: [] },
  };
  assert.deepEqual(defaultPropKeys(schema as never, []), ["Status", "Artist", "zebra"]);

  const notes = [
    note({ Type: "RELEASE", Created: "2026-07-01", Status: "todo" }),
    note({ type: "release", created: "2026-07-02", status: "done", Artist: "A" }),
  ];
  assert.deepEqual(defaultPropKeys(undefined, notes), ["Status", "Artist"]);
});

test("buildEntryProps: template defaults win, schema fills the rest empty", () => {
  const tpl: EntryTemplate = {
    props: { status: "parked", "cat#": "SMP-" },
    body: "",
  };
  const schema = {
    status: { options: [] },
    released: { options: [], kind: "date" as const },
    contract: { options: [], kind: "file" as const },
  };
  assert.deepEqual(
    buildEntryProps({ typeSchema: schema, typeNotes: [], template: tpl, title: "T", date: "2026-07-17" }),
    [
      ["status", "parked"],
      ["cat#", "SMP-"],
      ["contract", ""],
      ["released", ""],
    ]
  );
  // template key matching a schema key only by case is not double-filled
  const cased = buildEntryProps({
    typeSchema: { Status: { options: [] } },
    typeNotes: [],
    template: { props: { status: "parked" }, body: "" },
    title: "T",
    date: "2026-07-17",
  });
  assert.deepEqual(cased, [["status", "parked"]]);
  // no template: every schema prop born as an empty chip
  assert.deepEqual(
    buildEntryProps({ typeSchema: schema, typeNotes: [], title: "T", date: "2026-07-17" }),
    [
      ["status", ""],
      ["contract", ""],
      ["released", ""],
    ]
  );
});

test("buildEntryBody instantiates the template body, empty without one", () => {
  const tpl: EntryTemplate = {
    props: {},
    body: "# {{title}}\n\n- [ ] announce {{date}}\n",
  };
  assert.equal(
    buildEntryBody(tpl, "SMP-032", "2026-07-17"),
    "# SMP-032\n\n- [ ] announce 2026-07-17\n"
  );
  assert.equal(buildEntryBody(null, "T", "2026-07-17"), "");
});

test("homeFolderFor: the type's dominant folder, Inbox when empty", () => {
  assert.equal(homeFolderFor([]), "Inbox");
  assert.equal(
    homeFolderFor([note({}, "Releases"), note({}, "Releases"), note({}, "")]),
    "Releases"
  );
  // root ("") can be the dominant folder — releases live at vault root
  assert.equal(homeFolderFor([note({}, ""), note({}, ""), note({}, "Inbox")]), "");
});

test("homeFolderFor: an explicit home wins over the heuristic (SUB-85)", () => {
  const notes = [note({}, "Releases"), note({}, "Releases"), note({}, "")];
  assert.equal(homeFolderFor(notes, "Umbra"), "Umbra");
  assert.equal(homeFolderFor([], "Umbra"), "Umbra", "no notes needed");
  // blank/undefined falls back to the dominant-folder heuristic
  assert.equal(homeFolderFor(notes, "  "), "Releases");
  assert.equal(homeFolderFor(notes, undefined), "Releases");
});

test("templateTypeOptions: templates first, then count, then name", () => {
  const dbs = [
    { type: "release", count: 5 },
    { type: "task", count: 3 },
    { type: "gear", count: 1 },
  ];
  assert.deepEqual(templateTypeOptions(dbs, ["task"]), [
    { type: "task", count: 3, hasTemplate: true },
    { type: "release", count: 5, hasTemplate: false },
    { type: "gear", count: 1, hasTemplate: false },
  ]);
  // template match is case-insensitive; no templates keeps count order
  assert.deepEqual(
    templateTypeOptions(dbs, ["RELEASE"]).map((d) => d.hasTemplate),
    [true, false, false]
  );
  assert.deepEqual(templateTypeOptions([], ["task"]), []);
});

test("canonicalTemplateType reuses listed/schema spelling, exact first", () => {
  assert.equal(canonicalTemplateType("RELEASE", ["Release"], ["release"]), "Release");
  assert.equal(canonicalTemplateType("release", ["Release", "release"], ["Release"]), "release");
  assert.equal(canonicalTemplateType("TASK", [], ["Task"]), "Task");
  assert.equal(canonicalTemplateType("new-db", [], ["Release"]), "new-db");
});

test("mergeEntryProp overrides in place, appends when missing (SUB-60)", () => {
  const pairs: [string, string][] = [
    ["location", "Studio"],
    ["date", ""],
  ];
  // an empty schema fill keeps its position and key spelling, gains the value
  assert.deepEqual(mergeEntryProp(pairs, "date", "2026-07-20"), [
    ["location", "Studio"],
    ["date", "2026-07-20"],
  ]);
  // key match is case-insensitive; the pair's own spelling survives
  assert.deepEqual(mergeEntryProp(pairs, "DATE", "2026-07-20"), [
    ["location", "Studio"],
    ["date", "2026-07-20"],
  ]);
  // a template default for the date prop is overridden too — the picked day wins
  assert.deepEqual(
    mergeEntryProp([["date", "{{date}}"]], "date", "2026-07-20"),
    [["date", "2026-07-20"]]
  );
  // unknown key appends, input not mutated
  assert.deepEqual(mergeEntryProp(pairs, "due", "2026-07-21"), [
    ["location", "Studio"],
    ["date", ""],
    ["due", "2026-07-21"],
  ]);
  assert.deepEqual(pairs, [
    ["location", "Studio"],
    ["date", ""],
  ]);
  assert.deepEqual(mergeEntryProp([], "date", "2026-07-20"), [["date", "2026-07-20"]]);
});

test("templatePath mirrors the Rust filename sanitize (SUB-59)", () => {
  assert.equal(templatePath("release"), ".vault/templates/release.md");
  assert.equal(templatePath("finance-doc"), ".vault/templates/finance-doc.md");
  // path-hostile chars collapse like vault.rs sanitize_filename
  assert.equal(templatePath("a/b:c*d"), ".vault/templates/a b c d.md");
  assert.equal(templatePath("  spaced   out  "), ".vault/templates/spaced out.md");
  assert.equal(templatePath("///"), ".vault/templates/Untitled.md");
});

test("templateTypeOf parses template paths, rejects everything else (SUB-59)", () => {
  assert.equal(templateTypeOf(".vault/templates/release.md"), "release");
  assert.equal(templateTypeOf(templatePath("finance-doc")), "finance-doc");
  assert.equal(templateTypeOf("Inbox/Note.md"), null);
  assert.equal(templateTypeOf(".vault/templates/nested/x.md"), null);
  assert.equal(templateTypeOf(".vault/templates/readme.txt"), null);
  assert.equal(templateTypeOf(".vault/other/release.md"), null);
});
