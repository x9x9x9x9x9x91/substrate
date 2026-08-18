import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorLine,
  embedSize,
  embedSizeStyle,
  embedTarget,
  parseWikiLink,
  wikiLinkDisplay,
  wikiLinkInsert,
  aliasSuggestions,
  anchorOptions,
  anchorTargets,
  embedModifierOptions,
  wikiLinkContext,
  wikiLinkOptions,
} from "./wikilinks.ts";

test("wikiLinkContext: only inside an open [[", () => {
  assert.deepEqual(wikiLinkContext("[["), {
    slot: "target",
    target: "",
    anchor: null,
    query: "",
    embed: false,
  });
  assert.equal(wikiLinkContext("see [[Al")?.query, "Al");
  assert.equal(wikiLinkContext("a [[x]] then [[B")?.query, "B");
  // a single bracket, a closed link, and a newline all end the link context
  assert.equal(wikiLinkContext("see [Al"), null);
  assert.equal(wikiLinkContext("see [[Al]]"), null);
  assert.equal(wikiLinkContext("see [[Al\nmore"), null);
});

test("wikiLinkContext: the anchor slot carries the target it belongs to", () => {
  assert.deepEqual(wikiLinkContext("[[Piranesi#Not"), {
    slot: "anchor",
    target: "Piranesi",
    anchor: "Not",
    query: "Not",
    embed: false,
  });
  // an empty target is the note the link sits in
  assert.deepEqual(wikiLinkContext("[[#"), {
    slot: "anchor",
    target: "",
    anchor: "",
    query: "",
    embed: false,
  });
  // the query is the raw span the popup replaces — never trimmed
  assert.equal(wikiLinkContext("[[A# my hea")?.query, " my hea");
});

test("wikiLinkContext: the alias slot is everything past the first pipe", () => {
  const alias = wikiLinkContext("[[Piranesi#Notes|the bo");
  assert.deepEqual(alias, {
    slot: "alias",
    target: "Piranesi",
    anchor: "Notes",
    query: "the bo",
    embed: false,
  });
  // a later pipe is prose, exactly as parseWikiLink reads it
  assert.equal(wikiLinkContext("[[A|one | two")?.query, "one | two");
});

test("wikiLinkContext: an embed spends its pipe on a modifier, not an alias", () => {
  assert.deepEqual(wikiLinkContext("![[cover.png|30"), {
    slot: "modifier",
    target: "cover.png",
    anchor: null,
    query: "30",
    embed: true,
  });
  // a `#` in a filename is part of the name — an embed has no anchors
  assert.deepEqual(wikiLinkContext("![[take#2.wav"), {
    slot: "target",
    target: "take#2.wav",
    anchor: null,
    query: "take#2.wav",
    embed: true,
  });
  // a multi-part modifier completes its LAST segment
  assert.equal(wikiLinkContext("![[a.png|300|le")?.query, "le");
});

test("anchorTargets: headings and block refs in document order, fences skipped", () => {
  const note = [
    "intro",
    "# Top",
    "## Nested ##",
    "```",
    "# not a heading",
    "```",
    "a paragraph ^ref-1",
    "###   ",
  ].join("\n");
  assert.deepEqual(
    anchorTargets(note).map((t) => [t.anchor, t.kind, t.level ?? null, t.line]),
    [
      ["Top", "heading", 1, 2],
      ["Nested", "heading", 2, 3],
      ["^ref-1", "block", null, 7],
    ]
  );
});

test("anchorLine agrees with what anchorTargets offers", () => {
  const note = ["# One", "body ^b1", "```", "# Two", "```"].join("\n");
  for (const target of anchorTargets(note)) {
    assert.equal(anchorLine(note, target.anchor), target.line);
  }
  // the fenced heading is offered by neither and resolves in neither
  assert.equal(anchorLine(note, "Two"), null);
});

