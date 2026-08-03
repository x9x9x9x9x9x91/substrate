import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta, PropSchema } from "./types.ts";
import {
  compareTarget,
  completeFilter,
  filterCompletions,
  filterDeadEndHint,
  filterInherits,
  filterLabel,
  matchesFilters,
  parseQuery,
  remapSavedQueryProperty,
  resolveCompare,
  textWords,
} from "./query.ts";

/* A fixed "today" keeps the relative-duration assertions deterministic —
   2026-07-17 is a Friday, so week math crosses a month boundary below. */
const TODAY = "2026-07-17";

function note(title: string, props: Record<string, unknown> = {}): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props,
    updated_ms: 0,
    excerpt: "",
  };
}

test("parseQuery: spaced comparisons parse for every operator", () => {
  for (const op of ["<", ">", "<=", ">="] as const) {
    const p = parseQuery(`due ${op} 7d `, TODAY); // trailing space commits
    assert.deepEqual(p.filters, [{ key: "due", values: ["7d"], op }], op);
    assert.equal(p.text, "");
    assert.equal(p.trailing, null);
  }
});

test("parseQuery: comparison spacing variants all read the same", () => {
  for (const q of ["due < 7d ", "due <7d ", "due< 7d ", "due<7d "]) {
    assert.deepEqual(
      parseQuery(q, TODAY).filters,
      [{ key: "due", values: ["7d"], op: "<" }],
      q
    );
  }
});

test("parseQuery: absolute ISO operands and case-folding", () => {
  const p = parseQuery("Due < 2026-08-01 ", TODAY);
  assert.deepEqual(p.filters, [{ key: "due", values: ["2026-08-01"], op: "<" }]);
  assert.deepEqual(parseQuery("due >= 2W ", TODAY).filters, [
    { key: "due", values: ["2w"], op: ">=" },
  ]);
});

test("parseQuery: comparisons mix with classic filters and bare words", () => {
  const p = parseQuery("status:live drift due < 7d ", TODAY);
  assert.deepEqual(p.filters, [
    { key: "status", values: ["live"] },
    { key: "due", values: ["7d"], op: "<" },
  ]);
  assert.equal(p.text, "drift");
});

test("parseQuery: an uncommitted comparison is trailing, not a filter", () => {
  // cursor still in the token — completions, no filtering yet (like `status:`)
  const p = parseQuery("due < 7d", TODAY);
  assert.deepEqual(p.filters, []);
  assert.deepEqual(p.trailing, { key: "due", values: [], partial: "7d", op: "<" });
  // half-typed operand: still trailing, completions can offer prop dates
  const partial = parseQuery("due < 2026-", TODAY);
  assert.deepEqual(partial.trailing, { key: "due", values: [], partial: "2026-", op: "<" });
  // dangling operator: trailing with an empty partial
  assert.deepEqual(parseQuery("due <", TODAY).trailing, { key: "due", values: [], partial: "", op: "<" });
  assert.deepEqual(parseQuery("due<", TODAY).trailing, { key: "due", values: [], partial: "", op: "<" });
  // anything after the expression commits it
  const p2 = parseQuery("due < 7d drift", TODAY);
  assert.deepEqual(p2.filters, [{ key: "due", values: ["7d"], op: "<" }]);
  assert.equal(p2.trailing, null);
  assert.equal(p2.text, "drift");
});

test("parseQuery: an invalid operand keeps the raw tokens as words", () => {
  // committed (trailing space) but neither duration nor ISO date — same rule
  // as pasted URLs: matches the shape, never a filter
  const p = parseQuery("due < soon ", TODAY);
  assert.deepEqual(p.filters, []);
  assert.equal(p.trailing, null);
  assert.equal(p.text, "due < soon");
  // a numeric comparison is not in the language either
  assert.equal(parseQuery("score > 3 ", TODAY).text, "score > 3");
  // and a following classic filter still parses as a filter
  const p2 = parseQuery("due < status:live ", TODAY);
  assert.deepEqual(p2.filters, [{ key: "status", values: ["live"] }]);
  assert.equal(p2.text, "due <");
});

test("compareTarget resolves durations from today and ISO dates literally", () => {
  assert.equal(compareTarget("7d", TODAY), "2026-07-24");
  assert.equal(compareTarget("2w", TODAY), "2026-07-31");
  assert.equal(compareTarget("0d", TODAY), TODAY);
  assert.equal(compareTarget("2026-08-01", TODAY), "2026-08-01");
  assert.equal(compareTarget("soon", TODAY), null);
  assert.equal(compareTarget("2026-13-01", TODAY), null, "impossible date is no operand");
});

test("matchesFilters: relative comparisons measure from today", () => {
  // due < 7d = due earlier than today+7d (2026-07-24) — strict, so the day
  // exactly a week out does NOT hit, but overdue days always do
  const lt7d = [{ key: "due", values: ["7d"], op: "<" as const }];
  assert.ok(matchesFilters(note("a", { due: "2026-07-23" }), lt7d, TODAY));
  assert.ok(matchesFilters(note("a", { due: TODAY }), lt7d, TODAY), "today is < 7d out");
  assert.ok(matchesFilters(note("a", { due: "2026-07-10" }), lt7d, TODAY), "overdue included");
  assert.ok(!matchesFilters(note("a", { due: "2026-07-24" }), lt7d, TODAY), "strict boundary");
  assert.ok(!matchesFilters(note("a", { due: "2026-08-01" }), lt7d, TODAY));
  // weeks: due <= 2w = on or before today+14d (2026-07-31), boundary included
  const le2w = [{ key: "due", values: ["2w"], op: "<=" as const }];
  assert.ok(matchesFilters(note("a", { due: "2026-07-31" }), le2w, TODAY));
  assert.ok(!matchesFilters(note("a", { due: "2026-08-01" }), le2w, TODAY));
  // due > 0d = strictly after today; due >= 0d = today or later
  assert.ok(matchesFilters(note("a", { due: "2026-07-18" }), [{ key: "due", values: ["0d"], op: ">" }], TODAY));
  assert.ok(!matchesFilters(note("a", { due: TODAY }), [{ key: "due", values: ["0d"], op: ">" }], TODAY));
  assert.ok(matchesFilters(note("a", { due: TODAY }), [{ key: "due", values: ["0d"], op: ">=" }], TODAY));
});

