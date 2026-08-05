#!/usr/bin/env node
/**
 * Machine-fence lockstep drift check.
 *
 * Which fenced languages hold app-parsed config rather than prose (vault-format
 * §5) is written out TWICE, in two languages that cannot import each other:
 *
 *   1. TS   — `TAILED_MACHINE_FENCE_LANGS` / `BARE_MACHINE_FENCE_LANGS` in
 *             src/lib/fences.ts, which build `MACHINE_FENCE_RE`. The renderer
 *             side: it decides what the app's own search index skips.
 *   2. Rust — the literal regex in `machine_fence_re()`, src-tauri/src/vault/mod.rs.
 *             The indexer side: it decides what actually lands in the SQLite
 *             search table the app queries.
 *
 * Both files say "lockstep twin … change both together" and nothing enforced
 * it. Each side's tests only ever exercised its own list, so a language added
 * to one alone failed nothing: add it to Rust only and the editor renders a
 * live widget whose config the index no longer holds; add it to TS only and
 * the fence's config keeps landing in search results as prose. Neither is
 * visible until someone searches for a word that used to be — or no longer is
 * — findable. Five languages exist already and four more fence lanes are in
 * flight, each extending both sides by hand.
 *
 * Same shape as scripts/check-ipc.ts and scripts/check-kinds.ts
 * re-derive both inventories mechanically from the checked-in tree,
 * compare, fail `npm test` on divergence. Input it cannot parse is thrown,
 * never skipped — a silently skipped inventory is exactly the drift this
 * exists to catch.
 *
 * The TS side is read by IMPORTING the compiled regex rather than by parsing
 * the file: `MACHINE_FENCE_RE` is assembled from the two constants at module
 * load, so the imported pattern is what the app runs, and a parser here could
 * only be a third opinion about it. The Rust literal has no such route and is
 * lifted out of the source.
 *
 * Comparison runs at three depths. The lang SETS are compared tailed-vs-tailed
 * and bare-vs-bare, because the distinction is load-bearing: the live-dispatch
 * languages accept an info-string tail (```view table), the strict bare-form
 * parsers do not, so a language that moved between the two groups on one side
 * only is drift even though the union matches. Each language present on both
 * sides then has its SPELLING compared, because a case-folded id and a plain
 * one are the same id and different matchers (```HeatMap once stripped on
 * one side only). Then the whole PATTERNS are compared, which catches the
 * grammar drifting even while the lists agree — the backtick guard and
 * the CRLF opener were each added to both sides by hand, and either
 * could have missed.
 *
 * All three run INDEPENDENTLY: a merge that both adds a language on
 * one side and unfolds another's case would otherwise need one fix-and-re-run
 * per finding, because each depth was gated on the one above coming back clean.
 *
 * `checkUseSites` closes the last structural hole: everything above
 * compares two DECLARED patterns, and said nothing about whether either side's
 * strip function still runs the pattern that was compared. Both do, by
 * delegation, and that is now asserted rather than assumed.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blankNonCode, matchDelim } from "./check-ipc.ts";
import { MACHINE_FENCE_RE } from "../src/lib/fences.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_REL = "src-tauri/src/vault/mod.rs";
const TS_REL = "src/lib/fences.ts";

/* ── the shape both sides must have ─────────────────────────────────────── */

/**
 * End-of-input alternative, spelled `$` in JS and `\z` in Rust. The one
 * difference between the two patterns that is a difference in dialect rather
 * than in meaning: JS `$` without the `m` flag matches only at end of input,
 * which is what `\z` means. Normalized to this placeholder before the two are
 * compared, so the rest must match character for character.
 */
const END = "<END-OF-INPUT>";

/**
 * The pattern shape, holes and all — read it against fences.ts and it is the
 * same string. Escaped mechanically below rather than by hand, so this stays
 * legible and cannot pick up a hand-escaping typo.
 */
const TEMPLATE = "```(?:(?:<TAILED>)(?:[ \\t][^`\\n]*)?|<BARE>)\\r?\\n[\\s\\S]*?(?:```|" + END + ")";

/**
 * One fence language id as it appears INSIDE a pattern. Not simply `[a-z0-9-]+`:
 * a language whose dispatcher lowercases before matching is spelled per-letter,
 * `[Vv][Ii][Ee][Ww]`, so case folding lives in the pattern text where both
 * sides can be compared character for character (`foldCase` in fences.ts, and
 * see there for why not the `i` flag). Both holes take the widened token —
 * case folding reached the tailed group first, then `heatmap` inside the
 * BARE group, so restricting either hole to plain runs makes the checker refuse
 * the very pattern it exists to compare.
 */
