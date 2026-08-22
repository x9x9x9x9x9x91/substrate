import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paceText,
  parseProgressBlocks,
  parseProgressConfig,
  progressCount,
  progressFraction,
  progressLabel,
  progressPace,
  progressPercent,
  progressSheets,
  type ProgressConfig,
} from "./progress.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

const rejects = (inner: string, re: RegExp) =>
  assert.throws(() => parseProgressConfig(inner), re);

// ---------- parsing ----------

test("parses a minimal bound fence", () => {
  assert.deepEqual(parseProgressConfig("label: Savings\nvalue: {{Holdings.cash}}\ntarget: 50000"), {
    label: "Savings",
    value: { kind: "bind", bind: "{{Holdings.cash}}" },
    target: { kind: "number", n: 50000 },
    deadline: null,
    start: null,
  });
});

test("label is optional and derives from the value", () => {
  const bound = parseProgressConfig("value: {{Holdings.cash_total}}\ntarget: 50000");
  assert.equal(bound.label, null);
  assert.equal(progressLabel(bound), "Cash total");
  const count = parseProgressConfig("value: count\nsource: signup\ntarget: 10");
  assert.equal(progressLabel(count), "signup count");
});

test("parses a count fence with every key", () => {
  assert.deepEqual(
    parseProgressConfig(
      [
        "label: Signups",
        "value: count",
        "source: signup",
        "query: status:confirmed",
        "target: 10",
        "deadline: 2026-08-30",
        "start: 2026-08-02",
        "format: number",
        "digits: 1",
      ].join("\n")
    ),
    {
      label: "Signups",
      value: { kind: "count", source: { kind: "db", type: "signup" }, query: "status:confirmed" },
      target: { kind: "number", n: 10 },
      deadline: "2026-08-30",
      start: "2026-08-02",
      format: "number",
      digits: 1,
    }
  );
});

test("a bound target parses, keys fold, quotes strip, CRLF and # comments survive", () => {
  const c = parseProgressConfig(
    '# the gate\r\nLABEL: "Tracks done"\r\nValue: "{{Album.finished}}"\r\nTarget: {{Album.goal}}\r\n'
  );
  assert.deepEqual(c, {
    label: "Tracks done",
    value: { kind: "bind", bind: "{{Album.finished}}" },
    target: { kind: "bind", bind: "{{Album.goal}}" },
    deadline: null,
    start: null,
  });
});

test("a bare Sheet.summary binds like the braced form", () => {
  const c = parseProgressConfig("label: A\nvalue: Holdings.cash\ntarget: 10");
  assert.deepEqual(c.value, { kind: "bind", bind: "Holdings.cash" });
});

test("count is case-insensitive", () => {
  const c = parseProgressConfig("label: A\nvalue: COUNT\nsource: release\ntarget: 3");
  assert.deepEqual(c.value, { kind: "count", source: { kind: "db", type: "release" }, query: null });
});

test("names a missing required key", () => {
  rejects("label: A\ntarget: 3", /missing required key "value"/);
  rejects("label: A\nvalue: {{S.a}}", /missing required key "target"/);
});