test("matchesFilters: absolute comparisons hit the literal day", () => {
  const before = [{ key: "released", values: ["2026-07-01"], op: "<" as const }];
  assert.ok(matchesFilters(note("a", { released: "2026-06-30" }), before, TODAY));
  assert.ok(!matchesFilters(note("a", { released: "2026-07-01" }), before, TODAY));
  const onOrAfter = [{ key: "released", values: ["2026-07-01"], op: ">=" as const }];
  assert.ok(matchesFilters(note("a", { released: "2026-07-01" }), onOrAfter, TODAY));
});

test("matchesFilters: comparison edge cases", () => {
  const lt7d = [{ key: "due", values: ["7d"], op: "<" as const }];
  // missing prop never satisfies a comparison
  assert.ok(!matchesFilters(note("a"), lt7d, TODAY));
  // a non-date value (even a schema'd date prop gone stale) never hits
  assert.ok(!matchesFilters(note("a", { due: "soonish" }), lt7d, TODAY));
  assert.ok(!matchesFilters(note("a", { due: "2026-7-1" }), lt7d, TODAY), "unpadded is not ISO");
  assert.ok(!matchesFilters(note("a", { status: "live" }), [{ key: "status", values: ["7d"], op: "<" }], TODAY));
  // an unresolvable operand leaves the filter inert — a half-typed `due < 7`
  // narrows nothing instead of blanking the list
  assert.ok(matchesFilters(note("a", { due: "2026-07-20" }), [{ key: "due", values: ["7"], op: "<" }], TODAY));
  assert.ok(matchesFilters(note("a"), [{ key: "due", values: ["soon"], op: "<" }], TODAY));
  // folder names aren't dates either
  const inInbox = { ...note("a"), folder: "Inbox" };
  assert.ok(!matchesFilters(inInbox, [{ key: "folder", values: ["7d"], op: "<" }], TODAY));
});

test("matchesFilters: a timed value compares on its day part (SUB-270)", () => {
  const lt7d = [{ key: "due", values: ["7d"], op: "<" as const }];
  assert.ok(matchesFilters(note("a", { due: "2026-07-23 14:30" }), lt7d, TODAY));
  assert.ok(matchesFilters(note("a", { due: `${TODAY} 09:00` }), lt7d, TODAY), "today, timed");
  assert.ok(matchesFilters(note("a", { due: "2026-07-10 23:59" }), lt7d, TODAY), "overdue, timed");
  assert.ok(!matchesFilters(note("a", { due: "2026-07-24 00:00" }), lt7d, TODAY), "strict boundary");
  assert.ok(!matchesFilters(note("a", { due: "2026-07-20 25:00" }), lt7d, TODAY), "a bad time is no date");
  // absolute operands and other ops behave the same
  const onOrAfter = [{ key: "due", values: ["2026-07-01"], op: ">=" as const }];
  assert.ok(matchesFilters(note("a", { due: "2026-07-01 08:00" }), onOrAfter, TODAY));
});

test("matchesFilters: a range hits only when the whole span satisfies it (SUB-596)", () => {
  // `due < today` is the overdue question: a span still running is not late,
  // it hits the day after it closes
  const overdue = [{ key: "due", values: ["0d"], op: "<" as const }];
  assert.ok(
    !matchesFilters(note("a", { due: "2026-07-10/2026-07-25" }), overdue, TODAY),
    "started, still running"
  );
  assert.ok(
    !matchesFilters(note("a", { due: `2026-07-10/${TODAY}` }), overdue, TODAY),
    "closing today is not late"
  );
  assert.ok(matchesFilters(note("a", { due: "2026-07-10/2026-07-16" }), overdue, TODAY), "closed");
  // forward operators read the start, exactly as a single date would
  const lt7d = [{ key: "due", values: ["7d"], op: "<" as const }];
  assert.ok(matchesFilters(note("a", { due: "2026-07-20/2026-07-21" }), lt7d, TODAY));
  assert.ok(!matchesFilters(note("a", { due: "2026-07-24/2026-07-26" }), lt7d, TODAY), "boundary");
  const onOrAfter = [{ key: "due", values: ["2026-07-01"], op: ">=" as const }];
  assert.ok(matchesFilters(note("a", { due: "2026-07-01/2026-07-09" }), onOrAfter, TODAY));
  assert.ok(!matchesFilters(note("a", { due: "2026-06-30/2026-07-09" }), onOrAfter, TODAY));
  // a reversed range is not a date value, so it never satisfies a comparison
  assert.ok(!matchesFilters(note("a", { due: "2026-07-25/2026-07-10" }), lt7d, TODAY));
});

test("matchesFilters: classic filters are untouched by the op field", () => {
  assert.ok(matchesFilters(note("a", { status: "mastering" }), [{ key: "status", values: ["mast"] }]));
  assert.ok(matchesFilters(note("a", { status: "mastering" }), [{ key: "status", values: ["mast"], op: ":" }]));
  assert.ok(!matchesFilters(note("a", { status: "live" }), [{ key: "status", values: ["mast"] }]));
});

test("completeFilter rebuilds comparisons in spaced form", () => {
  assert.equal(completeFilter("due < 2026-", "due", "2026-08-01", "<"), "due < 2026-08-01 ");
  assert.equal(completeFilter("due <", "due", "2026-08-01", "<"), "due < 2026-08-01 ");
  assert.equal(completeFilter("due<7", "due", "2026-08-01", "<"), "due < 2026-08-01 ");
  assert.equal(
    completeFilter("status:live due < 20", "due", "2026-08-01", "<="),
    "status:live due <= 2026-08-01 "
  );
  // classic path unchanged
  assert.equal(completeFilter("status:li", "status", "live", ":"), "status:live ");
  assert.equal(completeFilter("status:in", "status", "in review"), 'status:"in review" ');
});

