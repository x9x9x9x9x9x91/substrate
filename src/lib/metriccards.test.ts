import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CARD_DIGITS,
  clampCardDigits,
  collectCardsFences,
  fmtCard,
  parseCardDigits,
  parseCards,
  parseCardsBlock,
  parseCardsConfig,
  type MetricCard,
} from "./metriccards.ts";
import { evaluateSheet, findSummary, formatValue, parseSheet } from "./sheet.ts";
import type { Value } from "./formula.ts";

const one = (inner: string): MetricCard => {
  const cards = parseCardsConfig(inner);
  assert.equal(cards.length, 1);
  return cards[0];
};

const rejects = (inner: string, re: RegExp) =>
  assert.throws(() => parseCardsConfig(inner), re);

test("parses a minimal card", () => {
  assert.deepEqual(one("- label: Total\n  bind: {{Holdings.total}}"), {
    label: "Total",
    bind: "{{Holdings.total}}",
  });
});

test("parses every key on one card", () => {
  assert.deepEqual(
    one('- label: "Net worth"\n  bind: "{{Holdings.total}}"\n  format: eur\n  digits: 2\n  emph: true'),
    { label: "Net worth", bind: "{{Holdings.total}}", format: "eur", digits: 2, emph: true },
  );
});

test("parses several cards, in document order", () => {
  const cards = parseCardsConfig(
    ["- label: A", "  bind: S.a", "- label: B", "  bind: S.b", "- label: C", "  bind: S.c"].join("\n"),
  );
  assert.deepEqual(
    cards.map((c) => c.label),
    ["A", "B", "C"],
  );
});

test("blank lines and # comments are skipped", () => {
  const cards = parseCardsConfig("# the money row\n\n- label: A\n\n  bind: S.a\n\n");
  assert.deepEqual(cards, [{ label: "A", bind: "S.a" }]);
});

test("single quotes strip, inner quotes survive", () => {
  assert.equal(one("- label: 'Ist \"echt\"'\n  bind: S.a").label, 'Ist "echt"');
});

test("keys are case-insensitive, format folds to lower", () => {
  assert.deepEqual(one("- Label: A\n  BIND: S.a\n  Format: EUR"), {
    label: "A",
    bind: "S.a",
    format: "eur",
  });
});

test("CRLF bodies parse", () => {
  assert.deepEqual(parseCardsConfig("- label: A\r\n  bind: S.a\r\n"), [{ label: "A", bind: "S.a" }]);
});

test("emph false is kept as false", () => {
  assert.equal(one("- label: A\n  bind: S.a\n  emph: false").emph, false);
});

test("names an unknown key", () => {
  rejects("- label: A\n  bind: S.a\n  colour: red", /unknown key "colour"/);
});

test("names a duplicate key", () => {
  rejects("- label: A\n  bind: S.a\n  bind: S.b", /duplicate key "bind"/);
});

test("names an empty value", () => {
  rejects("- label:\n  bind: S.a", /"label" needs a value/);
});

test("names an unknown format", () => {
  rejects("- label: A\n  bind: S.a\n  format: euro", /unknown format "euro" — want eur, usd, number, pct/);
});

test("names a non-integer digits", () => {
  rejects("- label: A\n  bind: S.a\n  digits: two", /digits must be a whole number — got "two"/);
  rejects("- label: A\n  bind: S.a\n  digits: 1.5", /digits must be a whole number/);
});

// ToLocaleString throws a hard RangeError past 20 fraction digits,
// so no card may reach the formatter carrying more than the shared bound.
// the fence is hand-authored text, so it NAMES the bound the way the
// grid tile card line does rather than silently clamping — same words, same
// shared reader (parseCardDigits).
test("names out-of-range fence digits with the shared bound", () => {
  rejects("- label: A\n  bind: S.a\n  digits: 9", /card digits must be between 0 and 8/);
  rejects("- label: A\n  bind: S.a\n  digits: 30", /card digits must be between 0 and 8/);
  rejects("- label: A\n  bind: S.a\n  digits: 99999999999999999999999", /card digits must be between 0 and 8/);
  // in-range values are untouched
  assert.equal(one("- label: A\n  bind: S.a\n  digits: 0").digits, 0);
  assert.equal(one("- label: A\n  bind: S.a\n  digits: 2").digits, 2);
  assert.equal(one("- label: A\n  bind: S.a\n  digits: 8").digits, 8);
});

