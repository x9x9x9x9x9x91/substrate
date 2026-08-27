/* The machine-fence registry: every fence language the app parses, declared
   once (vault-format §5). Each entry answers the questions a fence's readers
   used to answer separately, in as many files — which group its opener
   belongs to (tailed vs bare), whether its dispatch folds case, what noun the
   docs and the editor's hint call it, and whether the hub canvas draws it
   live. `fences.ts` builds the strip pattern from these entries,
   `dashfencehint.ts` takes its nouns, and the dashboard body-scan takes the
   hub set — so adding a fence starts here, and the derived surfaces follow.

   Adding a fence is documented end to end in docs/dashboards.md ("Adding a
   fence"). The short version: add the entry here, mirror the id into the Rust
   twin (machine_fence_re in src-tauri/src/vault/mod.rs — check-fence-langs
   fails `npm test` until both sides agree), write the parser and renderer,
   dispatch it in HubDashboard's renderMarkdown, and give it a /slash
   scaffold in slashmenu.ts.

   This module is DATA ONLY and must import nothing from fences.ts (or
   anything that reaches it): fences.ts reads these entries at module load to
   assemble MACHINE_FENCE_RE, and it sits in the boot bundle (src/lib/
   tauri.ts), so a cycle back into it is a ReferenceError before the first
   frame renders.

   ENTRY ORDER IS LOAD-BEARING within each form group. The strip pattern
   joins each group's ids in this order, and scripts/check-fence-langs.ts
   compares that pattern character for character against the Rust twin —
   reordering entries here reds the lockstep check until the Rust side is
   reordered with it. */

export type FenceForm = "tailed" | "bare";

export interface FenceEntry {
  /** The lang id as typed after the opening backticks. */
  id: string;
  /** tailed: dispatched on the FIRST WORD of the info string, so ```view
      table renders live. bare: the strict bare opener only — a tailed one is
      someone's prose (isTailedBareFence in fences.ts owns that rule). */
  form: FenceForm;
  /** Whether this lang's dispatchers lowercase before matching, so the strip
      pattern must fold its spelling. A separate axis from `form` — the long
      rationale (which reader folds, and why the strip follows the widest
      one) lives with the pattern in fences.ts. */
  foldsCase: boolean;
  /** The noun the docs and the editor's out-of-place hint use for it, or
      null when no hint belongs: `view` draws in an ordinary note already,
      and csv/formulas are a sheet's own content, not a dashboard's. */
  noun: string | null;
  /** Whether the hub canvas (renderMarkdown in HubDashboard.tsx) mounts it
      as a live widget. Everything but the sheet pair. This is also the set
      that anchors a keyless dashboard's body-scan fallback: a note carrying
      any of these has something a board can draw. */
  hub: boolean;
}

export const FENCE_REGISTRY: readonly FenceEntry[] = [
  // ── tailed (live-dispatch) ────────────────────────────────────────────
  { id: "view", form: "tailed", foldsCase: true, noun: null, hub: true },
  { id: "chart", form: "tailed", foldsCase: true, noun: "A chart", hub: true },
  { id: "progress", form: "tailed", foldsCase: true, noun: "A goal thermometer", hub: true },
  { id: "cards", form: "tailed", foldsCase: true, noun: "A stat-card row", hub: true },
  // ── bare (strict bare-form parsers) ───────────────────────────────────
  { id: "csv", form: "bare", foldsCase: false, noun: null, hub: false },
  { id: "formulas", form: "bare", foldsCase: false, noun: null, hub: false },
  { id: "heatmap", form: "bare", foldsCase: true, noun: "A heatmap", hub: true },
  { id: "calendar", form: "bare", foldsCase: true, noun: "A calendar", hub: true },
  { id: "timeline", form: "bare", foldsCase: true, noun: "A timeline", hub: true },
];

/** The lang ids the hub canvas draws live, in registry order — the fences
    that make a keyless dashboard note renderable. */
export const HUB_FENCE_LANGS: readonly string[] = FENCE_REGISTRY.filter((f) => f.hub).map(
  (f) => f.id
);
