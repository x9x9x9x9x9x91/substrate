// Machine fences (```view / ```chart / ```progress / ```cards / ```heatmap / ```csv /
// ```formulas) hold
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
    target, deadline and bind are config, so they leave the index too. */
export const TAILED_MACHINE_FENCE_LANGS = ["view", "chart", "progress", "cards"] as const;

/** Fence languages whose parsers are strict bare-form (the sheet csv/formulas
    parsers): a TAILED one renders as plain code — someone's prose — and stays
    searchable. Only the bare opener is machine content. */
export const BARE_MACHINE_FENCE_LANGS = ["csv", "formulas", "heatmap"] as const;

/** The app parsers' fence semantics: "```<lang>\n" anywhere opens, the next
    "```" (or EOF) closes — the same regex shape the view/chart/sheet/csv
    parsers use. User code fences (```ts, ```python foo, …) are prose and stay
    searchable, tail and all. Tails are accepted for the live-dispatch
    languages only, and a tail may not contain a backtick — an inline prose
    mention of a fence opener (`` ```chart `` in running text) must never
    swallow the rest of its line and blank prose to the next fence (SUB-983
    review finding; the guard also closes the same pre-existing leak for
    ```view tails). CRLF openers (```view\r\n) strip too (SUB-913).
    Lockstep twin: machine_fence_re in src-tauri/src/vault/mod.rs — the Rust
    side mirrors these lists by hand; change both together. */
const MACHINE_FENCE_RE = new RegExp(
  "```(?:(?:" +
    TAILED_MACHINE_FENCE_LANGS.join("|") +
    ")(?:[ \\t][^`\\n]*)?|" +
    BARE_MACHINE_FENCE_LANGS.join("|") +
    ")\\r?\\n[\\s\\S]*?(?:```|$)",
  "g"
);

/** `body` with every machine-fence block blanked newline-for-newline, so
    search-result line numbers still map to the raw body (the editor's reveal
    jumps to them). */
export function stripMachineFences(body: string): string {
  return body.replace(MACHINE_FENCE_RE, (m) => "\n".repeat((m.match(/\n/g) ?? []).length));
}