const LANG_TOKEN = "(?:\\[[A-Za-z][A-Za-z]\\]|[a-z0-9-])+";

/** A `|`-joined run of fence language ids. */
const LANG_RUN = "(" + LANG_TOKEN + "(?:\\|" + LANG_TOKEN + ")*)";

/**
 * A captured lang token with its case pairs collapsed back to the id — `view`,
 * `heatmap` — so drift is reported by the name the two files spell, not as
 * `[Hh][Ee][Aa][Tt][Mm][Aa][Pp]`. Also what the set diff compares: the pair
 * spelling is a rendering of the id, not a different id.
 */
const decode = (s: string) => s.replace(/\[([A-Za-z])[A-Za-z]\]/g, (_, c) => c.toLowerCase());

const SHAPE = new RegExp(
  "^" +
    TEMPLATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace("<TAILED>", LANG_RUN)
      .replace("<BARE>", LANG_RUN) +
    "$"
);

/** One side's fence inventory: the two lang groups, and its raw pattern. */
export type FenceInventory = {
  /** language ids, case pairs decoded (`[Vv][Ii][Ee][Ww]` → `view`) */
  tailed: string[];
  /** language ids, case pairs decoded */
  bare: string[];
  /**
   * The same two groups as the pattern SPELLS them — `[Vv][Ii][Ee][Ww]`, `csv`
   * — keyed by decoded id. Same ids with different spellings are two different
   * matchers, and that difference is invisible in the decoded lists.
   */
  spelling: Record<"tailed" | "bare", Map<string, string>>;
  /** the pattern with the end-of-input alternative normalized to `END` */
  pattern: string;
};

/* ── parsers ────────────────────────────────────────────────────────────── */

/**
 * `pattern` with its trailing end-of-input alternative normalized. Throws when
 * the pattern ends in neither dialect's spelling: an unrecognized tail means
 * the fence grammar changed shape, and guessing past it would compare two
 * patterns that no longer close the same way.
 */
export function normalizeEnd(pattern: string, label: string): string {
  for (const anchor of ["(?:```|$)", "(?:```|\\z)"]) {
    if (pattern.endsWith(anchor)) return pattern.slice(0, -anchor.length) + "(?:```|" + END + ")";
  }
  throw new Error(
    `${label}: pattern does not end in an end-of-input alternative — got …${pattern.slice(-24)}`
  );
}

/**
 * The two lang groups out of a machine-fence pattern, in source order.
 * Anything that isn't the shape above throws: this checker's whole job is to
 * notice that the two sides stopped agreeing, and a pattern it quietly failed
 * to read would be reported as agreement.
 */
export function parseFencePattern(raw: string, label: string): FenceInventory {
  const pattern = normalizeEnd(raw, label);
  const m = SHAPE.exec(pattern);
  if (!m) {
    throw new Error(
      `${label}: pattern does not match the known machine-fence shape.\n` +
        `    got:      ${pattern}\n` +
        `    expected: ${TEMPLATE}\n` +
        "    If the grammar genuinely changed, change it on BOTH sides and update TEMPLATE here."
    );
  }
  const groups = { tailed: m[1].split("|"), bare: m[2].split("|") };
  // First spelling wins on a duplicate — a repeated language is already
  // reported as a list difference, and picking one keeps that from also
  // reading as a spelling disagreement with the other side.
  const spell = (raw: string[]) => {
    const out = new Map<string, string>();
    for (const token of raw) if (!out.has(decode(token))) out.set(decode(token), token);
    return out;
  };
  return {
    tailed: groups.tailed.map(decode),
    bare: groups.bare.map(decode),
    spelling: { tailed: spell(groups.tailed), bare: spell(groups.bare) },
    pattern,
  };
}