test("filterLabel spells classic and comparison filters", () => {
  assert.equal(filterLabel("status", ":", ["live"]), "status:live");
  assert.equal(filterLabel("due", "<", ["2026-08-01"]), "due < 2026-08-01");
});

test("parseQuery: a bare quoted phrase never shreds into words (SUB-232 → SUB-219)", () => {
  // SUB-232 kept the phrase glued inside `text`; SUB-219 supersedes that by
  // extracting it into `phrases` — either way it must not split into words
  const p = parseQuery('"night drive" ');
  assert.equal(p.text, "");
  assert.deepEqual(p.phrases, ["night drive"]);
  assert.deepEqual(p.filters, []);
  // phrases mix with filters and plain words
  const q = parseQuery('status:live "night drive" owl ', TODAY);
  assert.equal(q.text, "owl");
  assert.deepEqual(q.phrases, ["night drive"]);
  assert.deepEqual(q.filters, [{ key: "status", values: ["live"] }]);
});

test("textWords: a quoted phrase is ONE word, quotes stripped (SUB-232)", () => {
  assert.deepEqual(textWords('"night drive"'), ["night drive"]);
  assert.deepEqual(textWords('slow "night drive" mix'), ["slow", "night drive", "mix"]);
  // unquoted words split on whitespace as before, lowercased
  assert.deepEqual(textWords("Night Drive"), ["night", "drive"]);
  assert.deepEqual(textWords(""), []);
});

test("a space after the colon still filters — Status: mastering (SUB-80)", () => {
  const p = parseQuery("Status: mastering ");
  assert.deepEqual(p.filters, [{ key: "status", values: ["mastering"] }]);
  assert.equal(p.text, "");
  // quoted spaced value too
  const q = parseQuery('status: "in review" ');
  assert.deepEqual(q.filters, [{ key: "status", values: ["in review"] }]);
  // still typing the spaced value → completions, not a hard filter
  const t = parseQuery("status: mas");
  assert.deepEqual(t.filters, []);
  assert.deepEqual(t.trailing, { key: "status", values: [], partial: "mas", op: ":" });
  // a following operator is NOT swallowed as the value
  const u = parseQuery("status: artist:various ");
  assert.deepEqual(u.filters, [{ key: "artist", values: ["various"] }]);
});

test("completeFilter collapses a spaced stub into one filter token (SUB-80)", () => {
  assert.equal(completeFilter("Status: mas", "status", "mastering"), "status:mastering ");
  assert.equal(completeFilter("slow status:mas", "status", "mastering"), "slow status:mastering ");
  assert.equal(completeFilter("status: rev", "status", "in review"), 'status:"in review" ');
});

test("parseQuery: a comma-separated value is an OR over one prop (SUB-78)", () => {
  // committed (trailing space): both segments, lowercased
  const p = parseQuery("Status:Live,Parked ", TODAY);
  assert.deepEqual(p.filters, [{ key: "status", values: ["live", "parked"] }]);
  assert.equal(p.text, "");
  assert.equal(p.trailing, null);
  // a single value is just a one-element OR — the classic shape, unchanged
  assert.deepEqual(parseQuery("status:live ", TODAY).filters, [{ key: "status", values: ["live"] }]);
  // empty segments drop out
  assert.deepEqual(parseQuery("status:live,,parked ", TODAY).filters, [
    { key: "status", values: ["live", "parked"] },
  ]);
  // a comma inside quotes stays literal
  assert.deepEqual(parseQuery('category:"Foo, Inc",Bar ', TODAY).filters, [
    { key: "category", values: ["foo, inc", "bar"] },
  ]);
});

test("parseQuery: quoted segments in a multi-value filter (SUB-78)", () => {
  // a quoted segment rides along with bare ones
  const p = parseQuery('category:"Club/Venue",Festival ', TODAY);
  assert.deepEqual(p.filters, [{ key: "category", values: ["club/venue", "festival"] }]);
  // fully quoted multi-value commits without a trailing space, like single-value
  const q = parseQuery('category:"Club/Venue","Festival Hall"', TODAY);
  assert.deepEqual(q.filters, [{ key: "category", values: ["club/venue", "festival hall"] }]);
  assert.equal(q.trailing, null);
});

test("parseQuery: a half-typed multi-value stub trails on its last segment (SUB-78)", () => {
  const p = parseQuery("category:Label,Fes", TODAY);
  assert.deepEqual(p.filters, []);
  assert.deepEqual(p.trailing, { key: "category", values: ["label"], partial: "fes", op: ":" });
  // a dangling comma commits the earlier segments and starts a fresh partial
  const q = parseQuery("category:Label,", TODAY);
  assert.deepEqual(q.trailing, { key: "category", values: ["label"], partial: "", op: ":" });
  // quoted committed segments survive in the stub
  const r = parseQuery('category:"Club/Venue",Fes', TODAY);
  assert.deepEqual(r.trailing, { key: "category", values: ["club/venue"], partial: "fes", op: ":" });
  // single-value stubs trail exactly like before
  assert.deepEqual(parseQuery("category:Lab", TODAY).trailing, {
    key: "category",
    values: [],
    partial: "lab",
    op: ":",
  });
});

test("parseQuery: the spaced form splits multi-values too (SUB-78)", () => {
  // committed with a trailing space
  assert.deepEqual(parseQuery("status: live,parked ", TODAY).filters, [
    { key: "status", values: ["live", "parked"] },
  ]);
  // still typing: the last segment is the partial, the rest are committed
  const p = parseQuery("status: live,parked", TODAY);
  assert.deepEqual(p.filters, []);
  assert.deepEqual(p.trailing, { key: "status", values: ["live"], partial: "parked", op: ":" });
  // quoted segments in the spaced list
  assert.deepEqual(parseQuery('category: "Club/Venue",Festival ', TODAY).filters, [
    { key: "category", values: ["club/venue", "festival"] },
  ]);
});

