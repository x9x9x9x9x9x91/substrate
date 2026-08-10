import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  FactLane,
  NoteMeta,
  TrashEntry,
  RelatedEntry,
  RenameResult,
  SavedView,
  SchemaConfig,
  ViewsConfig,
} from "./types.ts";

/* The mock backend lives behind `isTauri`, which sniffs `window` at module
   scope — shim one before importing so node lands on the mock lane. */
(globalThis as { window?: unknown }).window = globalThis;
const { invoke } = await import("./tauri.ts");
const { splitEcho, __resetOwnWrites } = await import("./ownwrites.ts");

test("template reads reuse the listed spelling, exact first", async () => {
  const listed = await invoke<string[]>("vault_template_list");
  assert.ok(listed.includes("release"));
  const template = await invoke<{ body: string } | null>("vault_template_read", {
    noteType: "RELEASE",
  });
  assert.match(template?.body ?? "", /\{\{title\}\}/);
});

test("mock title validation refuses control characters like the engine (SUB-909)", async () => {
  // Engine::validate_note_title's third refusal: a control char
  // survives the slug collapse and only fails at the filesystem — the mock
  // must refuse at the same boundary or e2e greens a flow the engine errors
  // on. \u0007 (BEL) is a C0 control that a terminal paste can carry.
  await assert.rejects(
    invoke("vault_create", { title: "bad\u0007title", body: "" }),
    /control characters/
  );
  // sanity: the sibling refusals still fire, and a clean title still lands
  await assert.rejects(invoke("vault_create", { title: "[bracketed]", body: "" }), /\[ or \]/);
  const ok = await invoke<NoteMeta>("vault_create", { title: "Clean Title 909", body: "" });
  assert.equal(ok.title, "Clean Title 909");
});

test("mock folder create/rename sanitize parts like the engine (SUB-910)", async () => {
  // sanitize_folder_rel: reserved chars become spaces per component, and the
  // SANITIZED form is re-checked — ":.." collapses to ".." and must refuse
  const clean = await invoke<string>("vault_create_folder", { path: "My: Folder/Sub*Part" });
  assert.equal(clean, "My Folder/Sub Part");
  await assert.rejects(invoke("vault_create_folder", { path: ":.." }), /invalid folder path/);
  await assert.rejects(invoke("vault_create_folder", { path: ".hidden" }), /hidden folders/);
  // rename sanitizes the new leaf the same way (engine rename_folder)
  const renamed = await invoke<string>("vault_rename_folder", {
    path: "My Folder/Sub Part",
    name: "New: Leaf",
  });
  assert.equal(renamed, "My Folder/New Leaf");
  await assert.rejects(
    invoke("vault_rename_folder", { path: "My Folder/New Leaf", name: ".dot" }),
    /hidden folders/
  );
});

test("create rejects folded engine-owned props at the mock boundary", async () => {
  const note = await invoke<NoteMeta>("vault_create", {
    title: "Folded Owned Props 728",
    folder: "",
    noteType: "release",
    props: [
      ["Type", "hijack"],
      ["TITLE", "Hijack"],
      ["Created", "1999-01-01"],
      ["Status", "todo"],
    ],
  });
  assert.equal(note.props.type, "release");
  assert.ok(note.props.created);
  assert.equal(note.props.Status, "todo");
  assert.equal(note.props.Type, undefined);
  assert.equal(note.props.TITLE, undefined);
  assert.equal(note.props.Created, undefined);
});

test("mock create rejects folded duplicate props before mutation", async () => {
  const before = await invoke<NoteMeta[]>("vault_list");
  await assert.rejects(
    () =>
      invoke("vault_create", {
        title: "Folded Duplicate Props 728",
        folder: "Never Created 728",
        props: [["Status", "first"], ["status", "second"]],
      }),
    /duplicate property “status”/
  );
  const after = await invoke<NoteMeta[]>("vault_list");
  assert.equal(after.length, before.length);
  assert.ok(!after.some((n) => n.title === "Folded Duplicate Props 728"));
});

test("mock template rename and delete reuse folded sanitized stored identity", async () => {
  await invoke("vault_create_type", { name: "template:admin:rename:728", props: [] });
  await invoke("vault_write_body", {
    path: ".vault/templates/Template Admin Rename 728.md",
    body: "rename me\n",
  });
  await invoke("vault_rename_type", {
    old: "template:admin:rename:728",
    new: "template:admin:renamed:728",
  });
  let listed = await invoke<string[]>("vault_template_list");
  assert.ok(!listed.some((t) => t.toLowerCase() === "template admin rename 728"));
  assert.ok(listed.includes("template admin renamed 728"));

  await invoke("vault_create_type", { name: "template:admin:delete:728", props: [] });
  await invoke("vault_write_body", {
    path: ".vault/templates/Template Admin Delete 728.md",
    body: "delete me\n",
  });
  await invoke("vault_delete_type", {
    dbType: "template:admin:delete:728",
    trashNotes: false,
  });
  listed = await invoke<string[]>("vault_template_list");
  assert.ok(!listed.some((t) => t.toLowerCase() === "template admin delete 728"));

  await invoke("vault_create_type", { name: "template-admin-case-728", props: [] });
  await invoke("vault_write_body", {
    path: ".vault/templates/template-admin-case-728.md",
    body: "change my case\n",
  });
  await invoke("vault_rename_type", {
    old: "template-admin-case-728",
    new: "Template-Admin-Case-728",
  });
  listed = await invoke<string[]>("vault_template_list");
  assert.ok(listed.includes("Template-Admin-Case-728"));
  assert.ok(!listed.includes("template-admin-case-728"));
});

test("mock template aliases reject public writes and legacy lifecycle fails closed", async () => {
  await invoke("vault_create_type", { name: "Probe:A728", props: [] });
  await assert.rejects(
    () => invoke("vault_create_type", { name: "Probe?A728", props: [] }),
    /share template file/
  );
  await invoke("vault_create_type", { name: "Probe Rename Source 728", props: [] });
  await assert.rejects(
    () =>
      invoke("vault_rename_type", {
        old: "Probe Rename Source 728",
        new: "Probe?A728",
      }),
    /share template file/
  );

  assert.ok(window.__mockEditSchema);
  window.__mockEditSchema("Probe?A728", {});
  await invoke("vault_write_body", {
    path: ".vault/templates/Probe A728.md",
    body: "shared legacy template\n",
  });
  assert.equal(
    await invoke("vault_template_read", { noteType: "Probe:A728" }),
    null,
    "ambiguous ownership fails closed"
  );
  await invoke("vault_delete_type", { dbType: "Probe?A728", trashNotes: false });
  assert.ok((await invoke<string[]>("vault_template_list")).includes("Probe A728"));
  assert.equal(
    (await invoke<{ body: string } | null>("vault_template_read", { noteType: "Probe:A728" }))
      ?.body,
    "shared legacy template\n"
  );

  window.__mockEditSchema("Probe?A728", {});
  await invoke("vault_rename_type", { old: "Probe?A728", new: "Probe Unique 728" });
  assert.ok((await invoke<string[]>("vault_template_list")).includes("Probe A728"));
  await invoke("vault_delete_type", { dbType: "Probe Unique 728", trashNotes: false });
  await invoke("vault_delete_type", { dbType: "Probe:A728", trashNotes: false });
});

