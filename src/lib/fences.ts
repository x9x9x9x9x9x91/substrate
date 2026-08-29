// Machine fences (```view / ```chart / ```progress / ```cards / ```heatmap /
// ```calendar / ```timeline / ```csv / ```formulas) hold app-parsed
// config/data, not prose (vault-format §5) — their bodies stay out of search
// indexing. Mirrors strip_machine_fences in
// src-tauri/src/vault/mod.rs; keep the fence set and semantics in lockstep
// with it (scripts/check-fence-langs.ts compares the two grammars and fails
// `npm test` when they drift).
//
// WHICH languages are machine fences — and each one's form, case rule and
// hub reach — is declared once in fenceRegistry.ts; the collections below
// are derived from it, in registry order (the pattern text depends on that
// order, and the Rust twin spells the same order by hand).

import { FENCE_REGISTRY } from "./fenceRegistry.ts";

/** Fenced blocks and inline code spans — the tag-free / live-value-free zones,
    mirroring the Rust `code_ranges` the link scanner rides (tags.rs). Shared
    by tags.ts and livevalues.ts; both consume it via `matchAll` only, so the
    shared `/g` object's lastIndex is never mutated. Deliberately not `/m`: the
    closing `$` must mean end-of-input (an unclosed fence runs to EOF), or a
    closed fence would end at its first line break and the fence marker below
    it would open a second, phantom block. The inline alternative is
    single-backtick only, which makes doubling the escape hatch for writing
    the syntax itself in prose. */