test("matchesFilters: a capitalized frontmatter key still matches (SUB-916)", () => {
  // hand-written YAML says `Status: live`; the parse folds the filter key to
  // lowercase — propValues must fold the prop read like every other surface
  const f = parseQuery("status:live ", TODAY).filters;
  assert.ok(matchesFilters(note("a", { Status: "live" }), f, TODAY));
  assert.ok(!matchesFilters(note("b", { Status: "parked" }), f, TODAY));
  // exact-first: a note carrying both spellings reads the exact key
  assert.ok(matchesFilters(note("c", { status: "live", Status: "parked" }), f, TODAY));
  // completions see the cased column's values too
  const cased = [note("d", { Status: "live" }), note("e", { Status: "parked" })];
  assert.deepEqual(filterCompletions(cased, "status", "").sort(), ["live", "parked"]);
});

test("matchesFilters: a multi-value filter is an OR (SUB-78)", () => {
  const f = [{ key: "status", values: ["live", "parked"] }];
  assert.ok(matchesFilters(note("a", { status: "live" }), f));
  assert.ok(matchesFilters(note("b", { status: "parked" }), f));
  assert.ok(matchesFilters(note("c", { status: "Parked" }), f), "case-insensitive per value");
  assert.ok(!matchesFilters(note("d", { status: "mastering" }), f));
  assert.ok(!matchesFilters(note("e"), f), "missing prop never hits");
  // per-value prefix semantics survive: `li,pa` hits live and parked
  const prefixes = [{ key: "status", values: ["li", "pa"] }];
  assert.ok(matchesFilters(note("a", { status: "live" }), prefixes));
  assert.ok(matchesFilters(note("b", { status: "parked" }), prefixes));
  assert.ok(!matchesFilters(note("c", { status: "mastering" }), prefixes));
  // a multi-entry prop (relation list) ORs against every filter value
  const rel = note("g", { contact: ["Gero", "Noa"] });
  assert.ok(matchesFilters(rel, [{ key: "contact", values: ["x", "no"] }]));
  assert.ok(!matchesFilters(rel, [{ key: "contact", values: ["x", "y"] }]));
  // several filters still AND across keys
  const both = [
    { key: "status", values: ["live", "parked"] },
    { key: "artist", values: ["various"] },
  ];
  assert.ok(matchesFilters(note("h", { status: "parked", artist: "various" }), both));
  assert.ok(!matchesFilters(note("i", { status: "parked", artist: "fern palace" }), both));
});

test("matchesFilters: a multi prop's YAML list filters per value (SUB-79)", () => {
  const rel = note("a", { format: ["Vinyl", "Digital"] });
  assert.ok(matchesFilters(rel, [{ key: "format", values: ["vinyl"] }]));
  assert.ok(matchesFilters(rel, [{ key: "format", values: ["dig"] }]), "prefix per value");
  assert.ok(!matchesFilters(rel, [{ key: "format", values: ["tape"] }]));
  // a scalar on a multi prop (legal on disk for one value) matches the same way
  assert.ok(matchesFilters(note("b", { format: "Vinyl" }), [{ key: "format", values: ["vinyl"] }]));
});

test("completeFilter keeps the committed multi-value prefix (SUB-78)", () => {
  assert.equal(completeFilter("category:Label,Fes", "category", "Festival"), "category:Label,Festival ");
  // the spaced stub collapses to one token, prefix kept
  assert.equal(completeFilter("category: Label,Fes", "category", "Festival"), "category:Label,Festival ");
  // quoted committed segments stay quoted verbatim
  assert.equal(
    completeFilter('category:"Club/Venue",Fes', "category", "Festival"),
    'category:"Club/Venue",Festival '
  );
  // a dangling comma keeps the whole stub as the prefix
  assert.equal(completeFilter("category:Label,", "category", "Festival"), "category:Label,Festival ");
  // a completed value with a space or comma quotes itself
  assert.equal(completeFilter("category:Label,Fes", "category", "Festival Hall"), 'category:Label,"Festival Hall" ');
  assert.equal(completeFilter("category:Label,Fes", "category", "Foo, Inc"), 'category:Label,"Foo, Inc" ');
});

test("filterLabel joins multi-values for the chip (SUB-78)", () => {
  assert.equal(filterLabel("category", ":", ["label", "festival"]), "category:label, festival");
  assert.equal(filterLabel("status", ":", ["live"]), "status:live");
});

test("parseQuery: a leading - negates a classic filter (SUB-198)", () => {
  const p = parseQuery("-Status:Live ", TODAY);
  assert.deepEqual(p.filters, [{ key: "status", values: ["live"], neg: true }]);
  assert.equal(p.text, "");
  assert.equal(p.trailing, null);
  // multi-value: none-of
  assert.deepEqual(parseQuery("-type:synth,sampler ", TODAY).filters, [
    { key: "type", values: ["synth", "sampler"], neg: true },
  ]);
  // quoted and spaced forms negate too
  assert.deepEqual(parseQuery('-status:"in review" ', TODAY).filters, [
    { key: "status", values: ["in review"], neg: true },
  ]);
  assert.deepEqual(parseQuery("-status: mastering ", TODAY).filters, [
    { key: "status", values: ["mastering"], neg: true },
  ]);
  // mixed with positive filters and bare words
  const q = parseQuery("status:live drift -type:synth ", TODAY);
  assert.deepEqual(q.filters, [
    { key: "status", values: ["live"] },
    { key: "type", values: ["synth"], neg: true },
  ]);
  assert.equal(q.text, "drift");
});