test("mock type rename refuses a distinct case-only schema peer before mutation", async () => {
  const upper = "LegacyCaseMock728";
  const lower = "legacycasemock728";
  await invoke("vault_create_type", {
    name: upper,
    props: [{ name: "UpperOnly", kind: "text" }],
  });
  const note = await invoke<NoteMeta>("vault_create", {
    title: "Legacy Case Mock Note 728",
    folder: "",
    noteType: lower,
  });
  assert.ok(window.__mockEditSchema);
  window.__mockEditSchema(lower, {
    LowerOnly: { options: [], kind: "text", description: "keep lower" },
  });

  const schemaBefore = await invoke<SchemaConfig>("vault_schema_read");
  const noteBefore = await invoke<{ props: Record<string, unknown> }>("vault_read", {
    path: note.path,
  });
  await assert.rejects(
    () => invoke("vault_rename_type", { old: upper, new: lower }),
    /a database named “legacycasemock728” already exists/
  );
  const schemaAfter = await invoke<SchemaConfig>("vault_schema_read");
  const noteAfter = await invoke<{ props: Record<string, unknown> }>("vault_read", {
    path: note.path,
  });
  assert.deepEqual(schemaAfter[upper], schemaBefore[upper]);
  assert.deepEqual(schemaAfter[lower], schemaBefore[lower]);
  assert.equal(schemaAfter[lower].LowerOnly.description, "keep lower");
  assert.deepEqual(noteAfter.props, noteBefore.props, "the note was not rewritten before refusal");

  await invoke("vault_delete_type", { dbType: upper, trashNotes: false });
  await invoke("vault_delete_type", { dbType: lower, trashNotes: false });

  const solo = "SoloCaseMock728";
  await invoke("vault_create_type", { name: solo, props: [] });
  const soloNote = await invoke<NoteMeta>("vault_create", {
    title: "Solo Case Mock Note 728",
    folder: "",
    noteType: solo.toLowerCase(),
  });
  await invoke("vault_rename_type", { old: solo, new: solo.toUpperCase() });
  const soloSchema = await invoke<SchemaConfig>("vault_schema_read");
  assert.equal(Object.prototype.hasOwnProperty.call(soloSchema, solo.toUpperCase()), true);
  assert.equal(
    (await invoke<{ props: Record<string, unknown> }>("vault_read", { path: soloNote.path })).props
      .type,
    solo.toUpperCase()
  );
  await invoke("vault_delete_type", { dbType: solo.toUpperCase(), trashNotes: false });
});

test("mock prototype-shaped database stores survive create, admin writes, rename, and delete", async () => {
  await invoke("vault_create_type", { name: "__proto__", props: [] });
  await invoke("vault_schema_set_icon", {
    dbType: "__proto__",
    emoji: "🧪",
    glyph: null,
    tint: null,
  });
  await invoke("vault_schema_home_set", { dbType: "__proto__", home: "ProtoHome728" });
  await invoke("vault_views_set", { db: "__proto__", view: "table" });
  await invoke("vault_write_body", {
    path: ".vault/templates/__proto__.md",
    body: "prototype template\n",
  });

  let schema = await invoke<SchemaConfig>("vault_schema_read");
  assert.equal(Object.prototype.hasOwnProperty.call(schema, "__proto__"), true);
  assert.deepEqual(schema["__proto__"].icon, { emoji: "🧪" });
  assert.equal(schema["__proto__"].home, "ProtoHome728");
  let views = await invoke<ViewsConfig>("vault_views_read");
  assert.equal(Object.prototype.hasOwnProperty.call(views, "__proto__"), true);
  assert.equal(views["__proto__"].view, "table");
  assert.equal(
    (await invoke<{ body: string } | null>("vault_template_read", { noteType: "__PROTO__" }))
      ?.body,
    "prototype template\n"
  );

  await invoke("vault_rename_type", { old: "__proto__", new: "Proto Identity 728" });
  schema = await invoke<SchemaConfig>("vault_schema_read");
  assert.equal(Object.prototype.hasOwnProperty.call(schema, "__proto__"), false);
  assert.deepEqual(schema["Proto Identity 728"].icon, { emoji: "🧪" });
  assert.equal(schema["Proto Identity 728"].home, "ProtoHome728");
  views = await invoke<ViewsConfig>("vault_views_read");
  assert.equal(views["Proto Identity 728"].view, "table");
  assert.ok((await invoke<string[]>("vault_template_list")).includes("Proto Identity 728"));

  await invoke("vault_delete_type", { dbType: "Proto Identity 728", trashNotes: false });
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      await invoke<SchemaConfig>("vault_schema_read"),
      "Proto Identity 728"
    ),
    false
  );
  assert.ok(!(await invoke<string[]>("vault_template_list")).includes("Proto Identity 728"));
});

test("mock property rename never overwrites a distinct case-only schema destination", async () => {
  assert.ok(window.__mockEditSchema);
  window.__mockEditSchema("Mock Rename Duplicate 728", {
    Status: { options: [], kind: "text", description: "upper" },
    status: { options: [], kind: "text", description: "keep lower" },
  });

  await assert.rejects(
    () =>
      invoke("vault_rename_prop", {
        dbType: "Mock Rename Duplicate 728",
        old: "Status",
        new: "status",
      }),
    /already has a property/
  );
  const props = (await invoke<SchemaConfig>("vault_schema_read"))["Mock Rename Duplicate 728"];
  assert.equal(props.Status.description, "upper");
  assert.equal(props.status.description, "keep lower");
  await invoke("vault_delete_type", { dbType: "Mock Rename Duplicate 728", trashNotes: false });
});

test("rename rewrites only relation props aimed at the renamed note's type (SUB-216)", async () => {
  // two databases, a same-named note in each — renaming the artist must not
  // drag the pressing's `label` value along; it points at the label
  // database's note that happens to share the title
  await invoke("vault_schema_set", { dbType: "pressing", prop: "artist", kind: "relation", target: "artist" });
  await invoke("vault_schema_set", { dbType: "pressing", prop: "label", kind: "relation", target: "label" });
  await invoke<NoteMeta>("vault_create", { title: "X", folder: "", noteType: "artist" });
  await invoke<NoteMeta>("vault_create", { title: "X", folder: "Labels", noteType: "label" });
  const pressing = await invoke<NoteMeta>("vault_create", { title: "Test Pressing", folder: "", noteType: "pressing" });
  await invoke("vault_set_prop", { path: pressing.path, key: "artist", value: "X" });
  await invoke("vault_set_prop", { path: pressing.path, key: "label", value: "X" });

  await invoke("vault_rename", { path: "X.md", title: "X Prime" });

  const after = await invoke<{ body: string; props: Record<string, unknown> }>("vault_read", {
    path: pressing.path,
  });
  assert.equal(after.props["artist"], "X Prime", "aimed at the renamed note's type: rewrites");
  assert.equal(after.props["label"], "X", "aimed at the other database's same-named note: untouched");
});

