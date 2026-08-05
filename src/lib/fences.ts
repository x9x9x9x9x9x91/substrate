// Machine fences (```view / ```chart / ```progress / ```cards / ```heatmap /
// ```calendar / ```csv / ```formulas) hold
// app-parsed config/data, not prose (vault-format §5) — their bodies stay out
// of search indexing (SUB-261). Mirrors strip_machine_fences in
// src-tauri/src/vault/mod.rs; keep the fence set and semantics in lockstep
// with it.

/** Fence languages the hub/editor dispatch as live widgets on the FIRST WORD
    of the info string — so a tailed opener (```view table, ```chart compact)
    renders as a widget and its config must leave the index like the bare form
    (SUB-899 for view, SUB-983 for chart/cards). `cards` renders live once the
    hub-canvas lands (SUB-964); stripping it is contract, not yet render.
    `progress` joins them with the goal thermometer (SUB-967) — a fence's
    target, deadline and bind are config, so they leave the index too.

    These dispatch CASE-INSENSITIVELY — every reader lowercases the first word
    before matching (`HubDashboard.tsx` renderMarkdown, `Editor.tsx`
    isViewFence, `metriccards.ts` collectCardsFences, `slashmenu.ts`
    fenceLang) — so ```View and ```CHART render live too, and the strip pass
    must fold case the same way or their config stays in the search index
    while the widget renders (SUB-1104). The case rule follows dispatch per
    LANG, not per group — see CASE_FOLDING_BARE_LANGS below. */
export const TAILED_MACHINE_FENCE_LANGS = ["view", "chart", "progress", "cards"] as const;

/** Fence languages whose parsers are strict bare-form (the sheet csv/formulas
    parsers, the hub's heatmap, the calendar parser of SUB-965): a TAILED one
    renders as plain code — someone's prose — and stays searchable. Only the
    bare opener is machine content. */
export const BARE_MACHINE_FENCE_LANGS = ["csv", "formulas", "heatmap", "calendar"] as const;

/** The case rule is a SEPARATE axis from the tail rule above, and it follows
    each lang's own dispatcher — whatever spelling dispatch accepts, the
    stripper strips (SUB-1104, SUB-1128).

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
    search index (SUB-1128 widened the strip to the hub's spelling, SUB-1129
    widened the pane's parser to match). Where dispatchers ever disagree again
    the strip follows the WIDEST one: stripping a fence some reader renders
    live closes a real leak, and the cost if the other reader is the one a note
    uses is that a machine-config block stays out of search — which is the rule
    for machine config anyway. heatmap stays bare-form for the tail rule; it
    only folds case. If a bare-form parser
    ever starts or stops folding case, move the lang across this set — both
    sides. */
const CASE_FOLDING_BARE_LANGS: ReadonlySet<string> = new Set(["heatmap", "calendar"]);

/** A language id spelled so it matches in any case: `view` → `[Vv][Ii][Ee][Ww]`.
    Digits and hyphens (legal in a lang id) have no case and pass through.

    The obvious spelling for this is an inline modifier group — `(?i…)` —
    and that is what the first cut of SUB-1104 used — but pattern modifiers are
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
    cannot see (SUB-1069). The `i` flag is also wrong on the merits here — it
    would fold csv/formulas too, and ```CSV must stay searchable prose. */
const foldCase = (lang: string) => lang.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`);

/** Whether an opener is a TAILED one of a bare-form language (```calendar
    month, ```csv raw). Those parsers accept the bare opener only, so the block
    is someone's prose: it renders as a code box and stays in the search index,
    exactly as stripMachineFences below leaves it. Any surface that dispatches
    live widgets on the info string's FIRST WORD must ask this before mounting,
    or a tailed opener renders live while its config stays indexed (SUB-965
    review; the SUB-899/SUB-983 leak class from the other direction). `tail` is
    the info string after the first word — bodies arrive line-split, so a
    trailing CR (SUB-913's CRLF openers) is not a tail. */
export function isTailedBareFence(lang: string, tail: string): boolean {
  return (
    (BARE_MACHINE_FENCE_LANGS as readonly string[]).includes(lang.toLowerCase()) &&
    tail.replace(/\r$/, "") !== ""
  );
}

/** The app parsers' fence semantics: "```<lang>\n" anywhere opens, the next
    "```" (or EOF) closes — the same regex shape the view/chart/sheet/csv
    parsers use. User code fences (```ts, ```python foo, …) are prose and stay
    searchable, tail and all. Tails are accepted for the live-dispatch
    languages only, and a tail may not contain a backtick — an inline prose
    mention of a fence opener (`` ```chart `` in running text) must never
    swallow the rest of its line and blank prose to the next fence (SUB-983
    review finding; the guard also closes the same pre-existing leak for
    ```view tails). CRLF openers (```view\r\n) strip too (SUB-913).

    The live-dispatch group — plus every bare-form lang whose own dispatcher
    folds case (heatmap) — is spelled per-letter ([Vv][Ii][Ee][Ww]) by
    `foldCase` above — case folding is IN the pattern, not on the regex
    object, so both sides carry it in a single string that can be compared
    character for character, and it uses only syntax every shipped WebKit
    parses. See foldCase for why not `(?i…)` and why not the `i` flag.

    Lockstep twin: machine_fence_re in src-tauri/src/vault/mod.rs — the Rust
    side mirrors these lists AND this spelling by hand; change both together.
    Exported for scripts/check-fence-langs.ts, which compares this pattern
    against the Rust one and fails `npm test` when the two drift (SUB-1069). */
export const MACHINE_FENCE_RE = new RegExp(
  "```(?:(?:" +
    TAILED_MACHINE_FENCE_LANGS.map(foldCase).join("|") +
    ")(?:[ \\t][^`\\n]*)?|" +
    BARE_MACHINE_FENCE_LANGS.map((l) => (CASE_FOLDING_BARE_LANGS.has(l) ? foldCase(l) : l)).join(
      "|"
    ) +
    ")\\r?\\n[\\s\\S]*?(?:```|$)",
  "g"
);

/** `body` with every machine-fence block blanked newline-for-newline, so
    search-result line numbers still map to the raw body (the editor's reveal
    jumps to them). */
export function stripMachineFences(body: string): string {
  return body.replace(MACHINE_FENCE_RE, (m) => "\n".repeat((m.match(/\n/g) ?? []).length));
}