test("parseQuery: a leading - negates comparisons in every spacing form (SUB-198)", () => {
  for (const q of ["-due < 7d ", "-due <7d ", "-due< 7d ", "-due<7d "]) {
    assert.deepEqual(
      parseQuery(q, TODAY).filters,
      [{ key: "due", values: ["7d"], op: "<", neg: true }],
      q
    );
  }
  assert.deepEqual(parseQuery("-due >= 2026-08-01 ", TODAY).filters, [
    { key: "due", values: ["2026-08-01"], op: ">=", neg: true },
  ]);
});

test("parseQuery: a negated stub still trails for completions (SUB-198)", () => {
  assert.deepEqual(parseQuery("-type:sy", TODAY).trailing, {
    key: "type",
    values: [],
    partial: "sy",
    op: ":",
    neg: true,
  });
  // multi-value stub: committed segments kept, negation kept
  assert.deepEqual(parseQuery("-category:Label,Fes", TODAY).trailing, {
    key: "category",
    values: ["label"],
    partial: "fes",
    op: ":",
    neg: true,
  });
  // spaced stub
  assert.deepEqual(parseQuery("-status: mas", TODAY).trailing, {
    key: "status",
    values: [],
    partial: "mas",
    op: ":",
    neg: true,
  });
  // half-typed negated comparison
  assert.deepEqual(parseQuery("-due <", TODAY).trailing, {
    key: "due",
    values: [],
    partial: "",
    op: "<",
    neg: true,
  });
  assert.deepEqual(parseQuery("-due < 2026-", TODAY).trailing, {
    key: "due",
    values: [],
    partial: "2026-",
    op: "<",
    neg: true,
  });
});

test("parseQuery: - only negates a real filter shape; hyphens stay text (SUB-198)", () => {
  // `-foo` is not key:value — plain text, exactly as before
  const p = parseQuery("-foo ", TODAY);
  assert.deepEqual(p.filters, []);
  assert.equal(p.text, "-foo");
  // a hyphen inside a word was and is text
  assert.equal(parseQuery("foo-bar ", TODAY).text, "foo-bar");
  assert.equal(parseQuery("night-shift ", TODAY).text, "night-shift");
  // a lone hyphen, and a hyphen separated by a space, are text too
  assert.equal(parseQuery("- ", TODAY).text, "-");
  assert.equal(parseQuery("- status:live ", TODAY).text, "-");
  // a negated URL is still a URL, not a filter
  const u = parseQuery("-https://example.com/a ", TODAY);
  assert.deepEqual(u.filters, []);
  assert.equal(u.text, "-https://example.com/a");
  // an invalid comparison operand keeps the raw tokens, prefix included
  assert.equal(parseQuery("-due < soon ", TODAY).text, "-due < soon");
});

test("parseQuery: a negated operator is not swallowed as a spaced value (SUB-198)", () => {
  // same rule as `status: artist:various` — the next operator stands alone
  const p = parseQuery("status: -artist:various ", TODAY);
  assert.deepEqual(p.filters, [{ key: "artist", values: ["various"], neg: true }]);
});

test("matchesFilters: a negated classic filter is a none-of (SUB-198)", () => {
  const f = [{ key: "type", values: ["synth", "sampler"], neg: true }];
  assert.ok(!matchesFilters(note("a", { type: "Synth" }), f));
  assert.ok(!matchesFilters(note("b", { type: "sampler" }), f));
  assert.ok(matchesFilters(note("c", { type: "guitar" }), f));
  assert.ok(matchesFilters(note("d"), f), "missing prop always clears a negated filter");
  // select ≠ — per-value prefix semantics still apply inside the negation
  const live = [{ key: "status", values: ["live"], neg: true }];
  assert.ok(!matchesFilters(note("e", { status: "Live" }), live));
  assert.ok(matchesFilters(note("f", { status: "parked" }), live));
  assert.ok(!matchesFilters(note("g", { status: "mastering" }), [{ key: "status", values: ["mast"], neg: true }]));
  // text ≠ — same value match, inverted; a multi-entry prop must hold NONE
  const rel = note("h", { contact: ["Gero", "Noa"] });
  assert.ok(!matchesFilters(rel, [{ key: "contact", values: ["no"], neg: true }]));
  assert.ok(matchesFilters(rel, [{ key: "contact", values: ["x"], neg: true }]));
  // negation is per filter — other filters still AND as before
  const both = [
    { key: "status", values: ["live"] },
    { key: "type", values: ["synth"], neg: true },
  ];
  assert.ok(matchesFilters(note("i", { status: "live", type: "guitar" }), both));
  assert.ok(!matchesFilters(note("j", { status: "live", type: "synth" }), both));
});

test("matchesFilters: a negated comparison is a straight logical NOT (SUB-198)", () => {
  const lt7d = [{ key: "due", values: ["7d"], op: "<" as const, neg: true }];
  assert.ok(!matchesFilters(note("a", { due: "2026-07-20" }), lt7d, TODAY), "before the boundary");
  assert.ok(!matchesFilters(note("b", { due: "2026-07-10" }), lt7d, TODAY), "overdue would hit positively");
  assert.ok(matchesFilters(note("c", { due: "2026-07-24" }), lt7d, TODAY), "boundary day");
  assert.ok(matchesFilters(note("d", { due: "2026-08-01" }), lt7d, TODAY));
  // straight NOT: what never satisfies a comparison satisfies its negation
  assert.ok(matchesFilters(note("e"), lt7d, TODAY), "missing prop");
  assert.ok(matchesFilters(note("f", { due: "soonish" }), lt7d, TODAY), "non-date value");
  // an unresolvable operand stays inert, negated or not
  assert.ok(matchesFilters(note("g"), [{ key: "due", values: ["soon"], op: "<", neg: true }], TODAY));
});