test("mock relations fold the stored prop key for backlinks and rename rewrites", async () => {
  const sourceType = "Relation Source Folded 728";
  const targetType = "Relation Target Folded 728";
  await invoke("vault_schema_set", {
    dbType: sourceType,
    prop: "Contact",
    kind: "relation",
    target: targetType,
  });
  const target = await invoke<NoteMeta>("vault_create", {
    title: "Relation Target Note 728",
    folder: "",
    noteType: targetType,
  });
  const source = await invoke<NoteMeta>("vault_create", {
    title: "Relation Source Note 728",
    folder: "",
    noteType: sourceType,
  });
  await invoke("vault_set_prop", {
    path: source.path,
    key: "contact",
    value: target.title,
  });

  const related = await invoke<RelatedEntry[]>("vault_related", { path: target.path });
  const backlink = related.find((entry) => entry.path === source.path);
  assert.equal(backlink?.prop, "contact", "backlinks report the actual stored spelling");

  await invoke("vault_rename", { path: target.path, title: "Relation Target Renamed 728" });
  const read = await invoke<{ props: Record<string, unknown> }>("vault_read", {
    path: source.path,
  });
  assert.equal(read.props.contact, "Relation Target Renamed 728");
  assert.equal(read.props.Contact, undefined, "rename does not create the schema spelling in parallel");
});

test("write_body recomputes the excerpt like the engine (SUB-290 b)", async () => {
  const note = await invoke<NoteMeta>("vault_create", {
    title: "Excerpt Parity 290",
    folder: "",
    body: "old first line\n",
  });
  assert.equal(note.excerpt, "old first line");

  // engine make_excerpt: first non-empty line, leading `# > - * ` markup
  // stripped, [[ ]] brackets removed
  const updated = await invoke<NoteMeta>("vault_write_body", {
    path: note.path,
    body: "\n# Heading with [[Some Link]] inside\nsecond line\n",
  });
  assert.equal(updated.excerpt, "Heading with Some Link inside");

  // lists read the index — the fresh excerpt must show there too, not the
  // stale pre-edit one
  const list = await invoke<NoteMeta[]>("vault_list");
  assert.equal(
    list.find((n) => n.path === note.path)?.excerpt,
    "Heading with Some Link inside"
  );

  // truncation mirrors the engine: 120 chars + ellipsis
  const longLine = "abcdefghij".repeat(13); // 130 chars
  const truncated = await invoke<NoteMeta>("vault_write_body", { path: note.path, body: longLine });
  assert.equal(truncated.excerpt, `${longLine.slice(0, 120)}…`);

  // emptying the body clears the excerpt
  const emptied = await invoke<NoteMeta>("vault_write_body", { path: note.path, body: "" });
  assert.equal(emptied.excerpt, "");
});

test("rename rejects a case-insensitive collision, allows a case-only self-rename (SUB-290 c)", async () => {
  await invoke<NoteMeta>("vault_create", { title: "Collision Alpha 290", folder: "" });
  const beta = await invoke<NoteMeta>("vault_create", { title: "Collision Beta 290", folder: "" });

  // "Beta"→"ALPHA" while "Alpha.md" exists — the engine's exists-check on a
  // case-insensitive filesystem rejects this, and so does vault_create's
  // dedupe; rename now agrees with both
  await assert.rejects(
    () => invoke("vault_rename", { path: beta.path, title: "COLLISION ALPHA 290" }),
    /already exists/
  );
  // a rejected rename leaves the note exactly as it was
  const list = await invoke<NoteMeta[]>("vault_list");
  assert.equal(list.find((n) => n.path === beta.path)?.title, "Collision Beta 290");

  // the check compares full paths like the engine's new_abs: a same-named
  // note in a DIFFERENT folder does not collide
  await invoke<NoteMeta>("vault_create", { title: "Scoped Same 290", folder: "ScopeA290" });
  const other = await invoke<NoteMeta>("vault_create", { title: "Scoped Other 290", folder: "ScopeB290" });
  const cross = await invoke<RenameResult>("vault_rename", { path: other.path, title: "SCOPED SAME 290" });
  assert.equal(cross.meta.path, "ScopeB290/SCOPED SAME 290.md");

  // a case-only rename of the note itself stays allowed (the engine skips
  // the exists-check when only the case differs from its own path)
  const self = await invoke<RenameResult>("vault_rename", { path: beta.path, title: "COLLISION BETA 290" });
  assert.equal(self.meta.path, "COLLISION BETA 290.md");
  assert.equal(self.meta.title, "COLLISION BETA 290");
});

test("a sealed note's rename and move relock their destination (SUB-839)", async () => {
  const note = await invoke<NoteMeta>("vault_create", {
    title: "Sealed Path Guard 839",
    folder: "",
    body: "sealed path secret\n",
  });
  await invoke("vault_seal_note", { path: note.path, password: "correct horse" });
  await invoke("vault_unlock_sealed_note", { path: note.path, password: "correct horse" });

  const renamed = await invoke<RenameResult>("vault_rename", {
    path: note.path,
    title: "Sealed Renamed Guard 839",
  });
  await assert.rejects(
    invoke("vault_read", { path: renamed.meta.path }),
    /sealed: locked/,
    "the rename destination must not inherit the source's authorization"
  );

  await invoke("vault_unlock_sealed_note", {
    path: renamed.meta.path,
    password: "correct horse",
  });
  const moved = await invoke<NoteMeta>("vault_move", {
    path: renamed.meta.path,
    folder: "Archive839",
  });
  await assert.rejects(
    invoke("vault_read", { path: moved.path }),
    /sealed: locked/,
    "the move destination must not inherit the source's authorization"
  );
});

test("search commands cap their result set like the engine (SUB-519)", async () => {
  // both engine queries are capped — `vault_search` at 30 (vault.rs:2572),
  // `vault_search_full` at FULL_SEARCH_MAX_NOTES = 200 (vault.rs:94, :2636).
  // A token no seeded note carries, on more notes than either cap.
  for (let i = 0; i < 205; i++) {
    await invoke("vault_create", {
      title: `Capfixture519 ${i}`,
      folder: "Cap519",
      body: "zqxcapfixture matches nothing else\n",
    });
  }

  const hits = await invoke<unknown[]>("vault_search", { q: "zqxcapfixture" });
  assert.equal(hits.length, 30, "vault_search caps at 30");

  const full = await invoke<{ hits: unknown[]; total_notes: number; truncated: boolean }>(
    "vault_search_full",
    { q: "zqxcapfixture" }
  );
  assert.equal(full.hits.length, 200, "vault_search_full caps at FULL_SEARCH_MAX_NOTES");
  // the page is capped but the count is of the whole match set, so
  // the UI can say "first 200 of 205" instead of presenting 200 as the total
  assert.equal(full.total_notes, 205, "vault_search_full counts every match");
  assert.equal(full.truncated, true, "vault_search_full reports the truncation");
});