export const CODE_SPAN_RE =
  /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:\n(?:```|~~~)[^\n]*(?=\n|$)|$)|`[^`\n]*`/g;

/** Fence languages the hub/editor dispatch as live widgets on the FIRST WORD
    of the info string — so a tailed opener (```view table, ```chart compact)
    renders as a widget and its config must leave the index like the bare form
    for `view` as much as for `chart`/`cards` — a fence's source, target and
    bind lines are config, so they leave the index in either spelling.

    These dispatch CASE-INSENSITIVELY — every reader lowercases the first word
    before matching (`HubDashboard.tsx` renderMarkdown, `Editor.tsx`
    isViewFence, `metriccards.ts` collectCardsFences, `slashmenu.ts`
    fenceLang) — so ```View and ```CHART render live too, and the strip pass
    must fold case the same way or their config stays in the search index
    while the widget renders. The case rule follows dispatch per
    LANG, not per group — see CASE_FOLDING_BARE_LANGS below. */
export const TAILED_MACHINE_FENCE_LANGS: readonly string[] = FENCE_REGISTRY.filter(
  (f) => f.form === "tailed"
).map((f) => f.id);

/** Fence languages whose parsers are strict bare-form (the sheet csv/formulas
    parsers, the hub's heatmap and timeline, the calendar parser):
    a TAILED one renders as plain code — someone's prose — and stays
    searchable. Only the bare opener is machine content. (Likewise for
    timeline.) */
export const BARE_MACHINE_FENCE_LANGS: readonly string[] = FENCE_REGISTRY.filter(
  (f) => f.form === "bare"
).map((f) => f.id);

/** The bare-form langs whose OPENER is read leniently, because their readers
    read it leniently: everything the hub canvas draws. `renderMarkdown`
    (HubDashboard.tsx) and the editor take the info string the way CommonMark
    hands it over — leading whitespace trimmed, tilde marker as good as
    backtick — so ``` ␠heatmap and ~~~calendar draw the live board and their
    config must leave the search index with it. */
export const HUB_BARE_MACHINE_FENCE_LANGS: readonly string[] = FENCE_REGISTRY.filter(
  (f) => f.form === "bare" && f.hub
).map((f) => f.id);

/** The sheet pair (csv/formulas) — the bare-form langs with no hub reader, and
    the only fences in the app whose opener must HUG a backtick marker. Their
    one parser is `findFence` (sheet.ts, and its Rust twin `find_fence` in
    vault/sheetcsv.rs), which looks for the literal "```csv" at the start of a
    line: `~~~csv` and ``` ␠csv ``` are prose to it, and to every other reader
    in the app. Stripping those spellings took a user's own content out of
    search with no leak closed anywhere — the exact trade the comment below
    rules out — so the marker alternation and the space-before-info allowance
    stop at this group. A trailing space is a different case and IS allowed:
    both sheet parsers skip horizontal whitespace after the lang word. */
export const SHEET_BARE_MACHINE_FENCE_LANGS: readonly string[] = FENCE_REGISTRY.filter(
  (f) => f.form === "bare" && !f.hub
).map((f) => f.id);

/** The case rule is a SEPARATE axis from the tail rule above, and it follows
    each lang's own dispatcher — whatever spelling dispatch accepts, the
    stripper strips.

    csv/formulas dispatch CASE-SENSITIVELY: `findFence` (sheet.ts) matches the
    literal "```csv"/"```formulas", so ```CSV parses as nothing and renders as
    a plain code box — prose, which stays searchable. Widening the strip to it
    would silently drop a user's own content out of search without closing any
    leak.

    heatmap dispatches case-INSENSITIVELY, from BOTH its readers: the hub
    lowercases (`renderMarkdown` in HubDashboard.tsx, which re-wraps the inner
    in a canonical opener before parsing) and the dashboard pane's
    `parseHeatmapBlocks` (heatmap.ts) folds case in its opener. They disagreed
    once — the pane matched the literal opener, so a bare ```HeatMap drew the
    year grid on the hub and nothing in the pane, with its config left in the
    search index (the strip was widened to the hub's spelling, then the pane's
    parser widened to match). Where dispatchers ever disagree again
    the strip follows the WIDEST one: stripping a fence some reader renders
    live closes a real leak, and the cost if the other reader is the one a note
    uses is that a machine-config block stays out of search — which is the rule
    for machine config anyway. heatmap stays bare-form for the tail rule; it
    only folds case. If a bare-form parser
    ever starts or stops folding case, move the lang across this set — both
    sides.

    timeline folds case for the simpler version of the same reason:
    its ONE dispatcher is the hub, which lowercases the first word before
    matching, so a bare ```TimeLine draws the live band and its source/start/
    label config must leave the index with it. */
const CASE_FOLDING_BARE_LANGS: ReadonlySet<string> = new Set(
  FENCE_REGISTRY.filter((f) => f.form === "bare" && f.foldsCase).map((f) => f.id)
);

/** A language id spelled so it matches in any case: `view` → `[Vv][Ii][Ee][Ww]`.
    Digits and hyphens (legal in a lang id) have no case and pass through.

    The obvious spelling for this is an inline modifier group — `(?i…)` —
    and that is what the first cut used — but pattern modifiers are
    ES2025, first shipped in Safari/WebKit 26.0. `MACHINE_FENCE_RE` is built at
    module load and this module is in the boot bundle (src/lib/tauri.ts), so on
    any older WKWebView — which every macOS/iOS build can still land on, no
    `minimumSystemVersion` is declared — the pattern would throw a SyntaxError
    at parse time and the app would not boot at all. Character classes are
    ES1 and parse everywhere, in the Rust `regex` crate too.

    The fold stays IN the pattern text rather than on the regex object for the
    same reason it did before: a JS `i` flag (or Rust's
    `RegexBuilder.case_insensitive`) would fold case without changing one
    character of either pattern, which is exactly the drift the lockstep check
    cannot see. The `i` flag is also wrong on the merits here — it
    would fold csv/formulas too, and ```CSV must stay searchable prose. */
const foldCase = (lang: string) => lang.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`);

/** Whether an opener is a TAILED one of a bare-form language (```calendar
    month, ```csv raw). Those parsers accept the bare opener only, so the block
    is someone's prose: it renders as a code box and stays in the search index,
    exactly as stripMachineFences below leaves it. Any surface that dispatches
    live widgets on the info string's FIRST WORD must ask this before mounting,
    or a tailed opener renders live while its config stays indexed (the
    machine-fence leak class from the other direction). `tail` is
    the info string after the first word — bodies arrive line-split, so a
    trailing CR (a CRLF opener) is not a tail.

    A stray space or tab is not a tail either: ```calendar␠ names no second
    word, it is the bare opener typed with a stray space, and every bare-form
    parser now reads it as one. Counting it as a tail here would send exactly
    that opener to a code box on the surfaces that ask this — the hub would
    draw prose over a fence the pane draws live, which is the silence this
    rule exists to end. The allowance stops at the same [ \t] the parsers and
    both strip twins spell: a non-breaking space (or any other exotic
    whitespace) IS a tail here, because no parser skips it — reading it as
    bare would mount a live board whose config nothing strips. */
export function isTailedBareFence(lang: string, tail: string): boolean {
  return BARE_MACHINE_FENCE_LANGS.includes(lang.toLowerCase()) && !/^[ \t]*\r?$/.test(tail);
}

/** The app parsers' fence semantics: "```<lang>\n" anywhere opens, the next
    "```" (or EOF) closes — the same regex shape the view/chart parsers use.
    A TILDE opener (~~~view) opens the same way and a tilde run closes it:
    lezer parses one as a `FencedCode` with the same `CodeInfo`, so the editor
    draws a ~~~view embed live exactly like the backtick spelling, and a
    rendering fence whose config stays in the search index is the
    machine-fence leak this pass exists to close.

    The two markers share ONE alternation rather than being spelled as two
    marker-paired branches: the closer is "the next ``` or ~~~ anywhere", not
    "a run of the character the opener used". CommonMark pairs them, and a
    backreference is the natural spelling — but the Rust twin's `regex` crate
    has none, so pairing would mean writing the whole grammar twice on both
    sides, four lang runs to keep in step. The cost of not pairing is one
    contrived shape: a machine fence whose BODY carries a bare run of the
    other marker closes early and leaves the rest of its config indexed.
    Machine-fence bodies are `source:`/`target:` config lines and csv rows, so
    that shape is not one a note reaches; the body rule was already
    deliberately lenient here ("the next ``` ANYWHERE", not a bare closer
    line), and this stays inside that leniency.
    The sheet pair (csv/formulas) has its OWN branch, off the marker
    alternation and off the space-before-info allowance, because its one parser
    (`findFence`, sheet.ts, twinned by `find_fence` in vault/sheetcsv.rs) looks
    for the literal "```csv" at the start of a line. `~~~csv` and ``` ␠csv ```
    draw nothing anywhere in the app, so stripping them would take a user's own
    content out of search with no leak closed — the trade this file rules out
    two paragraphs down, run backwards. What the sheet branch keeps is the
    trailing `[ \t]*`, which both sheet parsers keep too (```csv␠ is the bare
    opener with a stray space, and they skip it).
    The pair stays NARROWER than its parser in one direction, deliberately:
    `findFence` takes an opener only at the start of a line, so an indented
    ```csv is prose there while this pattern still strips it — stripping a
    block no parser renders costs a little config searchability, and the
    reverse leaks machine content into the index. User code fences (```ts, ```python foo, …) are prose and
    stay searchable, tail and all. Tails are accepted for the live-dispatch
    languages only, and a tail may not contain a backtick — an inline prose
    mention of a fence opener (`` ```chart `` in running text) must never
    swallow the rest of its line and blank prose to the next fence
    review finding; the guard also closes the same pre-existing leak for
    ```view tails). The backtick guard holds for the tilde spelling too, which
    is NARROWER than CommonMark — a tilde fence's info string may carry
    backticks there — but the shape it refuses is the same inline mention
    written in prose (`` `~~~chart …` ``), and refusing it costs at most a
    tail nobody writes. CRLF openers (```view\r\n) strip too.

    The opener carries `[ \t]*` BEFORE the language because CommonMark reads
    the info string with its leading whitespace stripped, and every reader that
    DRAWS one does too: lezer hands the editor `view` for "``` view", and the
    block scanner behind the hub takes its first word off the trimmed info
    string (mdblocks.ts). A pattern that required the language to hug the
    marker left that spelling's `source:`/`target:` lines in the search index
    while three surfaces drew the widget — the editor at top level, the
    editor's column cells and the hub canvas; print is NOT one of them and
    never has been, it emits every fence as the code box its author typed
    (`renderMdBlock`, print.ts). A run of spaces and no language still matches
    nothing: the group after it demands a lang, and the sheet pair is not in
    the group this allowance reaches.

    Both bare-form branches carry `[ \t]*` before the newline because their
    parsers do: ```calendar␠ is the likeliest way to mistype an opener by
    hand, it renders the live board, and a rendering fence whose config stays
    in the search index is the machine-fence leak. The live-dispatch group
    needs no such allowance — its tail already swallows a trailing space.

    The live-dispatch group — plus every bare-form lang whose own dispatcher
    folds case (heatmap) — is spelled per-letter ([Vv][Ii][Ee][Ww]) by
    `foldCase` above — case folding is IN the pattern, not on the regex
    object, so both sides carry it in a single string that can be compared
    character for character, and it uses only syntax every shipped WebKit
    parses. See foldCase for why not `(?i…)` and why not the `i` flag.

    Lockstep twin: machine_fence_re in src-tauri/src/vault/mod.rs — the Rust
    side mirrors these lists AND this spelling by hand; change both together.
    Exported for scripts/check-fence-langs.ts, which compares this pattern
    against the Rust one and fails `npm test` when the two drift. */
const spellBare = (l: string) => (CASE_FOLDING_BARE_LANGS.has(l) ? foldCase(l) : l);

export const MACHINE_FENCE_RE = new RegExp(
  "(?:(?:```|~~~)[ \\t]*(?:(?:" +
    TAILED_MACHINE_FENCE_LANGS.map(foldCase).join("|") +
    ")(?:[ \\t][^`\\n]*)?|(?:" +
    HUB_BARE_MACHINE_FENCE_LANGS.map(spellBare).join("|") +
    ")[ \\t]*)|```(?:" +
    SHEET_BARE_MACHINE_FENCE_LANGS.map(spellBare).join("|") +
    ")[ \\t]*)\\r?\\n[\\s\\S]*?(?:```|~~~|$)",
  "g"
);

/** `body` with every machine-fence block blanked newline-for-newline, so
    search-result line numbers still map to the raw body (the editor's reveal
    jumps to them).

    Must keep DELEGATING to `MACHINE_FENCE_RE` — an inline regex here would be
    the pattern the app actually runs while the lockstep checker went on
    comparing the constant, and both sides would read as in step. Enforced by
    checkUseSites in scripts/check-fence-langs.ts; same rule on the
    Rust twin. */
export function stripMachineFences(body: string): string {
  return body.replace(MACHINE_FENCE_RE, (m) => "\n".repeat((m.match(/\n/g) ?? []).length));
}

/** A body with every `~~~` block's lines blanked, so a fence opener QUOTED
    inside one is prose rather than a fence. The parsers themselves do not do
    this — they would read a ```chart opener written inside a ~~~ example as a
    real fence — but a note demonstrating fence syntax is the one place an
    opener is written on purpose and never meant to close, and telling its
    author their fence is broken is a wrong sentence about a note that is
    fine. Narrower than the parsers, so the cost of the divergence is silence,
    never a false accusation. */
function blankQuotedFences(body: string): string {
  let quoted = false;
  return body
    .split("\n")
    .map((raw) => {
      const line = raw.replace(/\r$/, "");
      if (!/^\s*~~~/.test(line)) return quoted ? "" : raw;
      quoted = !quoted;
      return "";
    })
    .join("\n");
}

/** True when the body opens a ```<lang> fence that never closes.

    The fence parsers all match "```<lang>\n … ```" and drop anything without
    a closing line, so an unterminated fence is not a broken chart — it is no
    chart at all, and the board said "0 charts" over an empty pane. That is
    the one answer a reader cannot act on: it names a state the note is not in
    and gives them nothing to fix. Each parser asks this after its scan and
    turns a yes into a block-shaped error, so the fence gets a banner in the
    place it was written.

    Answers the question the way the PARSERS answer it, walking the same
    openers and closers they do, because the banner and the fence it accuses
    have to agree: a board that draws a chart while telling its reader the
    chart's fence never closed is worse than the silence it replaced. So:

    - the closer is the next "```" ANYWHERE after the opener line, not a bare
      "```" line — an indented closer and a closer carrying an info string
      (```js) both close a fence for "match to the next ```", so neither may
      raise a banner over a fence the board just drew;
    - openers are looked for anywhere the parsers' unanchored patterns find
      them, indented ones included. That is WIDER than the sheet parsers now
      read: `findFence` (sheet.ts) requires the opener to start its line, so an
      indented ```csv/```formulas block is prose to it. The width is kept on
      purpose — this banner and the strip pass may only ever err toward saying
      less and stripping more, and narrowing it would put a banner over an
      indented block no parser reads plus leave its config in the search index;
    - only openers of THIS language are looked for, so an unrelated block
      left open elsewhere in the note is not this fence's problem;
    - the opener tolerates trailing spaces (```chart␠), the likeliest way to
      mistype one by hand: the parsers read it as an opener too, so a
      trailing-space fence that never closes is this banner's, and a closed one
      simply renders.

    `foldCase` follows the parser's own opener — heatmap and calendar dispatch
    case-insensitively, the rest do not. */
export function hasUnclosedFence(body: string, lang: string, foldCase = false): boolean {
  const want = foldCase ? lang.toLowerCase() : lang;
  const source = blankQuotedFences(body);
  const openers = /```([^\r\n]*)\r?\n/g;
  // mirrors the parsers' own lastIndex: each closer is where the search for
  // the next opener resumes
  let from = 0;
  while (from <= source.length) {
    openers.lastIndex = from;
    let opener: RegExpExecArray | null = null;
    for (let m = openers.exec(source); m !== null; m = openers.exec(source)) {
      const first = m[1].trim().split(/[ \t]+/)[0] ?? "";
      if ((foldCase ? first.toLowerCase() : first) === want) {
        opener = m;
        break;
      }
    }
    if (opener === null) return false;
    const closer = source.indexOf("```", opener.index + opener[0].length);
    if (closer === -1) return true;
    from = closer + 3;
  }
  return false;
}

/* ── the line-at-a-time fence scanner ───────────────────────────────────── */

/** An opening or closing fence line, as a line-at-a-time scanner sees it:
    the run of backticks or tildes, plus whatever followed it.

    Kept here rather than in each scanner because getting it wrong is quiet.
    A CRLF file's lines arrive carrying their `\r`, and it is not part of the
    info string — JS `.` does not match a carriage return, so the whole line
    read as prose until this said so, quietly turning every fence in a
    Windows-written note invisible to any caller that had not normalized first.
    The Rust twin (`opening_fence`, src-tauri/src/vault/mod.rs) tolerates one
    the same way.

    A parser that only knows ```` ``` ```` reads three kinds of ordinary
    markdown as prose: a `~~~` fence (which is what an author reaches for the
    moment their sample contains backticks), a fence indented one to three
    spaces under a list item, and — the expensive one — a longer run than
    three, where the SHORT closer test never fires and the scanner believes it
    is inside code for the rest of the note. */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})([^\n\r]*)\r?$/;

/** The run that opens a fence on this line, or null when the line is prose.

    CommonMark's two rules that matter to a scanner: up to three spaces of
    indent still open a fence (four make an indented code block, which has no
    marker line to confuse anyone), and a BACKTICK opener's info string may not
    itself contain a backtick — `` ``` ``a`` `` is inline code in a paragraph,
    not a fence. Tilde openers take any info string. */
export function fenceOpening(line: string): string | null {
  const m = FENCE_LINE_RE.exec(line);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return m[1];
}

/** Whether this line closes the fence `run` opened. A closer is the same
    character, at least as long as the opener (so ```` ```` ```` closes a
    ```` ``` ```` but not the reverse), and carries no info string — which is
    what keeps a second opener inside a fence from ending it. */
export function fenceCloses(line: string, run: string): boolean {
  const m = FENCE_LINE_RE.exec(line);
  if (!m) return false;
  return m[1][0] === run[0] && m[1].length >= run.length && m[2].trim() === "";
}