test("filterLabel reads a negated filter with a not prefix (SUB-198)", () => {
  assert.equal(filterLabel("type", ":", ["synth"], true), "not type:synth");
  assert.equal(filterLabel("category", ":", ["label", "festival"], true), "not category:label, festival");
  assert.equal(filterLabel("due", "<", ["2026-08-01"], true), "not due < 2026-08-01");
  // positive spelling untouched
  assert.equal(filterLabel("type", ":", ["synth"]), "type:synth");
});

test("completeFilter round-trips the negation prefix (SUB-198)", () => {
  assert.equal(completeFilter("-type:sy", "type", "synth"), "-type:synth ");
  assert.equal(completeFilter("-Status: mas", "status", "mastering"), "-status:mastering ");
  assert.equal(completeFilter("slow -type:sy", "type", "synth"), "slow -type:synth ");
  // the committed multi-value prefix survives behind the `-`
  assert.equal(completeFilter("-category:Label,Fes", "category", "Festival"), "-category:Label,Festival ");
  assert.equal(completeFilter("-category: Label,Fes", "category", "Festival"), "-category:Label,Festival ");
  // comparisons rebuild in spaced form, prefix kept
  assert.equal(completeFilter("-due < 20", "due", "2026-08-01", "<="), "-due <= 2026-08-01 ");
  assert.equal(completeFilter("-due<7", "due", "2026-08-01", "<"), "-due < 2026-08-01 ");
});

test("filterInherits: bare key:value terms pin props (SUB-234)", () => {
  const p = parseQuery("status:live cat#:12 ", TODAY);
  assert.deepEqual(filterInherits(p.filters), [
    ["status", "live"],
    ["cat#", "12"],
  ]);
  // case folds like the match itself
  assert.deepEqual(filterInherits(parseQuery("Status:Live ", TODAY).filters), [["status", "live"]]);
});

test("filterInherits: negations, comparisons, OR lists, phrases, folder don't inherit", () => {
  const p = parseQuery('-status:live due < 7d cat:a,b artist:"brian eno" folder:Inbox ', TODAY);
  assert.equal(p.filters.length, 5, "all five shapes parse as committed filters");
  assert.deepEqual(filterInherits(p.filters), []);
  // free text never reaches the inherit list (it's not a filter at all)
  assert.deepEqual(filterInherits(parseQuery("drift status:live ", TODAY).filters), [["status", "live"]]);
});

test("filterInherits: the first term per key wins (SUB-234)", () => {
  const p = parseQuery("status:live status:parked ", TODAY);
  assert.deepEqual(filterInherits(p.filters), [["status", "live"]]);
});

test("parseQuery: a quoted phrase is a phrase, not words (SUB-219)", () => {
  // before SUB-219 the quotes stayed on the text words, so a quoted phrase
  // never hit anything outside the search pane
  const p = parseQuery('"slow bloom" ', TODAY);
  assert.deepEqual(p.phrases, ["slow bloom"]);
  assert.equal(p.text, "");
  assert.deepEqual(p.filters, []);
  // phrases mix with filters and bare words
  const q = parseQuery('status:live "in review" drift ', TODAY);
  assert.deepEqual(q.filters, [{ key: "status", values: ["live"] }]);
  assert.deepEqual(q.phrases, ["in review"]);
  assert.equal(q.text, "drift");
  // several phrases keep their order
  assert.deepEqual(parseQuery('"foo bar" "baz" ', TODAY).phrases, ["foo bar", "baz"]);
  // an empty quoted section is nothing
  const e = parseQuery('"" ', TODAY);
  assert.deepEqual(e.phrases, []);
  assert.equal(e.text, "");
  // an unclosed quote is still being typed — bare words, no phrase
  const u = parseQuery('"slow blo', TODAY);
  assert.deepEqual(u.phrases, []);
  assert.equal(u.text, "slow blo");
  // a quoted VALUE behind a key is still a filter, untouched by the phrase rule
  const f = parseQuery('status:"in review" ', TODAY);
  assert.deepEqual(f.filters, [{ key: "status", values: ["in review"] }]);
  assert.deepEqual(f.phrases, []);
});

test("parseQuery: non-http URIs and file paths are text, not filters (SUB-219)", () => {
  // the classic exemption covered http(s) only; any scheme:// is a URI
  for (const q of ["file:///x/y ", "notion://abc ", "obsidian://vault/note ", "ftp://h/p ", "ssh://h "]) {
    const p = parseQuery(q, TODAY);
    assert.deepEqual(p.filters, [], q);
    assert.equal(p.trailing, null, q);
    assert.equal(p.text, q.trim(), q);
  }
  // uncommitted too (cursor still in the token): no bogus trailing stub
  const u = parseQuery("file:///x", TODAY);
  assert.deepEqual(u.filters, []);
  assert.equal(u.trailing, null);
  assert.equal(u.text, "file:///x");
  // drive-letter and tilde paths
  for (const q of ["C:\\Music\\set.wav ", "c:/x ", "~/Music/set.wav "]) {
    const p = parseQuery(q, TODAY);
    assert.deepEqual(p.filters, [], q);
    assert.equal(p.trailing, null, q);
    assert.equal(p.text, q.trim(), q);
  }
  // a negated URI stays text, prefix included
  const n = parseQuery("-file:///x ", TODAY);
  assert.deepEqual(n.filters, []);
  assert.equal(n.text, "-file:///x");
  // a real filter next to a URI still parses as a filter
  const m = parseQuery("status:live file:///x ", TODAY);
  assert.deepEqual(m.filters, [{ key: "status", values: ["live"] }]);
  assert.equal(m.text, "file:///x");
  // and a URI is not swallowed as a spaced value
  const s = parseQuery("status: file:///x ", TODAY);
  assert.deepEqual(s.filters, []);
  assert.equal(s.text, "file:///x");
});