test("search orders by match, not by insertion order (SUB-519)", async () => {
  // Seeded deliberately backwards: the note that must rank LAST is created
  // FIRST, so a mock returning insertion order fails every assertion here.
  await invoke("vault_create", {
    title: "Zzz Rank519 Tail",
    folder: "Rank519",
    body: "nothing here\n\npadded padded padded padded rank519fix late in the body\n",
  });
  await invoke("vault_create", {
    title: "Aaa Rank519 Early",
    folder: "Rank519",
    body: "rank519fix on the very first line\n",
  });
  await invoke("vault_create", {
    title: "Rank519fix In The Title",
    folder: "Rank519",
    body: "no body match at all\n",
  });

  // vault_search returns a bare array; vault_search_full wraps its page in
  // `{hits, total_notes, truncated}` — unwrap so both read alike
  const paths = (r: unknown) => {
    const list = Array.isArray(r) ? r : (r as { hits: unknown[] }).hits;
    return list.map((h) => (h as { path: string }).path);
  };

  for (const cmd of ["vault_search", "vault_search_full"]) {
    const got = paths(await invoke<unknown>(cmd, { q: "rank519fix" }));
    assert.deepEqual(
      got,
      [
        "Rank519/Rank519fix In The Title.md",
        "Rank519/Aaa Rank519 Early.md",
        "Rank519/Zzz Rank519 Tail.md",
      ],
      `${cmd}: title match first, then earliest body offset`
    );
  }

  // path ascending is the tiebreak — two notes matching identically at the
  // same offset must come back in a stable order, not creation order
  await invoke("vault_create", { title: "Zed Tie519", folder: "Tie519", body: "tie519fix\n" });
  await invoke("vault_create", { title: "Alpha Tie519", folder: "Tie519", body: "tie519fix\n" });
  for (const cmd of ["vault_search", "vault_search_full"]) {
    const got = paths(await invoke<unknown>(cmd, { q: "tie519fix" }));
    assert.deepEqual(
      got,
      ["Tie519/Alpha Tie519.md", "Tie519/Zed Tie519.md"],
      `${cmd}: equal matches break ties on path, ascending`
    );
  }
});

test("hyphenated identifiers search like the engine's prefix phrases (SUB-1221)", async () => {
  // fts_match_expr quotes each whitespace token, so unicode61 reads
  // `bc-2025q4-00352` as the CONSECUTIVE runs `bc 2025q4 00352` with the last
  // one a prefix. The mock used to keep the hyphenated token whole and could
  // never match it against word-split hay — statement numbers and cat#s were
  // findable in the real app but not in the mock's quick search.
  const hits = async (q: string) =>
    (await invoke<{ path: string }[]>("vault_search", { q })).map((h) => h.path);

  await invoke("vault_create", {
    title: "Stmt Parity 1221",
    folder: "Stmt1221",
    body: "statement zq1221bc-2025q4-00352 filed after the returns window\n",
  });
  // consecutive runs elsewhere in the body, in the wrong order
  await invoke("vault_create", {
    title: "Stmt Scrambled 1221",
    folder: "Stmt1221",
    body: "runs out of order: 2025q4 zq1221bc 00352\n",
  });
  // the runs present but never consecutive
  await invoke("vault_create", {
    title: "Stmt Scattered 1221",
    folder: "Stmt1221",
    body: "zq1221bc alone, then 2025q4 later, then 00352 last\n",
  });

  const one = ["Stmt1221/Stmt Parity 1221.md"];
  assert.deepEqual(await hits("zq1221bc-2025q4-00352"), one, "full identifier hits its note only");
  assert.deepEqual(await hits("zq1221bc-2025q4-003"), one, "last run prefix-matches");
  assert.deepEqual(await hits("ZQ1221BC-2025Q4-00352"), one, "case-insensitive like the tokenizer");
  // the reversed identifier finds the note carrying the runs in THAT order
  // (Scrambled has `2025q4 zq1221bc` consecutive) — never the Parity note
  assert.deepEqual(
    await hits("2025q4-zq1221bc"),
    ["Stmt1221/Stmt Scrambled 1221.md"],
    "run order is the phrase order"
  );
  // `"…-2025"*` is a prefix PHRASE: the trailing run prefix-matches 2025q4,
  // exactly like typing the identifier from an email cut short mid-segment
  assert.deepEqual(await hits("zq1221bc-2025"), one, "a truncated trailing run still prefix-matches");

  // a phrase never spans the title/body seam — FTS phrases live in one column
  await invoke("vault_create", {
    title: "Seam Ends zq1221bc",
    folder: "Stmt1221",
    body: "2025q4 opens the body\n",
  });
  assert.deepEqual(await hits("zq1221bc-2025q4-00352"), one, "title/body seam is not a phrase bridge");

  // plain tokens keep the old semantics: scattered word-prefix matches hit
  const scattered = await hits("zq1221bc 00352");
  assert.ok(
    scattered.includes("Stmt1221/Stmt Scattered 1221.md"),
    "separate whitespace tokens still match scattered words"
  );
});

/* Mock parity for the engine's props_search_text: what a user READS in a prop
   cell is what they can type into the search box. Numbers and bools are values
   like any other, while the importer's notion_id stamp is hidden on every
   surface — a hit on it would be a result whose reason the user cannot see. */
test("prop values are searchable except the hidden import stamp", async () => {
  const pressing = await invoke<NoteMeta>("vault_create", {
    title: "Propsearch1222 Pressing",
    folder: "Propsearch1222",
  });
  await invoke("vault_set_prop", { path: pressing.path, key: "year", value: 2025 });
  await invoke("vault_set_prop", { path: pressing.path, key: "in use", value: true });
  await invoke("vault_set_prop", {
    path: pressing.path,
    key: "notion_id",
    value: "4c9f21ab-77de-4e10-9a55-2b6d0e3f81ce",
  });

  const paths = (r: unknown) => {
    const list = Array.isArray(r) ? r : (r as { hits: unknown[] }).hits;
    return list.map((h) => (h as { path: string }).path);
  };
  for (const cmd of ["vault_search", "vault_search_full"]) {
    assert.ok(
      paths(await invoke<unknown>(cmd, { q: "2025" })).includes(pressing.path),
      `${cmd}: a number prop answers its own value`
    );
    assert.ok(
      paths(await invoke<unknown>(cmd, { q: "true" })).includes(pressing.path),
      `${cmd}: a bool prop answers its own word`
    );
    assert.ok(
      !paths(await invoke<unknown>(cmd, { q: "4c9f21ab" })).includes(pressing.path),
      `${cmd}: the hidden notion_id stamp is not searchable`
    );
  }
});

