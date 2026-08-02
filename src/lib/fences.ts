// Machine fences (```view / ```chart / ```csv / ```formulas) hold app-parsed
// config/data, not prose (vault-format §5) — their bodies stay out of search
// indexing (SUB-261). Mirrors strip_machine_fences in src-tauri/src/vault.rs;
// keep the fence set and semantics in lockstep with it.

/** The app parsers' fence semantics: "```<lang>\n" anywhere opens, the next
    "```" (or EOF) closes — the same regex shape the view/chart/sheet/csv
    parsers use. User code fences (```ts, …) are prose and stay searchable. */
const MACHINE_FENCE_RE = /```(?:view|chart|csv|formulas)\n[\s\S]*?(?:```|$)/g;

/** `body` with every machine-fence block blanked newline-for-newline, so
    search-result line numbers still map to the raw body (the editor's reveal
    jumps to them). */
export function stripMachineFences(body: string): string {
  return body.replace(MACHINE_FENCE_RE, (m) => "\n".repeat((m.match(/\n/g) ?? []).length));
}
