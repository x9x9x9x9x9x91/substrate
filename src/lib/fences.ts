// Machine fences (```view / ```chart / ```progress / ```cards / ```heatmap /
// ```calendar / ```timeline / ```csv / ```formulas) hold app-parsed
// config/data, not prose (vault-format §5) — their bodies stay out of search
// indexing. Mirrors strip_machine_fences in
// src-tauri/src/vault/mod.rs; keep the fence set and semantics in lockstep
// with it.

/** Fence languages the hub/editor dispatch as live widgets on the FIRST WORD
    of the info string — so a tailed opener (```view table, ```chart compact)
    renders as a widget and its config must leave the index like the bare form
    for `view` as much as for `chart`/`cards`. `cards` renders live once the
    hub-canvas lands; stripping it is contract, not yet render.
    `progress` joins them with the goal thermometer — a fence's
    target, deadline and bind are config, so they leave the index too.

    These dispatch CASE-INSENSITIVELY — every reader lowercases the first word
    before matching (`HubDashboard.tsx` renderMarkdown, `Editor.tsx`
    isViewFence, `metriccards.ts` collectCardsFences, `slashmenu.ts`
    fenceLang) — so ```View and ```CHART render live too, and the strip pass
    must fold case the same way or their config stays in the search index
    while the widget renders. The case rule follows dispatch per
    LANG, not per group — see CASE_FOLDING_BARE_LANGS below. */
export const TAILED_MACHINE_FENCE_LANGS = ["view", "chart", "progress", "cards"] as const;

/** Fence languages whose parsers are strict bare-form (the sheet csv/formulas
    parsers, the hub's heatmap and timeline, the calendar parser):
    a TAILED one renders as plain code — someone's prose — and stays
    searchable. Only the bare opener is machine content. (Likewise for
    timeline.) */
export const BARE_MACHINE_FENCE_LANGS = [
  "csv",
  "formulas",
  "heatmap",
  "calendar",
  "timeline",
] as const;

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
const CASE_FOLDING_BARE_LANGS: ReadonlySet<string> = new Set([
  "heatmap",
  "calendar",
  "timeline",
]);

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
  return (
    (BARE_MACHINE_FENCE_LANGS as readonly string[]).includes(lang.toLowerCase()) &&
    !/^[ \t]*\r?$/.test(tail)
  );
}

/** The app parsers' fence semantics: "```<lang>\n" anywhere opens, the next
    "```" (or EOF) closes — the same regex shape the view/chart parsers use.
    The sheet pair (csv/formulas) is NARROWER: `findFence` takes an opener only
    at the start of a line, so an indented ```csv is prose there while this
    pattern still strips it. Deliberate — stripping a block no parser renders
    costs a little config searchability, and the reverse leaks machine content
    into the index. User code fences (```ts, ```python foo, …) are prose and
    stay searchable, tail and all. Tails are accepted for the live-dispatch
    languages only, and a tail may not contain a backtick — an inline prose
    mention of a fence opener (`` ```chart `` in running text) must never
    swallow the rest of its line and blank prose to the next fence
    review finding; the guard also closes the same pre-existing leak for
    ```view tails). CRLF openers (```view\r\n) strip too.

    The bare-form group carries `[ \t]*` before the newline because its
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
export const MACHINE_FENCE_RE = new RegExp(
  "```(?:(?:" +
    TAILED_MACHINE_FENCE_LANGS.map(foldCase).join("|") +
    ")(?:[ \\t][^`\\n]*)?|(?:" +
    BARE_MACHINE_FENCE_LANGS.map((l) => (CASE_FOLDING_BARE_LANGS.has(l) ? foldCase(l) : l)).join(
      "|"
    ) +
    ")[ \\t]*)\\r?\\n[\\s\\S]*?(?:```|$)",
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
