import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CARD_DIGITS,
  clampCardDigits,
  collectCardsFences,
  fmtCard,
  parseCards,
  parseCardsBlock,
  parseCardsConfig,
  type MetricCard,
} from "./metriccards.ts";

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

// SUB-1030: toLocaleString throws a hard RangeError past 20 fraction digits,
// so no card may reach the formatter carrying more than the shared bound.
test("clamps fence digits into the shared bound instead of throwing", () => {
  assert.equal(one("- label: A\n  bind: S.a\n  digits: 30").digits, MAX_CARD_DIGITS);
  assert.equal(one("- label: A\n  bind: S.a\n  digits: 99999999999999999999999").digits, MAX_CARD_DIGITS);
  // in-range values are untouched
  assert.equal(one("- label: A\n  bind: S.a\n  digits: 0").digits, 0);
  assert.equal(one("- label: A\n  bind: S.a\n  digits: 2").digits, 2);
  assert.equal(one("- label: A\n  bind: S.a\n  digits: 8").digits, 8);
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

test("frontmatter cards clamp digits the same way the fence does", () => {
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