test("names an unknown key, a duplicate and an empty value", () => {
  rejects("label: A\nvalue: {{S.a}}\ntarget: 3\ncolour: red", /unknown key "colour"/);
  rejects("label: A\nvalue: {{S.a}}\ntarget: 3\ntarget: 4", /duplicate key "target"/);
  rejects("label:\nvalue: {{S.a}}\ntarget: 3", /can't parse line/);
});

test("names a malformed line", () => {
  rejects("label: A\nvalue: {{S.a}}\ntarget: 3\nnonsense", /can't parse line: nonsense/);
});

test("names a value that is neither count nor a bind", () => {
  rejects("label: A\nvalue: 42\ntarget: 3", /value must be count or \{\{Sheet.summary\}\}/);
});

test("count without a source is named", () => {
  rejects("label: A\nvalue: count\ntarget: 3", /value: count needs a source/);
});

test("a sheet source for count points at the bind form instead", () => {
  rejects(
    "label: A\nvalue: count\nsource: {{Holdings}}\ntarget: 3",
    /count reads a database — bind a sheet with value: \{\{Holdings.summary\}\}/
  );
});

test("source and query only apply to counts", () => {
  rejects("label: A\nvalue: {{S.a}}\nsource: release\ntarget: 3", /source only applies to value: count/);
  rejects("label: A\nvalue: {{S.a}}\nquery: x:1\ntarget: 3", /query only applies to value: count/);
});

test("a non-positive or non-numeric target is named", () => {
  rejects("label: A\nvalue: {{S.a}}\ntarget: 0", /target must be greater than zero/);
  rejects("label: A\nvalue: {{S.a}}\ntarget: -5", /target must be greater than zero/);
  rejects("label: A\nvalue: {{S.a}}\ntarget: soon", /target must be a positive number/);
});

test("a decimal target parses", () => {
  const c = parseProgressConfig("label: A\nvalue: {{S.a}}\ntarget: 12.5");
  assert.deepEqual(c.target, { kind: "number", n: 12.5 });
});

test("bad dates, an unknown format and non-integer digits are named", () => {
  rejects("label: A\nvalue: {{S.a}}\ntarget: 3\ndeadline: soon", /deadline must be a YYYY-MM-DD date/);
  rejects(
    "label: A\nvalue: {{S.a}}\ntarget: 3\ndeadline: 2026-08-30\nstart: 30.08.2026",
    /start must be a YYYY-MM-DD date/
  );
  rejects("label: A\nvalue: {{S.a}}\ntarget: 3\nformat: kg", /unknown format "kg"/);
  rejects("label: A\nvalue: {{S.a}}\ntarget: 3\ndigits: two", /digits must be a whole number/);
});

test("a start without a deadline, or after it, is named", () => {
  rejects(
    "label: A\nvalue: {{S.a}}\ntarget: 3\nstart: 2026-08-01",
    /start needs a deadline/
  );
  rejects(
    "label: A\nvalue: {{S.a}}\ntarget: 3\ndeadline: 2026-08-01\nstart: 2026-08-01",
    /start must fall before the deadline/
  );
});

test("a fence takes an accent off the option roster, folded like every key", () => {
  assert.equal(parseProgressConfig("value: {{S.a}}\ntarget: 3\naccent: teal").accent, "teal");
  assert.equal(parseProgressConfig("value: {{S.a}}\ntarget: 3\nAccent: Violet").accent, "violet");
  assert.equal(parseProgressConfig('value: {{S.a}}\ntarget: 3\naccent: " green "').accent, "green");
});

test("an off-roster accent is absent, never an error", () => {
  // a wrong preference is not a wrong number: the fence still renders
  for (const v of ["mauve", "#14b8a6", "2px", "tealish", "var(--opt-red)"]) {
    const c = parseProgressConfig(`value: {{S.a}}\ntarget: 3\naccent: ${v}`);
    assert.equal(c.accent, undefined, v);
    assert.deepEqual(c.target, { kind: "number", n: 3 });
  }
});

test("an absent accent leaves the key off the config entirely", () => {
  assert.equal("accent" in parseProgressConfig("value: {{S.a}}\ntarget: 3"), false);
  assert.equal("accent" in parseProgressConfig("value: {{S.a}}\ntarget: 3\naccent: mauve"), false);
});

test("names a duplicate accent even when neither value is on the roster", () => {
  rejects("value: {{S.a}}\ntarget: 3\naccent: nope\naccent: teal", /duplicate key "accent"/);
});

// ---------- blocks ----------

const FENCE = (inner: string) => "```progress\n" + inner + "\n```\n";

test("collects fences in document order and keeps a broken one in place", () => {
  const blocks = parseProgressBlocks(
    "intro\n\n" +
      FENCE("label: A\nvalue: {{S.a}}\ntarget: 10") +
      "\nmiddle\n\n" +
      FENCE("label: B\nvalue: nonsense\ntarget: 10") +
      "\n" +
      FENCE("label: C\nvalue: count\nsource: release\ntarget: 2")
  );
  assert.equal(blocks.length, 3);
  assert.deepEqual(
    blocks.map((b) => b.config?.label ?? null),
    ["A", null, "C"]
  );
  assert.match(blocks[1].error ?? "", /value must be count/);
  assert.equal(blocks[0].error, null);
  assert.equal(blocks[2].error, null);
});

test("no fences means no blocks", () => {
  assert.deepEqual(parseProgressBlocks("just prose\n\n```ts\nconst a = 1;\n```\n"), []);
});

test("progressSheets dedupes across value and target binds, case-insensitively", () => {
  const cfgs = [
    parseProgressConfig("label: A\nvalue: {{Holdings.cash}}\ntarget: {{holdings.goal}}"),
    parseProgressConfig("label: B\nvalue: {{Album.done}}\ntarget: 10"),
    parseProgressConfig("label: C\nvalue: count\nsource: release\ntarget: 4"),
  ];
  assert.deepEqual(progressSheets(cfgs), ["Holdings", "Album"]);
});

// ---------- counting ----------

const note = (type: string, props: Record<string, unknown> = {}): NoteMeta =>
  ({
    path: `${type}-${Math.random()}.md`,
    stem: "n",
    title: "n",
    folder: "",
    props: { type, ...props },
    updated_ms: 0,
    excerpt: "",
  }) as unknown as NoteMeta;

const schema: SchemaConfig = { signup: { status: { kind: "text", options: [] } } };

const countCfg = (inner: string): ProgressConfig => parseProgressConfig(inner);

test("counts every row of a database", () => {
  const notes = [note("signup"), note("signup"), note("release")];
  assert.deepEqual(
    progressCount(countCfg("label: A\nvalue: count\nsource: signup\ntarget: 10"), notes, schema),
    { count: 2 }
  );
});

test("a query narrows the count, and the count is the full match, not a page", () => {
  const notes = [
    ...Array.from({ length: 60 }, () => note("signup", { status: "confirmed" })),
    note("signup", { status: "pending" }),
  ];
  assert.deepEqual(
    progressCount(
      countCfg("label: A\nvalue: count\nsource: signup\nquery: status:confirmed\ntarget: 10"),
      notes,
      schema
    ),
    { count: 60 }
  );
});

test("an unknown database is an error, not a zero", () => {
  const r = progressCount(
    countCfg("label: A\nvalue: count\nsource: nosuchtype\ntarget: 10"),
    [note("signup")],
    schema
  );
  assert.deepEqual(r, { error: "Unknown database “nosuchtype”" });
});

test("a declared database with no rows counts zero", () => {
  assert.deepEqual(
    progressCount(countCfg("label: A\nvalue: count\nsource: signup\ntarget: 10"), [], schema),
    { count: 0 }
  );
});

// ---------- the bar ----------

test("the fill fraction clamps at both ends", () => {
  assert.equal(progressFraction(0, 10), 0);
  assert.equal(progressFraction(2.5, 10), 0.25);
  assert.equal(progressFraction(10, 10), 1);
  assert.equal(progressFraction(14, 10), 1);
  assert.equal(progressFraction(-3, 10), 0);
});

test("the percent text is unclamped so an overshoot says so", () => {
  assert.equal(progressPercent(12, 10), 120);
  assert.equal(progressPercent(1, 3), 33);
  assert.equal(progressPercent(0, 10), 0);
});

test("a target that can't divide reads as zero rather than NaN", () => {
  assert.equal(progressFraction(5, 0), 0);
  assert.equal(progressPercent(5, 0), 0);
  assert.equal(progressFraction(Number.NaN, 10), 0);
});

// ---------- pace ----------

test("without a start there is no ahead/behind — only days left and the rate required", () => {
  const p = progressPace(4, 10, "2026-08-13", null, "2026-08-03");
  assert.equal(p.daysLeft, 10);
  assert.equal(p.remaining, 6);
  assert.equal(p.requiredPerDay, 0.6);
  assert.equal(p.expected, null);
  assert.equal(p.delta, null);
  assert.equal(paceText(p, "number", 1), "10 days left · 0,6/day to go");
});

test("with a start the line runs 0 → target and the delta is the distance from it", () => {
  // half the span elapsed, so half the target was expected
  const p = progressPace(7, 10, "2026-08-13", "2026-08-03", "2026-08-08");
  assert.equal(p.expected, 5);
  assert.equal(p.delta, 2);
  assert.equal(paceText(p, "number"), "ahead by 2 · 5 days left");

  const behind = progressPace(3, 10, "2026-08-13", "2026-08-03", "2026-08-08");
  assert.equal(behind.delta, -2);
  assert.equal(paceText(behind, "number"), "behind by 2 · 5 days left");

  const onPace = progressPace(5, 10, "2026-08-13", "2026-08-03", "2026-08-08");
  assert.equal(onPace.delta, 0);
  assert.equal(paceText(onPace, "number"), "on pace · 5 days left");
});

test("the line doesn't extrapolate past either end", () => {
  // before the start day nothing was expected yet
  const early = progressPace(0, 10, "2026-08-13", "2026-08-03", "2026-08-01");
  assert.equal(early.expected, 0);
  // past the deadline the whole target was expected, never more
  const late = progressPace(8, 10, "2026-08-13", "2026-08-03", "2026-08-20");
  assert.equal(late.expected, 10);
  assert.equal(late.delta, -2);
  assert.equal(late.requiredPerDay, null);
  assert.equal(paceText(late, "number"), "behind by 2 · 7 days past the deadline");
});

test("the deadline day itself reads as due today, with the amount left rather than a rate", () => {
  const p = progressPace(6, 10, "2026-08-03", null, "2026-08-03");
  assert.equal(p.daysLeft, 0);
  assert.equal(p.requiredPerDay, null);
  assert.equal(paceText(p, "number"), "due today · 4 to go");
});

test("one day left reads singular", () => {
  assert.equal(paceText(progressPace(9, 10, "2026-08-04", null, "2026-08-03"), "number"), "1 day left · 1/day to go");
});

test("a reached target outranks the pace line", () => {
  const p = progressPace(12, 10, "2026-08-13", "2026-08-03", "2026-08-08");
  assert.equal(p.remaining, 0);
  assert.equal(paceText(p, "number"), "target reached · 5 days left");
  const past = progressPace(10, 10, "2026-08-01", null, "2026-08-03");
  assert.equal(paceText(past, "number"), "target reached · 2 days past the deadline");
});

test("pace numbers wear the card's format", () => {
  const p = progressPace(12000, 50000, "2026-08-13", "2026-08-03", "2026-08-08");
  assert.equal(paceText(p, "eur"), "behind by 13.000 € · 5 days left");
});

test("pace is pure calendar arithmetic across a DST boundary", () => {
  // Europe/Berlin springs forward on 2026-03-29; the count stays whole days
  const p = progressPace(0, 10, "2026-04-05", "2026-03-22", "2026-03-29");
  assert.equal(p.daysLeft, 7);
  assert.equal(p.expected, 5);
});

test("parseProgressBlocks: an unclosed fence is a banner, not a silent zero", () => {
  const blocks = parseProgressBlocks("```progress\nlabel: A\nvalue: {{S.a}}\ntarget: 10\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].config, null);
  assert.match(blocks[0].error ?? "", /```progress fence is never closed — add a closing ``` line/);
  assert.match(
    parseProgressBlocks("```progress \nlabel: A\n")[0]?.error ?? "",
    /never closed/
  );
});

test("parseProgressBlocks: an opener with a stray trailing space still parses", () => {
  // the likeliest hand-typo of an opener: it used to draw nothing and say
  // nothing, because the fence was closed and only the opener was refused.
  for (const open of ["```progress ", "```progress\t"]) {
    const blocks = parseProgressBlocks(open + "\nlabel: A\nvalue: {{S.a}}\ntarget: 10\n```");
    assert.equal(blocks.length, 1, open);
    assert.equal(blocks[0].error, null, open);
  }
  // a real second word is still a plain code box
  assert.equal(parseProgressBlocks("```progress wide\nlabel: A\nvalue: {{S.a}}\ntarget: 10\n```").length, 0);
});

test("parseProgressBlocks: no banner over a goal the board just drew", () => {
  const config = "label: A\nvalue: {{S.a}}\ntarget: 10";
  for (const body of [
    "```progress\n" + config + "\n  ```\n",
    "```progress\n" + config + "\n```js\n",
    "```progress\n" + config + "\n```\n\n```ts\nconst x = 1;\n",
  ]) {
    const blocks = parseProgressBlocks(body);
    assert.equal(blocks.length, 1, body);
    assert.equal(blocks[0].error, null, body);
  }
  assert.deepEqual(parseProgressBlocks("~~~\n```progress\n" + config + "\n~~~\n"), []);
});