test("anchorOptions: fuzzy filter, document order as the tiebreak", () => {
  const targets = anchorTargets(["# Zeta", "# Alpha", "# Alpaca"].join("\n"));
  assert.deepEqual(
    anchorOptions("", targets).map((t) => t.anchor),
    ["Zeta", "Alpha", "Alpaca"]
  );
  // shorter target wins on score; both beat the non-match
  assert.deepEqual(
    anchorOptions("alp", targets).map((t) => t.anchor),
    ["Alpha", "Alpaca"]
  );
  assert.deepEqual(anchorOptions("zzz", targets), []);
  // a repeated heading resolves to the first either way — offer it once
  const dupes = anchorTargets(["# Notes", "## notes"].join("\n"));
  assert.deepEqual(
    anchorOptions("", dupes).map((t) => t.line),
    [1]
  );
});

test("anchorOptions: never offers an anchor the link grammar can't spell", () => {
  const targets = anchorTargets(
    ["# Sales | 2026", "# See [[Other]]", "## Done]", "# Clean heading", "text ^ok|1"].join("\n")
  );
  // the popup drops every heading carrying `|`, `[` or `]` — `[[Note#Sales |
  // 2026]]` would parse as anchor `Sales` plus alias `2026` and scroll
  // nowhere, and a `]` breaks the link outright
  assert.deepEqual(
    anchorOptions("", targets).map((t) => t.anchor),
    ["Clean heading"]
  );
  // the block ref with a pipe is out of the popup for the same reason
  assert.deepEqual(anchorOptions("ok", targets), []);
  // …but a hand-written one still RESOLVES: filtering is a popup rule, not a
  // reinterpretation of what a vault may contain
  const note = ["# Sales | 2026"].join("\n");
  assert.equal(anchorLine(note, "Sales | 2026"), 1);
});

test("wikiLinkInsert: an already-closed link past an alias is not closed twice", () => {
  // the anchor slot of `[[Welcome|Alias]]`: the closer sits past the alias
  assert.equal(wikiLinkInsert("The basics", "|Alias]] rest"), "The basics");
  // a `|` with no closer of its own is a table cell wall, not this link
  assert.equal(wikiLinkInsert("Alpha Notes", " | next |"), "Alpha Notes]]");
  // the next link's `[[` and a line end both mean this one is still open
  assert.equal(wikiLinkInsert("Alpha Notes", " and [[Beta]]"), "Alpha Notes]]");
  assert.equal(wikiLinkInsert("Alpha Notes", "\n[[Beta]]"), "Alpha Notes]]");
});

test("embedModifierOptions: the documented hints, float ones marked declined", () => {
  assert.deepEqual(
    embedModifierOptions("").map((m) => m.name),
    ["300", "300x200", "left", "right"]
  );
  assert.deepEqual(
    embedModifierOptions("3").map((m) => m.name),
    ["300", "300x200"]
  );
  assert.match(embedModifierOptions("left")[0].detail, /not honoured/);
});

test("aliasSuggestions: the labels the link already implies, deduped", () => {
  assert.deepEqual(aliasSuggestions("", "Piranesi", "Notes"), [
    "Piranesi",
    "Notes",
    "Piranesi#Notes",
  ]);
  assert.deepEqual(aliasSuggestions("", "Piranesi", null), ["Piranesi"]);
  assert.deepEqual(aliasSuggestions("not", "Piranesi", "Notes"), ["Notes", "Piranesi#Notes"]);
  // a same-note anchor names no target — nothing to suggest but the anchor
  assert.deepEqual(aliasSuggestions("", "", "Notes"), ["Notes"]);
});

test("wikiLinkOptions: fuzzy ranking, misses and dupes dropped", () => {
  const titles = ["Alpha Notes", "Beta", "alphabet", "Zeta", "Beta"];
  const ranked = wikiLinkOptions("alp", titles).map((o) => o.title);
  // both prefix hits rank by length (shorter wins); Beta/Zeta don't match
  assert.deepEqual(ranked, ["alphabet", "Alpha Notes"]);
  assert.deepEqual(wikiLinkOptions("zzz", titles), []);
});