test("hyphenated identifiers search like the engine's prefix phrases (SUB-1226)", async () => {
  // fts_match_expr quotes each whitespace token, so unicode61 reads
  // `bc-2025q4-00352` as the CONSECUTIVE runs `bc 2025q4 00352` with the last
  // one a prefix. The mock used to keep the hyphenated token whole against
  // word-split hay — statement numbers and cat#s findable in the real app
  // returned nothing, and the two mock commands disagreed with each other.
  const paths = (r: unknown) => {
    const list = Array.isArray(r) ? r : (r as { hits: unknown[] }).hits;
    return list.map((h) => (h as { path: string }).path);
  };
  const hits = async (cmd: string, q: string) => paths(await invoke<unknown>(cmd, { q }));

  await invoke("vault_create", {
    title: "Stmt Parity 1226",
    folder: "Stmt1226",
    body: "statement zq1226bc-2025q4-00352 filed after the returns window\n",
  });
  // the same runs, in the wrong order
  await invoke("vault_create", {
    title: "Stmt Scrambled 1226",
    folder: "Stmt1226",
    body: "runs out of order: 2025q4 zq1226bc 00352\n",
  });
  // the runs all present, but never consecutive
  await invoke("vault_create", {
    title: "Stmt Scattered 1226",
    folder: "Stmt1226",
    body: "zq1226bc alone, then 2025q4 later, then 00352 last\n",
  });
  // a phrase never spans the title/body seam — FTS phrases live in one column
  await invoke("vault_create", {
    title: "Seam Ends zq1226bc",
    folder: "Stmt1226",
    body: "2025q4 opens the body\n",
  });

  const one = ["Stmt1226/Stmt Parity 1226.md"];
  // both commands answer the same question the same way — the quick search
  // feeding the palette and the full search feeding the results pane
  for (const cmd of ["vault_search", "vault_search_full"]) {
    assert.deepEqual(await hits(cmd, "zq1226bc-2025q4-00352"), one, `${cmd}: full identifier`);
    assert.deepEqual(await hits(cmd, "zq1226bc-2025q4-003"), one, `${cmd}: last run prefix-matches`);
    assert.deepEqual(await hits(cmd, "ZQ1226BC-2025Q4-00352"), one, `${cmd}: case-insensitive`);
    // `"…-2025"*` is a prefix PHRASE: the trailing run prefix-matches 2025q4,
    // like typing an identifier from an email cut short mid-segment
    assert.deepEqual(await hits(cmd, "zq1226bc-2025"), one, `${cmd}: truncated trailing run`);
    // the reversed identifier finds the note carrying the runs in THAT order
    assert.deepEqual(
      await hits(cmd, "2025q4-zq1226bc"),
      ["Stmt1226/Stmt Scrambled 1226.md"],
      `${cmd}: run order is the phrase order`
    );
    // plain tokens keep the old semantics: scattered word-prefix matches hit
    assert.ok(
      (await hits(cmd, "zq1226bc 00352")).includes("Stmt1226/Stmt Scattered 1226.md"),
      `${cmd}: separate whitespace tokens still match scattered words`
    );
  }
});

test("full search highlights a matched phrase, not just its first run (SUB-1226)", async () => {
  // the results pane underlines what matched. A phrase that matched across
  // runs is one hit spanning the punctuation, so the identifier reads as the
  // single thing the user typed rather than a lone fragment of it.
  await invoke("vault_create", {
    title: "Hilite 1226",
    folder: "Hilite1226",
    body: "ref zq1226hi-88a done\n",
  });
  const res = await invoke<{ hits: { path: string; matches: { parts: { text: string; hit: boolean }[] }[] }[] }>(
    "vault_search_full",
    { q: "zq1226hi-88a" }
  );
  const hit = res.hits.find((h) => h.path === "Hilite1226/Hilite 1226.md");
  assert.ok(hit, "the note is in the page");
  assert.deepEqual(
    hit.matches[0].parts,
    [
      { text: "ref ", hit: false },
      { text: "zq1226hi-88a", hit: true },
      { text: " done", hit: false },
    ],
    "the whole identifier is one highlighted run"
  );

  // a plain token still highlights the whole word it prefix-matched
  const plain = await invoke<{ hits: { path: string; matches: { parts: { text: string; hit: boolean }[] }[] }[] }>(
    "vault_search_full",
    { q: "zq1226hi" }
  );
  const p = plain.hits.find((h) => h.path === "Hilite1226/Hilite 1226.md");
  assert.ok(p, "the note is in the page for the plain token too");
  assert.deepEqual(p.matches[0].parts[1], { text: "zq1226hi", hit: true });
});

test("accented text answers an unaccented query, and highlights (SUB-1222)", async () => {
  // the FTS table is built with `remove_diacritics 2`: "cafe" and "café" are one
  // word to the index, so both search doors must find the note AND show why —
  // a literal match leaves the accented word plain in the row while the engine
  // counts it as a hit.
  await invoke("vault_create", {
    title: "Accent 1222",
    folder: "Accent1222",
    body: "the zq1222café by the lake\n",
  });
  await invoke("vault_create", {
    title: "Accent Plain 1222",
    folder: "Accent1222",
    body: "the zq1222cafe by the lake\n",
  });
  const both = ["Accent1222/Accent 1222.md", "Accent1222/Accent Plain 1222.md"];
  const paths = (r: unknown) => {
    const list = Array.isArray(r) ? r : (r as { hits: unknown[] }).hits;
    return list.map((h) => (h as { path: string }).path).sort();
  };
  // both commands, both directions: accents are invisible to the tokenizer
  for (const cmd of ["vault_search", "vault_search_full"]) {
    assert.deepEqual(paths(await invoke<unknown>(cmd, { q: "zq1222cafe" })), both, `${cmd}: plain query`);
    assert.deepEqual(paths(await invoke<unknown>(cmd, { q: "zq1222café" })), both, `${cmd}: accented query`);
  }

  // and the accented word is marked WHOLE — the accent rides inside the hit,
  // and the unmarked runs still rebuild the line exactly
  const res = await invoke<{
    hits: { path: string; matches: { parts: { text: string; hit: boolean }[] }[] }[];
  }>("vault_search_full", { q: "zq1222cafe" });
  const hit = res.hits.find((h) => h.path === "Accent1222/Accent 1222.md");
  assert.ok(hit, "the accented note is in the page");
  assert.deepEqual(
    hit.matches[0].parts,
    [
      { text: "the ", hit: false },
      { text: "zq1222café", hit: true },
      { text: " by the lake", hit: false },
    ],
    "the accented word is one highlighted run"
  );
});

