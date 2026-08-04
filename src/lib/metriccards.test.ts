import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectCardsFences,
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