test("wikiLinkOptions: empty query lists every title A→Z, deduped", () => {
  const ranked = wikiLinkOptions("", ["Beta", "alpha", "Beta", "  "]).map((o) => o.title);
  assert.deepEqual(ranked, ["alpha", "Beta"]);
});

test("wikiLinkOptions: case-insensitive matching", () => {
  assert.deepEqual(wikiLinkOptions("ALP", ["alphabet"]).map((o) => o.title), ["alphabet"]);
});

test("wikiLinkInsert: closes the link unless ]] already follows", () => {
  assert.equal(wikiLinkInsert("Alpha Notes", ""), "Alpha Notes]]");
  assert.equal(wikiLinkInsert("Alpha Notes", " rest"), "Alpha Notes]]");
  assert.equal(wikiLinkInsert("Alpha Notes", "]] rest"), "Alpha Notes");
});

// twin of the Rust `wikilink_splits_into_target_anchor_alias`
// test (src-tauri/src/vault/mod.rs); keep the cases in step.
test("parseWikiLink: target, anchor and alias", () => {
  assert.deepEqual(parseWikiLink("Piranesi"), {
    target: "Piranesi",
    anchor: null,
    alias: null,
  });
  assert.deepEqual(parseWikiLink("Piranesi|the book"), {
    target: "Piranesi",
    anchor: null,
    alias: "the book",
  });
  assert.deepEqual(parseWikiLink("Piranesi#Notes"), {
    target: "Piranesi",
    anchor: "Notes",
    alias: null,
  });
  assert.deepEqual(parseWikiLink("Piranesi#Notes|the book"), {
    target: "Piranesi",
    anchor: "Notes",
    alias: "the book",
  });
  // whitespace around every piece, and a same-note anchor
  assert.deepEqual(parseWikiLink("  Piranesi # Notes | the book "), {
    target: "Piranesi",
    anchor: "Notes",
    alias: "the book",
  });
  assert.deepEqual(parseWikiLink("#Notes"), { target: "", anchor: "Notes", alias: null });
  // block ref; a `#` in the display text stays display text; first pipe wins
  assert.deepEqual(parseWikiLink("Piranesi#^a1b2"), {
    target: "Piranesi",
    anchor: "^a1b2",
    alias: null,
  });
  assert.deepEqual(parseWikiLink("Piranesi|see #Notes"), {
    target: "Piranesi",
    anchor: null,
    alias: "see #Notes",
  });
  assert.deepEqual(parseWikiLink("Piranesi|a|b"), {
    target: "Piranesi",
    anchor: null,
    alias: "a|b",
  });
});

test("wikiLinkDisplay: alias wins, else target#anchor", () => {
  assert.equal(wikiLinkDisplay("Piranesi"), "Piranesi");
  assert.equal(wikiLinkDisplay("Piranesi|the book"), "the book");
  assert.equal(wikiLinkDisplay("Piranesi#Notes"), "Piranesi#Notes");
  assert.equal(wikiLinkDisplay("Piranesi#Notes|the book"), "the book");
  assert.equal(wikiLinkDisplay("#Notes"), "#Notes");
});

test("anchorLine: heading match is literal and case-insensitive", () => {
  const text = ["intro", "## Notes", "body", "### Deeper Notes ###", "end"].join("\n");
  assert.equal(anchorLine(text, "Notes"), 2);
  assert.equal(anchorLine(text, "notes"), 2);
  // closing #'s are punctuation, not part of the heading text
  assert.equal(anchorLine(text, "Deeper Notes"), 4);
  // a partial name is not a match — a missing heading scrolls nowhere
  assert.equal(anchorLine(text, "Note"), null);
  assert.equal(anchorLine(text, ""), null);
});