/**
 * The regex literal inside Rust's `machine_fence_re()`.
 *
 * Located on the comment- and string-blanked source (offsets survive that, so
 * the slice indexes back into the original), which keeps a `fn
 * machine_fence_re` written inside a doc comment from being mistaken for the
 * function. The literal SCAN also runs on the blanked body and only the
 * content is sliced out of the original, so an `r"…"` written inside a comment
 * in the body cannot be counted as a second pattern (blankNonCode leaves the
 * quotes in place and blanks only what is between them, so both the opener and
 * its closer are still findable at their real offsets). Exactly one raw string
 * literal may appear in the body; two would mean the function now composes its
 * pattern and this parser is reading half of it.
 *
 * The construction is checked too: the literal must be the argument of a bare
 * `Regex::new(…)`. A `RegexBuilder` would let the Rust side turn on
 * case-insensitivity or multi-line without a single character of the pattern
 * changing, which this checker would then report as agreement.
 */
export function parseRustPattern(src: string, label = RUST_REL): string {
  const code = blankNonCode(src, "rust");
  const fn = /fn\s+machine_fence_re\s*\(/.exec(code);
  if (!fn) throw new Error(`${label}: fn machine_fence_re not found — it moved or was renamed`);
  const open = code.indexOf("{", fn.index + fn[0].length);
  if (open === -1) throw new Error(`${label}: machine_fence_re has no body`);
  const end = matchDelim(code, open) + 1;
  const codeBody = code.slice(open, end);
  const srcBody = src.slice(open, end);

  const literals: { start: number; text: string }[] = [];
  const opener = /\br(#*)"/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(codeBody))) {
    const from = m.index + m[0].length;
    const close = codeBody.indexOf('"' + m[1], from);
    if (close === -1) throw new Error(`${label}: unterminated raw string in machine_fence_re`);
    literals.push({ start: m.index, text: srcBody.slice(from, close) });
    opener.lastIndex = close + 1 + m[1].length;
  }
  if (literals.length !== 1) {
    throw new Error(
      `${label}: expected exactly one raw-string regex in machine_fence_re, found ${literals.length}`
    );
  }
  if (!/\bRegex::new\s*\(\s*$/.test(codeBody.slice(0, literals[0].start))) {
    throw new Error(
      `${label}: the regex literal is not the argument of a bare Regex::new(…) — ` +
        "a builder can set flags (case_insensitive, multi_line) that this checker cannot see"
    );
  }
  return literals[0].text;
}

/* ── use sites ──────────────────────────────────────────────────────────── */

/**
 * The strip function on each side, and the pattern it must delegate to.
 *
 * Everything else in this file compares two DECLARED patterns. Neither
 * comparison says anything about whether the function that actually blanks
 * fence bodies still RUNS the pattern that was compared — and both patterns are
 * declared away from their use site (`MACHINE_FENCE_RE` is a module constant,
 * `machine_fence_re()` a memoized accessor), so a strip function that grew its
 * own inline regex would leave this checker comparing two ornaments and
 * reporting lockstep (verified: both sides stayed green under exactly that edit,
 * independent-findings rework).
 *
 * The rule is delegation, not equality of behavior — a mechanical check cannot
 * decide whether two regexes mean the same thing, but it can insist the strip
 * function does not carry a second one. So: the body must NAME the shared
 * pattern, and must not build a regex of its own. Written against the
 * comment-and-literal-blanked source, so a doc comment mentioning either token
 * neither satisfies nor trips the check.
 */
const USE_SITES = [
  {
    file: TS_REL,
    mode: "ts" as const,
    fn: /function\s+stripMachineFences\s*\(/,
    uses: "MACHINE_FENCE_RE",
    // `/\n/g` counting newlines in a match is fine and must stay fine; what may
    // not appear is a second FENCE grammar. `RegExp` covers `new RegExp(…)` and
    // `RegExp(…)` alike; a bare literal is caught by `uses` going missing,
    // since replacing MACHINE_FENCE_RE with one is what removes the name.
    builds: /\bRegExp\s*\(/,
    what: "the app's own strip pass",
  },
  {
    file: RUST_REL,
    mode: "rust" as const,
    fn: /fn\s+strip_machine_fences\s*(?:<[^>]*>\s*)?\(/,
    uses: "machine_fence_re()",
    builds: /\bRegex(?:Builder)?::/,
    what: "the indexer's strip pass",
  },
];

/**
 * Drift between each side's compared pattern and the strip function that is
 * supposed to run it. Empty means both still delegate.
 *
 * Throws rather than returning a problem when the function cannot be found at
 * all: that is this file's parser being wrong about the tree, not the tree
 * being wrong, and the two want different fixes (same contract as
 * `parseRustPattern`).
 */
export function checkUseSites(sources: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const site of USE_SITES) {
    const code = blankNonCode(sources[site.file], site.mode);
    const fn = site.fn.exec(code);
    if (!fn) {
      throw new Error(
        `${site.file}: the strip function ${site.fn.source} was not found — it moved or was renamed`
      );
    }
    const open = code.indexOf("{", fn.index + fn[0].length);
    if (open === -1) throw new Error(`${site.file}: the strip function has no body`);
    const body = code.slice(open, matchDelim(code, open) + 1);

    if (!body.includes(site.uses)) {
      problems.push(
        `${site.file}: the strip function no longer runs ${site.uses} — ` +
          `this checker compares that pattern, so ${site.what} is now unchecked`
      );
    }
    if (site.builds.test(body)) {
      problems.push(
        `${site.file}: the strip function builds a regex of its own — ` +
          `${site.what} must delegate to ${site.uses}, the pattern this checker compares`
      );
    }
  }
  return problems;
}

/* ── cross-check ────────────────────────────────────────────────────────── */

const list = (xs: readonly string[]) => (xs.length ? xs.join(", ") : "(none)");

/** TEMPLATE with both lang holes closed up — the skeleton every SHAPE-matching
    pattern reduces to. */
const SKELETON = TEMPLATE.replace("<TAILED>", "<LANGS>").replace("<BARE>", "<LANGS>");

/**
 * The pattern with its two lang runs replaced by a placeholder — everything
 * about the fence grammar EXCEPT which languages are in it. Comparing
 * skeletons keeps a list difference (a reorder, a duplicate, a one-sided
 * language) from being reported as the grammar drifting, which is a different
 * fix in a different file. SHAPE is TEMPLATE with the two holes widened into
 * captures, so a pattern that matches it is TEMPLATE character for character
 * outside the runs — which is what makes the skeleton a constant rather than
 * something to cut out of the string. `null` when the pattern is not the known
 * shape, in which case there is no run to lift out and the raw patterns are all
 * there is to compare.
 */
function skeleton(inv: FenceInventory): string | null {
  return SHAPE.test(inv.pattern) ? SKELETON : null;
}

const grammarProblem = (ts: FenceInventory, rust: FenceInventory) =>
  "the fence GRAMMAR differs — one side changed the opener, tail or body rules:\n" +
  `      TS:   ${ts.pattern}\n` +
  `      Rust: ${rust.pattern}`;

/** Human-readable drift between the two inventories; empty means lockstep. */
export function crossCheck(ts: FenceInventory, rust: FenceInventory): string[] {
  const problems: string[] = [];
  for (const group of ["tailed", "bare"] as const) {
    const a = new Set(ts[group]);
    const b = new Set(rust[group]);
    const tsOnly = ts[group].filter((l) => !b.has(l));
    const rustOnly = rust[group].filter((l) => !a.has(l));
    // A lang present in both but in DIFFERENT groups shows up as one-sided in
    // each group, which is the honest reading: the two sides disagree about
    // whether ```<lang> foo is a live widget or someone's prose.
    for (const lang of tsOnly) {
      problems.push(
        `${group}: src/lib/fences.ts has "${lang}", ${RUST_REL} does not — ` +
          "the editor treats it as machine content but the indexer still indexes its config"
      );
    }
    for (const lang of rustOnly) {
      problems.push(
        `${group}: ${RUST_REL} has "${lang}", src/lib/fences.ts does not — ` +
          "the indexer drops its body from search but nothing on the TS side calls it a fence"
      );
    }
    // Spelling, for the languages BOTH sides carry. Independent of the set
    // findings above — a merge that adds a language to one side and
    // unfolds another's case on the other has two problems, and reporting the
    // second only after the first is fixed costs a whole extra round trip.
    // `[Hh][Ee][Aa][Tt][Mm][Aa][Pp]` and `heatmap` decode to the same id, so
    // the set diff cannot see this: it is the case-fold leak exactly — one side
    // strips ```HeatMap, the other indexes its config as prose.
    for (const lang of ts[group].filter((l) => b.has(l))) {
      const tsSpelling = ts.spelling[group].get(lang)!;
      const rustSpelling = rust.spelling[group].get(lang)!;
      if (tsSpelling === rustSpelling) continue;
      const folded = (s: string) => (s.includes("[") ? "case-folded" : "plain");
      problems.push(
        `${group}: "${lang}" is spelled differently on the two sides — ` +
          `src/lib/fences.ts ${folded(tsSpelling)} (${tsSpelling}), ` +
          `${RUST_REL} ${folded(rustSpelling)} (${rustSpelling}); ` +
          "a fold on one side only means a mixed-case opener strips there and stays in " +
          "the search index here"
      );
    }
  }
  // Grammar is compared on the skeletons, so it is INDEPENDENT of the list
  // findings above and runs whether or not they fired: a merge that both added
  // a language on one side and changed the opener would otherwise need two
  // passes to surface its second half.
  const a = skeleton(ts);
  const b = skeleton(rust);
  if (a === null || b === null) {
    // One side is not the known shape — collect() never produces that (both
    // sides are parsed through parseFencePattern), so this is a hand-built
    // inventory: the raw patterns are the only comparison available.
    if (ts.pattern !== rust.pattern) problems.push(grammarProblem(ts, rust));
  } else if (a !== b) {
    problems.push(grammarProblem(ts, rust));
  } else if (problems.length === 0 && ts.pattern !== rust.pattern) {
    // Same grammar, same language SETS, same spelling per language, different
    // pattern text: the runs are written in a different order, or one side
    // repeats a language. Both are harmless to the matcher — the third cause
    // that used to land here, a case-fold spelled on one side only, is not, and
    // now has its own named finding above. What is left is cosmetic,
    // so the patterns themselves are the evidence to look at.
    problems.push(
      "the two sides carry the same languages but not the same LIST — a reorder or a " +
        "duplicate entry, not a coverage, spelling or grammar change:\n" +
        `      TS:   tailed [${list(ts.tailed)}], bare [${list(ts.bare)}]\n` +
        `      Rust: tailed [${list(rust.tailed)}], bare [${list(rust.bare)}]`
    );
  }
  return problems;
}

/* ── driver ─────────────────────────────────────────────────────────────── */

/**
 * The flags `MACHINE_FENCE_RE` may carry. `g` alone: the regex is used to walk
 * every fence in a note. Anything else changes what the SAME pattern text
 * matches, so comparing sources alone would call two different machines equal
 * — `i` would make ```VIEW a live fence on the TS side only, `m` would re-point
 * the `$` that this checker normalizes against Rust's `\z`, and `s` would
 * redefine the body class. The Rust twin's equivalent is checked in
 * `parseRustPattern`: bare `Regex::new`, no builder.
 */
const TS_FLAGS = "g";

/** Both files this checker reads, keyed the way `checkUseSites` wants them. */
export function readSources(): Record<string, string> {
  return {
    [TS_REL]: readFileSync(resolve(ROOT, TS_REL), "utf8"),
    [RUST_REL]: readFileSync(resolve(ROOT, RUST_REL), "utf8"),
  };
}

export function collect(): { ts: FenceInventory; rust: FenceInventory } {
  const rustSrc = readSources()[RUST_REL];
  if (MACHINE_FENCE_RE.flags !== TS_FLAGS) {
    throw new Error(
      `src/lib/fences.ts MACHINE_FENCE_RE: expected flags "${TS_FLAGS}", got ` +
        `"${MACHINE_FENCE_RE.flags}" — a flag change alters what the pattern matches ` +
        "and the Rust twin has no equivalent, so the two sides are no longer comparable"
    );
  }
  return {
    ts: parseFencePattern(MACHINE_FENCE_RE.source, "src/lib/fences.ts MACHINE_FENCE_RE"),
    rust: parseFencePattern(parseRustPattern(rustSrc), `${RUST_REL} machine_fence_re`),
  };
}

function main(): void {
  let inv: { ts: FenceInventory; rust: FenceInventory };
  let useSite: string[];
  try {
    inv = collect();
    useSite = checkUseSites(readSources());
  } catch (e) {
    console.error(`check-fence-langs: could not build the inventories — ${(e as Error).message}`);
    console.error("This is a parse failure, not a clean tree. Fix the parser or the source.");
    process.exit(2);
  }

  const problems = [...crossCheck(inv.ts, inv.rust), ...useSite];
  console.log(
    `check-fence-langs: tailed [${list(inv.ts.tailed)}], bare [${list(inv.ts.bare)}]`
  );
  if (problems.length === 0) {
    console.log("check-fence-langs: TS and Rust fence grammars agree ✓");
    return;
  }
  console.error(`\ncheck-fence-langs: ${problems.length} drift problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