test("a prop-only hit says which value matched (SUB-1222)", async () => {
  // the note's body never mentions the query, so quick search showed its
  // opening prose with nothing marked and full search a count with no visible
  // text — neither door answered "why did this come back?". The matching prop
  // value rides along now: quick search swaps it in, full search marks it.
  const note = await invoke<NoteMeta>("vault_create", {
    title: "Annelies 1222",
    folder: "Prop1222",
    body: "Plugs the zq1222roster singles.\n",
  });
  await invoke("vault_set_prop", { path: note.path, key: "role", value: "zq1222plugger radio" });

  const quick = await invoke<{ path: string; snippet: string; prop_snippet: string | null }[]>(
    "vault_search",
    { q: "zq1222plugger" }
  );
  const q = quick.find((h) => h.path === note.path);
  assert.ok(q, "quick search finds the prop hit");
  assert.ok(
    q.prop_snippet?.includes("zq1222plugger radio"),
    `the prop value itself, not body prose: ${q.prop_snippet}`
  );

  // a body hit explains itself — the prop snippet is for prop-ONLY hits
  const body = await invoke<{ path: string; prop_snippet: string | null }[]>("vault_search", {
    q: "zq1222roster",
  });
  assert.equal(body.find((h) => h.path === note.path)?.prop_snippet ?? null, null);

  type Full = {
    hits: {
      path: string;
      matches: unknown[];
      prop_parts: { text: string; hit: boolean }[];
    }[];
  };
  const full = await invoke<Full>("vault_search_full", { q: "zq1222plugger" });
  const f = full.hits.find((h) => h.path === note.path);
  assert.ok(f, "full search finds the prop hit");
  assert.equal(f.matches.length, 0, "a prop hit still invents no body line");
  assert.deepEqual(
    f.prop_parts.filter((p) => p.hit),
    [{ text: "zq1222plugger", hit: true }],
    "the matched value comes back marked"
  );
  assert.ok(
    f.prop_parts.map((p) => p.text).join("").includes("radio"),
    "the value reads whole, mark and all"
  );

  const bfull = await invoke<Full>("vault_search_full", { q: "zq1222roster" });
  assert.deepEqual(
    bfull.hits.find((h) => h.path === note.path)?.prop_parts,
    [],
    "no prop matched — no prop row"
  );
});

/* A structural op names BOTH sides of itself as its own write. The
   engine renames on disk and the watcher emits the vacated rel in the same
   burst; before this, only the destination was recorded, so the old path's
   echo read as external and App.tsx invalidated the very undo entry the
   move/rename had just made ("it changed on disk"). invoke() attributes
   through writtenPathsFor, so drive that seam: run the command, then split
   the burst the watcher would emit. The create is reset away first — it
   recorded the same path the op is about to vacate, and would mask a
   regression by vouching for it. */
test("move names the vacated path as its own write (SUB-653)", async () => {
  const note = await invoke<NoteMeta>("vault_create", {
    title: "Ownwrite653 Move",
    folder: "",
  });
  __resetOwnWrites();
  const moved = await invoke<NoteMeta>("vault_move", { path: note.path, folder: "Own653" });
  assert.equal(moved.path, "Own653/Ownwrite653 Move.md");

  const split = splitEcho([note.path, moved.path]);
  assert.equal(split.unknown, false);
  assert.deepEqual(split.external, [], "the vacated path must not read as somebody else's write");
  assert.deepEqual([...split.own].sort(), [moved.path, note.path].sort());
});

test("rename names the vacated path as its own write (SUB-653)", async () => {
  const note = await invoke<NoteMeta>("vault_create", {
    title: "Ownwrite653 Rename",
    folder: "",
  });
  __resetOwnWrites();
  const renamed = await invoke<RenameResult>("vault_rename", {
    path: note.path,
    title: "Ownwrite653 Renamed",
  });
  assert.equal(renamed.meta.path, "Ownwrite653 Renamed.md");

  // the engine's burst: the vacated rel plus `touched` (the renamed note at
  // its new path and every note the link sweep rewrote)
  const split = splitEcho([note.path, ...renamed.touched]);
  assert.equal(split.unknown, false);
  assert.deepEqual(split.external, [], "no side of the rename reads as somebody else's write");
  assert.ok(split.own.includes(note.path), "the vacated path is our own echo");
});

/* The four database/property bulk sweeps rewrite ordinary vault
   notes, so their echo comes back through the watcher like any other write.
   Each must record an own-write — an unnamed one, since a `BulkSweep` returns
   counts and never the swept paths — or the echo lands as an external edit
   and flattens the undo stack. */
test("the database/property bulk sweeps record an unnamed own-write (SUB-660)", async () => {
  const { splitEcho, __resetOwnWrites } = await import("./ownwrites.ts");

  await invoke("vault_schema_set", { dbType: "sweep660", prop: "mood", kind: "text" });
  const note = await invoke<NoteMeta>("vault_create", {
    title: "Sweep660 Subject",
    folder: "",
    noteType: "sweep660",
  });
  await invoke("vault_set_prop", { path: note.path, key: "mood", value: "warm" });

  // each sweep, then the watcher echo naming the note it rewrote: an
  // unnamed own-write in the window makes that echo ours, not external
  const sweeps: [string, Record<string, unknown>][] = [
    ["vault_rename_prop", { dbType: "sweep660", old: "mood", new: "feel" }],
    ["vault_clear_prop", { dbType: "sweep660", prop: "feel" }],
    ["vault_rename_type", { old: "sweep660", new: "sweep660b" }],
    ["vault_delete_type", { dbType: "sweep660b", trashNotes: false }],
  ];
  for (const [cmd, args] of sweeps) {
    __resetOwnWrites();
    // cold: nothing recorded, so the same echo reads as somebody else's write
    const cold = splitEcho([note.path]);
    assert.deepEqual(cold.external, [note.path], `${cmd}: control — no own-write yet`);

    await invoke(cmd, args);
    const split = splitEcho([note.path]);
    assert.equal(split.unknown, true, `${cmd}: unnamed reach — BulkSweep names no paths`);
    assert.deepEqual(split.external, [], `${cmd}: the sweep's own echo is not external`);
    assert.equal(split.recentOwn, true, `${cmd}: the write was recorded`);
  }
});