test("anchorLine: a heading inside a fence is code, not a heading", () => {
  const text = ["```sh", "# Notes", "```", "## Notes"].join("\n");
  assert.equal(anchorLine(text, "Notes"), 4);
});

test("anchorLine: ^id finds the block that carries the ref", () => {
  const text = ["first", "the claim ^a1b2", "later"].join("\n");
  assert.equal(anchorLine(text, "^a1b2"), 2);
  assert.equal(anchorLine(text, "^nope"), null);
});

test("embedTarget: the display modifier is dropped, a # never is", () => {
  // Twin of embed_target in src-tauri/src/vault/mod.rs
  assert.equal(embedTarget("cover.png"), "cover.png");
  assert.equal(embedTarget("cover.png|300"), "cover.png");
  assert.equal(embedTarget("cover.png|300x200"), "cover.png");
  assert.equal(embedTarget("  cover.png | left "), "cover.png");
  // only the FIRST pipe splits
  assert.equal(embedTarget("cover.png|300|left"), "cover.png");
  // a `#` belongs to the filename — an embed has no anchor
  assert.equal(embedTarget("track #3.wav"), "track #3.wav");
  assert.equal(embedTarget("track #3.wav|200"), "track #3.wav");
  // link-in-place paths survive whole
  assert.equal(embedTarget("~/Music/mixdown.flac|300"), "~/Music/mixdown.flac");
  assert.equal(embedTarget("|300"), "");
});

test("embedSize: a bare number is a width, WxH is a box, everything else is ignored", () => {
  // twin of embed_size in src-tauri/src/vault/mod.rs; keep the
  // two tables identical, a divergence means the app and the engine disagree
  // about how big a note's images are.
  assert.deepEqual(embedSize("cover.png"), null);
  assert.deepEqual(embedSize("cover.png|300"), { width: 300, height: null });
  assert.deepEqual(embedSize("cover.png|300x200"), { width: 300, height: 200 });
  assert.deepEqual(embedSize("cover.png|300X200"), { width: 300, height: 200 });
  assert.deepEqual(embedSize("cover.png | 300 "), { width: 300, height: null });
  // floats are recognised syntax Substrate declines to act on
  assert.deepEqual(embedSize("cover.png|left"), null);
  assert.deepEqual(embedSize("cover.png|right"), null);
  // a float beside a width does not cost the width
  assert.deepEqual(embedSize("cover.png|300|left"), { width: 300, height: null });
  assert.deepEqual(embedSize("cover.png|left|300x200"), { width: 300, height: 200 });
  // garbage is ignored, never an error
  assert.deepEqual(embedSize("cover.png|axb"), null);
  assert.deepEqual(embedSize("cover.png|300x"), null);
  assert.deepEqual(embedSize("cover.png|x200"), null);
  assert.deepEqual(embedSize("cover.png|3.5"), null);
  assert.deepEqual(embedSize("cover.png|-3"), null);
  assert.deepEqual(embedSize("cover.png|0"), null);
  assert.deepEqual(embedSize("cover.png|0x0"), null);
  assert.deepEqual(embedSize("cover.png|"), null);
  assert.deepEqual(embedSize("cover.png|300x0"), null);
  // an absurd number degrades to a big image, never a broken one
  assert.deepEqual(embedSize("cover.png|99999"), { width: 4096, height: null });
  assert.deepEqual(embedSize("cover.png|99999x99999"), { width: 4096, height: 4096 });
});

test("embedSizeStyle: caps only, so images scale and keep their ratio", () => {
  assert.deepEqual(embedSizeStyle(null), {});
  assert.deepEqual(embedSizeStyle({ width: 300, height: null }), { maxWidth: "300px" });
  assert.deepEqual(embedSizeStyle({ width: 300, height: 200 }), {
    maxWidth: "300px",
    maxHeight: "200px",
  });
});
