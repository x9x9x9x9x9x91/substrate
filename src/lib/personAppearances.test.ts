import { test } from "node:test";
import assert from "node:assert/strict";
import type { FullSearchHit, NoteMeta, SchemaConfig, SnippetPart } from "./types.ts";
import {
  buildAppearances,
  eventAppearances,
  hasHandlesKey,
  mentionAppearances,
  noteHandles,
  normalizeHandle,
  rowAppearances,
} from "./personAppearances.ts";

function note(
  path: string,
  props: Record<string, unknown>,
  extra: Partial<NoteMeta> = {}
): NoteMeta {
  const stem = path.replace(/\.md$/, "").split("/").pop() ?? path;
  return {
    path,
    stem,
    title: stem,
    folder: path.includes("/") ? path.split("/").slice(0, -1).join("/") : "",
    props,
    updated_ms: 0,
    excerpt: "",
    sealed: false,
    ...extra,
  };
}

/** The tokens FTS marks in these fixtures. The backend highlights whole
    tokens (unicode61 splits on `@`, `.`, `+` and whitespace alike), so a
    handle typed as one address comes back as SEVERAL marked runs with the
    punctuation between them unmarked — the shape the join has to survive. */
const FTS_TOKENS = [
  "vesna",
  "ivonne",
  "ivoserver",
  "ivo",
  "example",
  "com",
  "5550199",
  "49",
  "30",
];

/** Fixture parts the way `parse_marked` (src-tauri/src/vault/search.rs:105)
    really emits them: contiguous slices of ONE string, alternating unmarked
    and marked, concatenating back to that string exactly. Building fixtures as
    one whole-line part hid a real bug — a multi-token handle arrives as
    disjoint marked regions, and any join that inserts a separator between them
    spells a phone number nobody typed. */