test("parseCardDigits: the strict read both authoring surfaces share", () => {
  assert.equal(parseCardDigits("0"), 0);
  assert.equal(parseCardDigits("8"), 8);
  assert.throws(() => parseCardDigits("9"), /card digits must be between 0 and 8/);
  assert.throws(() => parseCardDigits("1.5"), /digits must be a whole number — got "1.5"/);
  assert.throws(() => parseCardDigits("-2"), /digits must be a whole number — got "-2"/);
  assert.throws(() => parseCardDigits("two"), /digits must be a whole number — got "two"/);
});

test("clampCardDigits keeps whole 0..8 and drops anything that isn't a number", () => {
  assert.equal(clampCardDigits(30), MAX_CARD_DIGITS);
  assert.equal(clampCardDigits(-2), 0);
  assert.equal(clampCardDigits(2.7), 2);
  assert.equal(clampCardDigits(-0.5), 0);
  assert.equal(clampCardDigits(3), 3);
  assert.equal(clampCardDigits(Infinity), undefined);
  assert.equal(clampCardDigits(NaN), undefined);
  assert.equal(clampCardDigits(undefined), undefined);
  assert.equal(clampCardDigits("2"), undefined);
});

// The lenient half of the split: frontmatter is machine-written as
// often as hand-written, so it clamps where the authoring surfaces refuse —
// the same posture that drops an incomplete card instead of failing the board.
test("frontmatter cards clamp digits where the fence refuses them", () => {
  const digitsOf = (digits: unknown) => parseCards({ cards: [{ label: "A", bind: "S.a", digits }] })[0].digits;
  assert.equal(digitsOf(30), MAX_CARD_DIGITS);
  assert.equal(digitsOf(-2), 0);
  assert.equal(digitsOf(2.5), 2);
  assert.equal(digitsOf(2), 2);
  assert.equal(digitsOf(NaN), undefined);
  assert.equal(digitsOf("2"), undefined);
});

test("fmtCard formats an out-of-range digits card instead of throwing", () => {
  // 999 is past every engine's fraction-digit cap (100 on current V8/JSC, 20
  // before Intl.NumberFormat v3), so this is the RangeError guard proper.
  for (const format of ["eur", "usd", "number", "pct"]) {
    assert.doesNotThrow(() => fmtCard(1234.5, format, 999));
    assert.doesNotThrow(() => fmtCard(1234.5, format, 30));
    assert.doesNotThrow(() => fmtCard(1234.5, format, -3));
  }
  assert.equal(fmtCard(1234.5, "eur", 30), fmtCard(1234.5, "eur", MAX_CARD_DIGITS));
  assert.equal(fmtCard(1234.5, "eur", 999), fmtCard(1234.5, "eur", MAX_CARD_DIGITS));
  assert.equal(fmtCard(1234.5, "eur", 2), "1.234,50 €");
  assert.equal(fmtCard(1234.5, "pct", 1), "1.234,5%");
});

test("names a non-boolean emph", () => {
  rejects("- label: A\n  bind: S.a\n  emph: yes", /emph must be true or false — got "yes"/);
});

test("names a card with no label", () => {
  rejects("- bind: S.a", /a card needs a label/);
});

test("names a card with no bind", () => {
  rejects("- label: Total", /card "Total" needs a bind/);
});

test("names an empty fence", () => {
  rejects("", /no cards/);
  rejects("# nothing but a comment", /no cards/);
});

test("names a continuation line before any card", () => {
  rejects("label: A\n  bind: S.a", /cards is a list/);
});