test("vault_schema_set normalizes the lead time like the engine does (SUB-842)", async () => {
  const set = (args: Record<string, unknown>) =>
    invoke<SchemaConfig>("vault_schema_set", { dbType: "lead842", prop: "due", ...args });

  // a lead time stands alone — notify off is legal
  let schema = await set({ kind: "date", notify: false, notifyBefore: 3 });
  assert.equal(schema["lead842"]?.["due"]?.notifyBefore, 3);
  assert.equal(schema["lead842"]?.["due"]?.notify, undefined);

  // an absent arg keeps the stored value
  schema = await set({ kind: "date" });
  assert.equal(schema["lead842"]?.["due"]?.notifyBefore, 3, "unspecified keeps the stored lead time");

  // longer than a year clamps
  schema = await set({ kind: "date", notifyBefore: 4000 });
  assert.equal(schema["lead842"]?.["due"]?.notifyBefore, 365);

  // zero is how the UI clears it
  schema = await set({ kind: "date", notifyBefore: 0 });
  assert.equal(schema["lead842"]?.["due"]?.notifyBefore, undefined, "zero clears");

  // and a non-date kind normalizes it away
  schema = await set({ kind: "date", notifyBefore: 5 });
  assert.equal(schema["lead842"]?.["due"]?.notifyBefore, 5);
  schema = await set({ kind: "text" });
  assert.equal(schema["lead842"]?.["due"]?.notifyBefore, undefined, "lead time is date-kind only");
});

test("vault_schema_set stores and validates the rollup wiring (SUB-678)", async () => {
  // the relation to follow must exist first, as a relation-kind prop of the
  // same database — exactly like the engine's set_schema_prop
  await invoke("vault_schema_set", { dbType: "rollrel", prop: "entries", kind: "relation", target: "ledger" });
  const schema = await invoke<SchemaConfig>("vault_schema_set", {
    dbType: "rollrel",
    prop: "earned",
    kind: "rollup",
    relation: "entries",
    rollupProp: "amount",
    agg: "sum",
  });
  const ps = schema["rollrel"]?.["earned"];
  assert.equal(ps?.kind, "rollup");
  assert.equal(ps?.relation, "entries");
  assert.equal(ps?.prop, "amount");
  assert.equal(ps?.agg, "sum");
  assert.deepEqual(ps?.options, [], "a rollup carries no options");

  // validation mirrors the engine, message for message
  await assert.rejects(
    invoke("vault_schema_set", { dbType: "rollrel", prop: "x", kind: "rollup", rollupProp: "amount", agg: "sum" }),
    /relation to follow/
  );
  await assert.rejects(
    invoke("vault_schema_set", { dbType: "rollrel", prop: "x", kind: "rollup", relation: "entries", agg: "sum" }),
    /target property/
  );
  await assert.rejects(
    invoke("vault_schema_set", { dbType: "rollrel", prop: "x", kind: "rollup", relation: "entries", rollupProp: "amount", agg: "total" }),
    /unknown rollup function/
  );
  await assert.rejects(
    invoke("vault_schema_set", { dbType: "rollrel", prop: "x", kind: "rollup", relation: "earned", rollupProp: "amount", agg: "sum" }),
    /not a relation property/
  );

  // renaming the followed relation retargets the rollup's reference (same
  // database, case-folded) — renaming a prop of THIS database leaves the
  // target prop, which lives on the related db, alone
  await invoke("vault_rename_prop", { dbType: "rollrel", old: "entries", new: "royalties" });
  const after = await invoke<SchemaConfig>("vault_schema_read");
  assert.equal(after["rollrel"]?.["earned"]?.relation, "royalties");
  assert.equal(after["rollrel"]?.["earned"]?.prop, "amount");

  // create_type refuses a rollup initial prop, like the engine
  await assert.rejects(
    invoke("vault_create_type", { name: "RollCT", props: [{ name: "x", kind: "rollup" }] }),
    /rollup property/
  );
});

test("mock rename retargets cross-database rollup target props (SUB-740)", async () => {
  // release.entries → LEDGER-740 (casing differs on purpose); earned rolls
  // up "Amount" on that related database
  await invoke("vault_schema_set", { dbType: "rel740", prop: "entries", kind: "relation", target: "LEDGER-740" });
  await invoke("vault_schema_set", {
    dbType: "rel740",
    prop: "earned",
    kind: "rollup",
    relation: "Entries",
    rollupProp: "Amount",
    agg: "sum",
  });
  // a second rollup through a relation to a DIFFERENT database, rolling a
  // prop that happens to share the renamed name — it must not move
  await invoke("vault_schema_set", { dbType: "rel740", prop: "outgoings", kind: "relation", target: "costs740" });
  await invoke("vault_schema_set", {
    dbType: "rel740",
    prop: "spend",
    kind: "rollup",
    relation: "outgoings",
    rollupProp: "amount",
    agg: "sum",
  });
  await invoke("vault_schema_set", { dbType: "ledger-740", prop: "amount", kind: "number" });

  await invoke("vault_rename_prop", { dbType: "ledger-740", old: "amount", new: "value" });
  const after = await invoke<SchemaConfig>("vault_schema_read");
  assert.equal(
    after["rel740"]?.["earned"]?.prop,
    "value",
    "the cross-db rollup target follows the rename"
  );
  assert.equal(after["rel740"]?.["earned"]?.relation, "Entries", "the relation reference is untouched");
  assert.equal(
    after["rel740"]?.["spend"]?.prop,
    "amount",
    "a rollup through a relation to another database keeps its target"
  );
  assert.ok(after["ledger-740"]?.["value"], "the schema key itself moved");
});

test("mock rename retargets a rollup through a self-relation (SUB-740)", async () => {
  await invoke("vault_schema_set", { dbType: "task740", prop: "subtasks", kind: "relation", target: "task740" });
  await invoke("vault_schema_set", { dbType: "task740", prop: "hours", kind: "number" });
  await invoke("vault_schema_set", {
    dbType: "task740",
    prop: "total",
    kind: "rollup",
    relation: "subtasks",
    rollupProp: "hours",
    agg: "sum",
  });

  await invoke("vault_rename_prop", { dbType: "task740", old: "hours", new: "effort" });
  const after = await invoke<SchemaConfig>("vault_schema_read");
  assert.equal(after["task740"]?.["total"]?.prop, "effort", "the self-relation rollup target follows");
  assert.ok(after["task740"]?.["effort"]);
  assert.ok(!after["task740"]?.["hours"]);
});

test("mock property rename remaps saved query and view metadata in exact database", async () => {
  const db = "query-remap-723";
  await invoke("vault_schema_set", { dbType: db, prop: "price", kind: "number" });
  const mine: SavedView = {
    id: "query-remap-723-mine",
    name: "mine",
    db,
    query: 'Price > 500 price plain "price:500"',
    sort: { key: "price", dir: 1 },
    sorts: [
      { key: "price", dir: 1 },
      { key: "title", dir: -1 },
    ],
    group_by: "price",
    table_group_by: "price",
    columns: ["price", "cost", "note"],
  };
  const other: SavedView = { ...mine, id: "query-remap-723-other", db: ` ${db} ` };
  await invoke("vault_saved_view_set", { view: mine });
  await invoke("vault_saved_view_set", { view: other });

  await invoke("vault_rename_prop", { dbType: db, old: "price", new: "cost" });
  const views = await invoke<SavedView[]>("vault_saved_views_read");
  const renamed = views.find((view) => view.id === mine.id)!;
  assert.equal(renamed.query, 'cost > 500 price plain "price:500"');
  assert.deepEqual(renamed.sort, { key: "cost", dir: 1 });
  assert.deepEqual(renamed.sorts, [
    { key: "cost", dir: 1 },
    { key: "title", dir: -1 },
  ]);
  assert.equal(renamed.group_by, "cost");
  assert.equal(renamed.table_group_by, "cost");
  assert.deepEqual(renamed.columns, ["cost", "note"], "existing destination wins once");
  assert.deepEqual(
    views.find((view) => view.id === other.id),
    other,
    "saved-view database ownership is exact"
  );
});