function markedParts(text: string, tokens: string[] = FTS_TOKENS): SnippetPart[] {
  const lower = text.toLowerCase();
  const out: SnippetPart[] = [];
  let i = 0;
  for (;;) {
    const next = tokens
      .map((token) => ({ token, at: lower.indexOf(token.toLowerCase(), i) }))
      .filter((c) => c.at >= 0)
      .sort((a, b) => a.at - b.at || b.token.length - a.token.length)[0];
    if (!next) break;
    if (next.at > i) out.push({ text: text.slice(i, next.at), hit: false });
    out.push({ text: text.slice(next.at, next.at + next.token.length), hit: true });
    i = next.at + next.token.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
}

/** One full-search hit. `props` are space-joined into a single marked column,
    the way `props_search_text` feeds the index. */
function hit(path: string, lines: string[], props: string[] = []): FullSearchHit {
  return {
    path,
    title_parts: markedParts(path.replace(/\.md$/, "").split("/").pop() ?? path),
    total: lines.length,
    matches: lines.map((line, i) => ({ line: i + 1, parts: markedParts(line) })),
    partial: false,
    prop_parts: props.length > 0 ? markedParts(props.join(" ")) : [],
  };
}

const VESNA = note("People/Vesna.md", {
  type: "contact",
  handles: "vesna@example.com, +49 30 5550199, @vesna",
});

const SCHEMA: SchemaConfig = {
  session: { date: { kind: "date", options: [] } },
  release: { artist: { kind: "text", options: [] } },
};

test("noteHandles reads a comma list, a YAML list, and nothing at all", () => {
  assert.deepEqual(noteHandles({ handles: "a@b.com, +49 30 5550199" }), [
    "a@b.com",
    "+49 30 5550199",
  ]);
  assert.deepEqual(noteHandles({ handles: ["a@b.com", "@vesna"] }), ["a@b.com", "@vesna"]);
  assert.deepEqual(noteHandles({}), [], "no key");
  assert.deepEqual(noteHandles({ handles: "" }), [], "empty value");
  assert.deepEqual(noteHandles({ handles: " , , " }), [], "separators only");
  assert.deepEqual(noteHandles({ handles: 42 }), [], "a non-string value names nobody");
});

test("noteHandles folds the key's casing and deduplicates by normalized form", () => {
  assert.deepEqual(noteHandles({ Handles: "A@B.com" }), ["A@B.com"], "hand-typed casing");
  assert.deepEqual(
    noteHandles({ handles: ["vesna@example.com", "Vesna@Example.com ", "@vesna"] }),
    ["vesna@example.com", "@vesna"],
    "the first spelling wins"
  );
});

test("hasHandlesKey separates 'no handles yet' from 'not a person note'", () => {
  assert.equal(hasHandlesKey({ handles: "" }), true, "declared but unfilled");
  assert.equal(hasHandlesKey({ Handles: ["a@b.com"] }), true);
  assert.equal(hasHandlesKey({ type: "contact" }), false);
});

test("normalizeHandle folds case and outer whitespace, and nothing else", () => {
  assert.equal(normalizeHandle("  Vesna@Example.com "), "vesna@example.com");
  assert.equal(normalizeHandle("+49  30  5550199"), "+49 30 5550199");
  assert.notEqual(normalizeHandle("+49305550199"), normalizeHandle("+49 30 5550199"));
});

test("rowAppearances matches database columns exactly, naming the column", () => {
  const notes = [
    VESNA,
    note("Releases/UG-014.md", { type: "release", artist: "vesna@example.com" }),
    note("Finance/Payout.md", { type: "transaction", counterparty: "VESNA@example.com" }),
    note("Releases/UG-015.md", { type: "release", artist: "someone@else.com" }),
  ];
  const found = rowAppearances(notes, noteHandles(VESNA.props), VESNA.path);
  assert.deepEqual(
    found.map((a) => [a.path, a.dbType, a.prop, a.handle]),
    [
      ["Releases/UG-014.md", "release", "artist", "vesna@example.com"],
      ["Finance/Payout.md", "transaction", "counterparty", "vesna@example.com"],
    ]
  );
});

test("rowAppearances splits a multi-value column and never matches a substring", () => {
  const notes = [
    note("Releases/Split.md", { type: "release", artist: "ivo@x.com, vesna@example.com" }),
    note("Releases/List.md", { type: "release", artist: ["vesna@example.com"] }),
    note("Releases/Near.md", { type: "release", artist: "not-vesna@example.com" }),
  ];
  const found = rowAppearances(notes, noteHandles(VESNA.props), VESNA.path);
  assert.deepEqual(found.map((a) => a.path).sort(), ["Releases/List.md", "Releases/Split.md"]);
});

test("rowAppearances skips the person's own note, other people's handles, and app machinery", () => {
  const notes = [
    VESNA,
    note("People/Duplicate.md", { type: "contact", handles: "vesna@example.com" }),
    note("Boards/People.md", { type: "dashboard", dashboard: "hub", owner: "@vesna" }),
    note("Sheets/Ledger.md", { type: "sheet", owner: "@vesna" }),
  ];
  assert.deepEqual(rowAppearances(notes, noteHandles(VESNA.props), VESNA.path), []);
});

test("an untyped note carrying a handle is a row in the Notes section", () => {
  const notes = [note("Inbox/Studio call.md", { email: "vesna@example.com" })];
  const groups = buildAppearances({ self: VESNA, notes, schema: SCHEMA });
  assert.deepEqual(
    groups.map((g) => [g.label, g.entries.length]),
    [["Notes", 1]]
  );
});

test("eventAppearances claims dated notes, most recent first, with the day", () => {
  const notes = [
    note("Sessions/Mix.md", { type: "session", date: "2026-03-04", with: "@vesna" }),
    note("Sessions/Master.md", { type: "session", date: "2026-08-11 19:30", with: "@vesna" }),
    note("Sessions/Other.md", { type: "session", date: "2026-08-12", with: "@someone" }),
  ];
  const found = eventAppearances(notes, noteHandles(VESNA.props), VESNA.path, SCHEMA);
  assert.deepEqual(
    found.map((a) => [a.path, a.day, a.time]),
    [
      ["Sessions/Master.md", "2026-08-11", "19:30"],
      ["Sessions/Mix.md", "2026-03-04", undefined],
    ]
  );
});

test("a dated note is an event, not also a row", () => {
  const notes = [note("Sessions/Mix.md", { type: "session", date: "2026-03-04", with: "@vesna" })];
  const groups = buildAppearances({ self: VESNA, notes, schema: SCHEMA });
  assert.deepEqual(
    groups.map((g) => [g.key, g.entries.map((e) => e.path)]),
    [["event", ["Sessions/Mix.md"]]]
  );
});

test("mentionAppearances keeps only hits whose text really spells the handle", () => {
  const notes = [
    note("Journal/2026-08-11.md", {}),
    note("Journal/2026-08-12.md", {}),
    note("Journal/2026-08-13.md", {}),
  ];
  const hits = [
    hit("Journal/2026-08-11.md", ["mailed Vesna@Example.com about the master"]),
    hit("Journal/2026-08-12.md", ["vesna said the mix was too dry"]),
    hit("Journal/2026-08-13.md", [], ["+49 30 5550199"]),
  ];
  const found = mentionAppearances(hits, notes, noteHandles(VESNA.props), VESNA.path);
  assert.deepEqual(
    found.map((a) => [a.path, a.handle]),
    [
      ["Journal/2026-08-11.md", "vesna@example.com"],
      ["Journal/2026-08-13.md", "+49 30 5550199"],
    ],
    "the tokenized 'vesna' hit is a candidate the exact check rejects"
  );
});

test("a handle the search split into separate marked runs is still one mention", () => {
  const notes = [note("Journal/2026-08-11.md", {}), note("Journal/2026-08-12.md", {})];
  const line = "called +49 30 5550199 about the master";
  const hits = [
    hit("Journal/2026-08-11.md", [line]),
    hit("Journal/2026-08-12.md", [], ["+49 30 5550199"]),
  ];
  assert.ok(
    hits[0].matches[0].parts.length > 1,
    "fixture guard: the phone number arrives as disjoint marked regions"
  );
  assert.equal(
    hits[0].matches[0].parts.map((p) => p.text).join(""),
    line,
    "fixture guard: the parts of one line reconstruct that line exactly"
  );
  assert.deepEqual(
    mentionAppearances(hits, notes, noteHandles(VESNA.props), VESNA.path).map((a) => [
      a.path,
      a.handle,
    ]),
    [
      ["Journal/2026-08-11.md", "+49 30 5550199"],
      ["Journal/2026-08-12.md", "+49 30 5550199"],
    ],
    "the spaces between the marked runs are the text's own, not the join's"
  );
});

test("a handle spanning two matched lines is not a mention", () => {
  const notes = [note("Journal/2026-08-11.md", {})];
  const hits = [
    hit("Journal/2026-08-11.md", ["the number ends +49", "30 5550199 was the old one"]),
  ];
  assert.deepEqual(
    mentionAppearances(hits, notes, noteHandles(VESNA.props), VESNA.path),
    [],
    "separate lines are separate text — nobody wrote that number"
  );
});

test("a mention needs the whole handle: @ivo is not @ivonne", () => {
  const ivo = note("People/Ivo.md", { type: "contact", handles: "@ivo" });
  const notes = [note("Journal/2026-08-11.md", {}), note("Journal/2026-08-12.md", {})];
  const hits = [
    hit("Journal/2026-08-11.md", ["@ivonne sent the stems"]),
    hit("Journal/2026-08-12.md", ["@ivo sent the stems"]),
  ];
  assert.deepEqual(
    mentionAppearances(hits, notes, noteHandles(ivo.props), ivo.path).map((a) => a.path),
    ["Journal/2026-08-12.md"],
    "the longer @name is a different person, not this one"
  );
});

test("the handle boundary is Unicode-wide: @иван is not @иванов", () => {
  const person = note("People/Ivan.md", { type: "contact", handles: "@иван" });
  const notes = [note("Journal/2026-08-11.md", {}), note("Journal/2026-08-12.md", {})];
  const hits = [
    hit("Journal/2026-08-11.md", ["@иванов sent the stems"]),
    hit("Journal/2026-08-12.md", ["@иван sent the stems"]),
  ];
  assert.deepEqual(
    mentionAppearances(hits, notes, noteHandles(person.props), person.path).map((a) => a.path),
    ["Journal/2026-08-12.md"],
    "a non-ASCII letter continues a handle just like an ASCII one"
  );
});

test("a mention needs the whole handle: user@ivoserver.com is not @ivo", () => {
  const ivo = note("People/Ivo.md", { type: "contact", handles: "@ivo" });
  const notes = [note("Journal/2026-08-11.md", {})];
  const hits = [hit("Journal/2026-08-11.md", ["invoice from user@ivoserver.com"])];
  assert.deepEqual(mentionAppearances(hits, notes, noteHandles(ivo.props), ivo.path), []);
});

test("a mention needs the whole handle: not-vesna@example.com never surfaces", () => {
  const notes = [note("Journal/2026-08-11.md", {}), note("Journal/2026-08-12.md", {})];
  const hits = [
    hit("Journal/2026-08-11.md", ["bounced back from not-vesna@example.com"]),
    hit("Journal/2026-08-12.md", ["wrote to vesna@example.com."]),
  ];
  assert.deepEqual(
    mentionAppearances(hits, notes, noteHandles(VESNA.props), VESNA.path).map((a) => a.path),
    ["Journal/2026-08-12.md"],
    "a prefixed address is another address; a sentence-ending dot still counts"
  );
});

test("another person note sharing a handle is a duplicate, not a mention", () => {
  const other = note("People/Vesna (old).md", {
    type: "contact",
    handles: "vesna@example.com",
  });
  const hits = [hit("People/Vesna (old).md", [], ["vesna@example.com"])];
  assert.deepEqual(
    mentionAppearances(hits, [other], noteHandles(VESNA.props), VESNA.path),
    [],
    "the other person's handles column is a duplicate to resolve, not a meeting"
  );
});

test("mentionAppearances skips a hit the vault list does not know", () => {
  const hits = [hit("Gone/Deleted.md", ["vesna@example.com"])];
  assert.deepEqual(mentionAppearances(hits, [], noteHandles(VESNA.props), VESNA.path), []);
});

test("a structural appearance outranks a mention of the same note", () => {
  const notes = [note("Releases/UG-014.md", { type: "release", artist: "vesna@example.com" })];
  const hits = [hit("Releases/UG-014.md", ["credits: vesna@example.com"])];
  const groups = buildAppearances({ self: VESNA, notes, schema: SCHEMA, searchHits: hits });
  assert.deepEqual(
    groups.map((g) => [g.key, g.entries.length]),
    [["row:release", 1]],
    "no Mentions section for a note already shown as a row"
  );
});

test("sealed always wins: sealed notes contribute nothing, in any lane", () => {
  const notes = [
    note("Sessions/Sealed.md", { type: "session", date: "2026-08-11", with: "@vesna" }, { sealed: true }),
    note("Releases/Sealed.md", { type: "release", artist: "vesna@example.com" }, { sealed: true }),
    note("Journal/Sealed.md", {}, { sealed: true }),
  ];
  const hits = [hit("Journal/Sealed.md", ["vesna@example.com"])];
  const handles = noteHandles(VESNA.props);
  assert.deepEqual(eventAppearances(notes, handles, VESNA.path, SCHEMA), []);
  assert.deepEqual(rowAppearances(notes, handles, VESNA.path), []);
  assert.deepEqual(mentionAppearances(hits, notes, handles, VESNA.path), []);
  assert.deepEqual(buildAppearances({ self: VESNA, notes, schema: SCHEMA, searchHits: hits }), []);
});

test("a sealed person note computes no rail at all", () => {
  const sealedPerson = note("People/Vesna.md", {}, { sealed: true });
  const notes = [note("Releases/UG-014.md", { type: "release", artist: "vesna@example.com" })];
  assert.deepEqual(buildAppearances({ self: sealedPerson, notes, schema: SCHEMA }), []);
});

test("no handles means no rail, whatever the vault holds", () => {
  const blank = note("People/Nobody.md", { type: "contact", handles: "" });
  const notes = [note("Releases/UG-014.md", { type: "release", artist: "vesna@example.com" })];
  assert.deepEqual(buildAppearances({ self: blank, notes, schema: SCHEMA }), []);
});

test("the rail orders calendar, then databases by size, then mentions", () => {
  const notes = [
    note("Sessions/Mix.md", { type: "session", date: "2026-03-04", with: "@vesna" }),
    note("Releases/UG-014.md", { type: "release", artist: "vesna@example.com" }),
    note("Releases/UG-016.md", { type: "release", artist: "@vesna" }),
    note("Finance/Payout.md", { type: "transaction", counterparty: "@vesna" }),
    note("Journal/2026-08-11.md", {}),
  ];
  const hits = [hit("Journal/2026-08-11.md", ["called +49 30 5550199"])];
  const groups = buildAppearances({ self: VESNA, notes, schema: SCHEMA, searchHits: hits });
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Calendar", "Releases", "Transaction", "Mentions"]
  );
  assert.deepEqual(groups[3].entries[0].handle, "+49 30 5550199");
});

test("an empty search lane simply leaves the mentions section out", () => {
  const notes = [note("Releases/UG-014.md", { type: "release", artist: "vesna@example.com" })];
  const groups = buildAppearances({ self: VESNA, notes, schema: SCHEMA });
  assert.deepEqual(groups.map((g) => g.kind), ["row"]);
});