test("names an unparseable line", () => {
  rejects("- label: A\n  this is not a key", /can't parse line: this is not a key/);
});

test("parseCardsBlock never throws — error in place", () => {
  assert.deepEqual(parseCardsBlock("- label: A\n  bind: S.a"), {
    cards: [{ label: "A", bind: "S.a" }],
    error: null,
  });
  const bad = parseCardsBlock("- nope: 1");
  assert.deepEqual(bad.cards, []);
  assert.match(bad.error ?? "", /unknown key "nope"/);
});

test("collectCardsFences takes every cards fence, in order, and nothing else", () => {
  const body = [
    "# Home",
    "",
    "```cards",
    "- label: A",
    "  bind: S.a",
    "```",
    "",
    "```chart",
    "type: bar",
    "```",
    "",
    "prose",
    "",
    "```cards",
    "- label: B",
    "  bind: S.b",
    "```",
    "",
    "```",
    "- label: NotACardsFence",
    "```",
  ].join("\n");
  assert.deepEqual(collectCardsFences(body), [
    "- label: A\n  bind: S.a",
    "- label: B\n  bind: S.b",
  ]);
});

test("collectCardsFences reads a spaced info string and an unterminated fence", () => {
  assert.deepEqual(collectCardsFences("```cards title=money\n- label: A\n  bind: S.a\n```"), [
    "- label: A\n  bind: S.a",
  ]);
  assert.deepEqual(collectCardsFences("```cards\n- label: A\n  bind: S.a"), [
    "- label: A\n  bind: S.a",
  ]);
});

test("collectCardsFences ignores cards text inside another fence", () => {
  const body = ["```text", "```cards", "- label: A", "```"].join("\n");
  assert.deepEqual(collectCardsFences(body), []);
});

// ---------- the two surfaces one summary renders through ----------

/** A named summary reaches a reader twice: as a chip under its own sheet
    (`formatValue`, which reads the value) and as a card on a dashboard
    (`fmtCard`, which reads what the card author declared). The value-aware
    Count quick-pick, chips inheriting their column's format, and this
    change each rewrite what a value-carrying number means on
    one of those surfaces, and each is tested only on its own. These two tests
    pin where the surfaces agree and where they deliberately part. */

const SHEET = `\`\`\`csv
asset,units,value_usd
BTC,4.1,37680
HEDGE,80,-30280
LONG,1200,10600
\`\`\`

\`\`\`formulas
total = SUM(value_usd)
rows = COUNT(value_usd)
avg_units = AVG(units)
share = MAX(units) / SUM(units)
\`\`\`
`;

const summary = (name: string): Value => {
  const v = findSummary(evaluateSheet(parseSheet(SHEET), () => null), name);
  assert.ok(!(v && typeof v === "object" && "err" in v), `summary ${name} errored`);
  return v as Value;
};

test("a count renders dimensionless on both surfaces until a card says otherwise", () => {
  const rows = summary("rows");
  assert.equal(rows, 3);
  // the chip: a count is a plain row tally, never money
  assert.equal(formatValue(rows), "3");
  // the card, undeclared: same reading, so a Count quick-pick (which
  // spells a text column's count `COUNTIF(col, "*")`) is safe to bind to a card
  assert.equal(fmtCard(rows), "3");
  assert.equal(fmtCard(rows, "number"), "3");
  // ...and a card that *declares* a currency wins: `format: eur, digits: 2` is
  // the author saying this number is money, which the sheet can't overrule
  assert.equal(fmtCard(rows, "eur", 2), "3,00 €");

  // a quantity, by contrast, reads the same on both surfaces
  assert.equal(formatValue(summary("total")), "18.000");
  assert.equal(fmtCard(summary("total")), "18.000");
});

test("no sheet-derived decimal count can exceed the card bound", () => {
  // the card side is bounded because toLocaleString throws past the engine's
  // digit cap; the sheet side is bounded by formatNum's own rules.
  // This asserts the two agree, so a summary can never carry a decimal count
  // into fmtCard that clampCardDigits would have to rescue.
  for (const name of ["total", "rows", "avg_units", "share"]) {
    const v = summary(name);
    const decimals = (formatValue(v).split(",")[1] ?? "").length;
    assert.ok(
      decimals <= MAX_CARD_DIGITS,
      `${name} renders ${decimals} decimals, past the card bound of ${MAX_CARD_DIGITS}`
    );
    assert.equal(clampCardDigits(decimals), decimals);
    // and the same count is a legal card declaration — no throw, no clamp
    assert.equal(parseCardDigits(String(decimals)), decimals);
    assert.doesNotThrow(() => fmtCard(v, "number", decimals));
  }
});

test("a card takes an accent off the option roster", () => {
  assert.equal(one("- label: A\n  bind: S.a\n  accent: teal").accent, "teal");
  assert.equal(one("- label: A\n  bind: S.a\n  accent: Violet").accent, "violet");
  assert.equal(parseCards({ cards: [{ label: "A", bind: "S.a", accent: "green" }] })[0].accent, "green");
});

test("an off-roster accent is absent, never an error", () => {
  // deliberately unlike a bad bind or format, which throw: a style token the
  // theme can't honour is a preference, not a lie about the data
  for (const v of ["#14b8a6", "2px", "tealish", "red; content: 'x'"]) {
    assert.equal(one(`- label: A\n  bind: S.a\n  accent: ${v}`).accent, undefined);
  }
  assert.equal(parseCards({ cards: [{ label: "A", bind: "S.a", accent: 7 }] })[0].accent, undefined);
});

test("names a duplicate accent even when neither value is on the roster", () => {
  rejects("- label: A\n  bind: S.a\n  accent: nope\n  accent: teal", /duplicate key "accent"/);
});