test("mock property clear uses the caller's former number kind with no note values", async () => {
  const db = "query-clear-723";
  const cases: SavedView[] = [
    { id: "query-clear-723-number", name: "number", db, query: "price > 500 drift" },
    { id: "query-clear-723-text", name: "text", db, query: "score > 500 drift" },
    { id: "query-clear-723-date", name: "date", db, query: "due < 7d drift" },
  ];
  for (const view of cases) await invoke("vault_saved_view_set", { view });

  await invoke("vault_clear_prop", {
    dbType: db,
    prop: "price",
    wasNumber: true,
    stripValues: false,
  });
  await invoke("vault_clear_prop", {
    dbType: db,
    prop: "score",
    wasNumber: false,
    stripValues: false,
  });
  await invoke("vault_clear_prop", {
    dbType: db,
    prop: "due",
    wasNumber: false,
    stripValues: false,
  });

  const views = await invoke<SavedView[]>("vault_saved_views_read");
  assert.equal(views.find((view) => view.id === cases[0].id)?.query, undefined);
  assert.equal(
    views.find((view) => view.id === cases[1].id)?.query,
    "score > 500 drift",
    "numeric-looking comparison stays text without the old number kind"
  );
  assert.equal(views.find((view) => view.id === cases[2].id)?.query, undefined);
});

test("mock delete_type trashes the template and restore round-trips (SUB-781)", async () => {
  await invoke("vault_create_type", { name: "Template Trash 781", props: [] });
  await invoke("vault_write_body", {
    path: ".vault/templates/Template Trash 781.md",
    body: "skeleton body 781\n",
  });
  await invoke("vault_delete_type", { dbType: "Template Trash 781", trashNotes: false });

  // the template left the store — but into the trash, not oblivion
  let listed = await invoke<string[]>("vault_template_list");
  assert.ok(!listed.some((t) => t.toLowerCase() === "template trash 781"));
  const trash = await invoke<TrashEntry[]>("vault_trash_list");
  const entry = trash.find((t) => t.kind === "template" && t.title === "Template Trash 781");
  assert.ok(entry, "deleted type's template lists in the trash as its own kind");

  // recreate the type with a fresh template — the restore must not clobber it
  await invoke("vault_create_type", { name: "Template Trash 781", props: [] });
  await invoke("vault_write_body", {
    path: ".vault/templates/Template Trash 781.md",
    body: "fresh successor\n",
  });
  const landed = await invoke<string>("vault_trash_restore_template", { id: entry!.id });
  assert.equal(landed, "Template Trash 781 2", "restore lands numbered next to the successor");
  listed = await invoke<string[]>("vault_template_list");
  assert.ok(listed.includes("Template Trash 781 2"));
  const restored = await invoke<{ body: string } | null>("vault_template_read", {
    noteType: "Template Trash 781 2",
  });
  assert.match(restored?.body ?? "", /skeleton body 781/, "restored content round-tripped");

  // and the permanent path: trash again, delete forever, gone from both stores
  await invoke("vault_delete_type", { dbType: "Template Trash 781 2", trashNotes: false });
  const again = await invoke<TrashEntry[]>("vault_trash_list");
  const doomed = again.find((t) => t.kind === "template" && t.title === "Template Trash 781 2");
  assert.ok(doomed, "re-trashed under the numbered stem");
  await invoke("vault_trash_delete_template", { id: doomed!.id });
  const finalTrash = await invoke<TrashEntry[]>("vault_trash_list");
  assert.ok(!finalTrash.some((t) => t.kind === "template" && t.title === "Template Trash 781 2"));
});

test("sheet_set_column_notify keeps a sheet's columns map like the engine (SUB-876)", async () => {
  const note = await invoke<NoteMeta>("vault_create", {
    title: "Subs 876",
    folder: "",
    body: "```csv\nService,Renewal\nNetflix,2026-08-10\n```\n",
    props: [["type", "sheet"]],
  });
  const set = (column: string, notify: boolean, notifyBefore: number | null) =>
    invoke<NoteMeta>("sheet_set_column_notify", { path: note.path, column, notify, notifyBefore });
  const cols = (m: NoteMeta) => m.props["columns"] as Record<string, Record<string, unknown>> | undefined;

  // day-of alone, then a lead time that stands on its own
  let meta = await set("Renewal", true, null);
  assert.deepEqual(cols(meta)?.["Renewal"], { notify: true });
  meta = await set("Renewal", false, 7);
  assert.deepEqual(cols(meta)?.["Renewal"], { notifyBefore: 7 });

  // the stored spelling wins over the one the caller typed
  meta = await set("renewal", true, 7);
  assert.deepEqual(Object.keys(cols(meta) ?? {}), ["Renewal"], "no second entry for the same column");
  assert.deepEqual(cols(meta)?.["Renewal"], { notify: true, notifyBefore: 7 });

  // longer than a year clamps
  meta = await set("Renewal", true, 4000);
  assert.equal(cols(meta)?.["Renewal"]?.notifyBefore, 365);

  // both off removes the entry, and the last entry removes the map
  meta = await set("Renewal", false, null);
  assert.equal(cols(meta), undefined, "an empty columns map is not left behind");

  // the engine's own wording (vault/mod.rs set_sheet_column_notify) — asserting
  // the mock's private phrasing would let the two drift unnoticed
  await assert.rejects(set("  ", true, null), /column name is required/);
});

test("mock history_facts binds the prop key case-folded, like the engine", async () => {
  // `fact_value` folds the key on every historical blob (factlane.rs), so a
  // mock answering only the exact spelling greened a dashboard where
  // `PROP(n, "Created")` reads as a fact that was never written.
  const notes = await invoke<NoteMeta[]>("vault_list");
  const note = notes.find((n) => n.path === "Welcome.md");
  assert.ok(note, "the mock vault seeds Welcome.md");
  const [exact] = await invoke<FactLane[]>("history_facts", {
    refs: [{ path: note.path, key: "created" }],
  });
  const [cased] = await invoke<FactLane[]>("history_facts", {
    refs: [{ path: note.path, key: "CREATED" }],
  });
  assert.ok(exact.points.length > 0, "the exact spelling answers");
  assert.deepEqual(
    cased.points.map((p) => p.value),
    exact.points.map((p) => p.value),
  );
  // the lane still echoes the key as asked for, like the engine's ref echo
  assert.equal(cased.key, "CREATED");
});