test("parseQuery: non-ASCII prop keys lex as keys (SUB-219)", () => {
  assert.deepEqual(parseQuery("Gebühr:12 ", TODAY).filters, [{ key: "gebühr", values: ["12"] }]);
  // the still-typing stub trails under the same key
  assert.deepEqual(parseQuery("Gebühr:ab", TODAY).trailing, {
    key: "gebühr",
    values: [],
    partial: "ab",
    op: ":",
  });
  // comparisons lex non-ASCII keys too
  assert.deepEqual(parseQuery("Fällig < 7d ", TODAY).filters, [
    { key: "fällig", values: ["7d"], op: "<" },
  ]);
});

test("matchesFilters: a non-ASCII prop key filters (SUB-219)", () => {
  const f = [{ key: "gebühr", values: ["12"] }];
  assert.ok(matchesFilters(note("a", { gebühr: "12" }), f));
  assert.ok(matchesFilters(note("b", { gebühr: "12,50" }), f), "prefix semantics intact");
  assert.ok(!matchesFilters(note("c", { gebühr: "13" }), f));
  assert.ok(!matchesFilters(note("d"), f), "missing prop never hits");
});

test("completeFilter lexes non-ASCII keys (SUB-219)", () => {
  assert.equal(completeFilter("Gebühr:ab", "gebühr", "12"), "gebühr:12 ");
  assert.equal(completeFilter("Fällig < 20", "fällig", "2026-08-01", "<="), "fällig <= 2026-08-01 ");
});

/* SUB-266 dead-end hints — the two heuristics under a filter bar's zero rows */
const HINT_COLS = ["status", "cat#", "artist", "category", "created"];
const HINT_NOTES = [
  note("Slow Bloom EP", { type: "release", status: "in review", "cat#": "SMP-030" }),
  note("Static Bouquet", { type: "release", status: "live" }),
];
const HINT_SCHEMA = {
  status: { options: [{ value: "in review" }, { value: "live" }, { value: "in progress" }] },
};

test("filterDeadEndHint: an unknown filter key names the property (SUB-266)", () => {
  assert.deepEqual(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "statsu:live x"), {
    text: 'no property "statsu"',
  });
  // the still-typed trailing stub can't start matching either
  assert.deepEqual(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "statsu:li"), {
    text: 'no property "statsu"',
  });
  // a key the type has never hints
  assert.equal(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "status:live zzz"), null);
});

test("filterDeadEndHint: value + bare words re-joined suggests the quoted value (SUB-266)", () => {
  assert.deepEqual(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "status:in review"), {
    text: 'did you mean status:"in review"?',
    fixedQuery: 'status:"in review"',
  });
  // a value only the schema's options know counts as existing too
  assert.deepEqual(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "status:in progress"), {
    text: 'did you mean status:"in progress"?',
    fixedQuery: 'status:"in progress"',
  });
  // display keeps the stored casing
  const cased = [note("A", { status: "In Review" })];
  assert.deepEqual(filterDeadEndHint(cased, HINT_COLS, {}, "status:in review"), {
    text: 'did you mean status:"In Review"?',
    fixedQuery: 'status:"In Review"',
  });
});

test("filterDeadEndHint: the rewrite keeps the query's other terms (SUB-266)", () => {
  // committed filters stay (values come back lowercased, as parsed)
  assert.deepEqual(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "status:in review cat#:SMP-030 "), {
    text: 'did you mean status:"in review"?',
    fixedQuery: 'cat#:smp-030 status:"in review"',
  });
  // a still-typed trailing stub comes along in committed form
  assert.deepEqual(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "status:in review cat#:smp"), {
    text: 'did you mean status:"in review"?',
    fixedQuery: 'status:"in review" cat#:smp',
  });
  // leftover words after the consumed ones stay as text
  assert.deepEqual(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "status:in review bouquet"), {
    text: 'did you mean status:"in review"?',
    fixedQuery: 'status:"in review" bouquet',
  });
});

test("filterDeadEndHint: the rewrite keeps quoted phrases (SUB-704)", () => {
  // the issue's repro: accepting the hint must not drop the phrase term
  assert.deepEqual(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, 'status:in review "night shift"'), {
    text: 'did you mean status:"in review"?',
    fixedQuery: 'status:"in review" "night shift"',
  });
  // filters + phrase + leftover words: phrases sit after the filters/stub,
  // ahead of the bare words (most-structured → least)
  assert.deepEqual(
    filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, 'status:in review cat#:SMP-030 "night shift" bouquet'),
    {
      text: 'did you mean status:"in review"?',
      fixedQuery: 'cat#:smp-030 status:"in review" "night shift" bouquet',
    }
  );
  // a phrase ahead of the filter survives too (position doesn't matter —
  // phrases parse into their own bucket)
  assert.deepEqual(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, '"night shift" status:in review'), {
    text: 'did you mean status:"in review"?',
    fixedQuery: 'status:"in review" "night shift"',
  });
});

test("filterDeadEndHint: heuristic (b) stays quiet outside its shape (SUB-266)", () => {
  // no bare words after the filter
  assert.equal(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "status:in"), null);
  assert.equal(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "status:in "), null);
  // re-joined words match no existing value
  assert.equal(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "status:in drafts"), null);
  // negated filters never get a suggestion
  assert.equal(filterDeadEndHint(HINT_NOTES, HINT_COLS, HINT_SCHEMA, "-status:in review"), null);
  // date comparisons are not value filters (and an unknown comparison key
  // is heuristic (a)'s case, not (b)'s)
  assert.equal(
    filterDeadEndHint(HINT_NOTES, [...HINT_COLS, "due"], HINT_SCHEMA, "due < 7d extra"),
    null
  );
});

test("filterDeadEndHint: folder is a known key whose values are folders (SUB-266)", () => {
  const inFolder: NoteMeta = { ...note("A"), folder: "Field notes" };
  assert.deepEqual(filterDeadEndHint([inFolder], HINT_COLS, {}, "folder:field notes"), {
    text: 'did you mean folder:"Field notes"?',
    fixedQuery: 'folder:"Field notes"',
  });
});

/* SUB-639: a number-kind column filters by numeric value — exact match on
   `price:1200` and real comparison on `price > 500`. */
const PRICE_SCHEMA: Record<string, PropSchema> = {
  price: { options: [], kind: "number" },
  status: { options: [] },
};

test("matchesFilters: price:1200 matches by value, not by prefix (SUB-639)", () => {
  const f = parseQuery("price:1200 ", TODAY, PRICE_SCHEMA).filters;
  const hits = (v: string) => matchesFilters(note("n", { price: v }), f, TODAY, PRICE_SCHEMA);
  assert.equal(hits("1200"), true);
  assert.equal(hits("1200.0"), true, "same value, different spelling");
  assert.equal(hits("1200.00"), true);
  assert.equal(hits("12000"), false, "prefix hits are gone");
  assert.equal(hits("120"), false);
});

test("matchesFilters: price:12 no longer sweeps in 1200 and 120.5 (SUB-639)", () => {
  const f = parseQuery("price:12 ", TODAY, PRICE_SCHEMA).filters;
  const hits = (v: string) => matchesFilters(note("n", { price: v }), f, TODAY, PRICE_SCHEMA);
  assert.equal(hits("12"), true);
  assert.equal(hits("12.0"), true);
  assert.equal(hits("1200"), false);
  assert.equal(hits("120.5"), false);
});

test("matchesFilters: a text column keeps exact-or-prefix matching", () => {
  const f = parseQuery("status:re ", TODAY, PRICE_SCHEMA).filters;
  const hits = (v: string) => matchesFilters(note("n", { status: v }), f, TODAY, PRICE_SCHEMA);
  assert.equal(hits("released"), true, "prefix matching untouched off the number kind");
  assert.equal(hits("live"), false);
});

test("matchesFilters: a schema-less caller keeps text semantics on numbers", () => {
  const f = parseQuery("price:12 ").filters;
  assert.equal(matchesFilters(note("n", { price: "1200" }), f), true, "prefix, as before");
});

test("parseQuery: price > 500 parses as a comparison on a number column (SUB-639)", () => {
  const parsed = parseQuery("price > 500 ", TODAY, PRICE_SCHEMA);
  assert.deepEqual(parsed.filters, [{ key: "price", values: ["500"], op: ">" }]);
  assert.equal(parsed.text.trim(), "", "the operand is consumed, not left as a title word");
});

test("parseQuery: a bare number stays text without a number schema", () => {
  const parsed = parseQuery("price > 500 ", TODAY);
  assert.deepEqual(parsed.filters, [], "no number kind, no numeric comparison");
});

test("matchesFilters: price > 500 compares numerically (SUB-639)", () => {
  const f = parseQuery("price > 500 ", TODAY, PRICE_SCHEMA).filters;
  const hits = (v: string) => matchesFilters(note("n", { price: v }), f, TODAY, PRICE_SCHEMA);
  assert.equal(hits("1200"), true);
  assert.equal(hits("500.01"), true);
  assert.equal(hits("500"), false, "> is strict");
  assert.equal(hits("120.5"), false, "no lexicographic surprise: '120.5' > '500' as text");
  assert.equal(hits("tbd"), false, "a non-numeric cell satisfies no comparison");
});

test("matchesFilters: <=, >= and negation on a number column (SUB-639)", () => {
  const run = (q: string, v: string) =>
    matchesFilters(note("n", { price: v }), parseQuery(`${q} `, TODAY, PRICE_SCHEMA).filters, TODAY, PRICE_SCHEMA);
  assert.equal(run("price <= 500", "500"), true);
  assert.equal(run("price <= 500", "500.5"), false);
  assert.equal(run("price >= 500", "500"), true);
  assert.equal(run("price < 500", "-20"), true, "signed values compare by value");
  assert.equal(run("-price > 500", "1200"), false, "negation inverts the comparison");
  assert.equal(run("-price > 500", "120"), true);
});

test("resolveCompare: number keys take bare numbers, other keys keep the date grammar", () => {
  assert.deepEqual(resolveCompare("price", "500", TODAY, PRICE_SCHEMA), { num: 500 });
  assert.deepEqual(resolveCompare("price", "2026-07-17", TODAY, PRICE_SCHEMA), {
    day: "2026-07-17",
  });
  assert.equal(resolveCompare("price", "soon", TODAY, PRICE_SCHEMA), null);
  assert.equal(resolveCompare("due", "500", TODAY, PRICE_SCHEMA), null, "not a number column");
  assert.deepEqual(resolveCompare("due", "7d", TODAY, PRICE_SCHEMA), { day: "2026-07-24" });
});

test("remapSavedQueryProperty mirrors committed filter semantics byte-for-byte", () => {
  const query =
    'Price:500 -PRICE >= 2 price plain "price:500" https://x.test/price:500 C:\\price:500 score > 500 due < 7d';
  assert.equal(
    remapSavedQueryProperty(query, "price", "cost", true),
    'cost:500 -cost >= 2 price plain "price:500" https://x.test/price:500 C:\\price:500 score > 500 due < 7d'
  );
  assert.equal(
    remapSavedQueryProperty("score > 500 drift", "score", null, false),
    "score > 500 drift",
    "numeric-looking text comparisons remain ordinary words"
  );
  assert.equal(remapSavedQueryProperty("price > 500 drift", "price", null, true), null);
  assert.equal(remapSavedQueryProperty("due < 7d drift", "due", null, false), null);
});

test("remapSavedQueryProperty follows JS tokenization and Unicode lowercasing", () => {
  assert.equal(
    remapSavedQueryProperty('"slow price:500 drift', "price", "cost", false),
    '"slow cost:500 drift'
  );
  assert.equal(remapSavedQueryProperty("ǆς:yes drift", "ǅΣ", "titlecase", false), "titlecase:yes drift");
  assert.equal(remapSavedQueryProperty("aςʰ:yes drift", "AΣʰ", "ignorable", false), "ignorable:yes drift");
});
