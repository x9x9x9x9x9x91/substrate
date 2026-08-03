// Workbook pages (SUB-464): a `pages:` frontmatter list turns any dashboard
// into a multi-page workbook with an Excel-style tab strip at the bottom of
// the pane. Tab 0 is always the note itself, rendered by its own dashboard:
// kind; each entry adds one tab:
//
//   pages:
//     - label: Statements
//       note: Label Statements       # a sheet (editable) or dashboard note
//     - label: Releases
//       view: release                # a database type…
//       query: status:live           # …optionally filtered (SUB-7 language)
//     - label: Unreleased
//       saved: umbra-unreleased      # or a pinned view by id/name
//
// Parsing is tolerant the way cards: parsing is — a malformed entry becomes
// an error page in place (the chart-fence convention: it never breaks its
// siblings), and unknown keys are ignored for forward compat.
//
// Pure TS, no DOM imports: runs in the app and under `node --test`.

import { byFoldedKey } from "./schemalookup.ts";

export type PageEntry =
  | { kind: "note"; label: string; note: string }
  | { kind: "view"; label: string; view: string; query?: string }
  | { kind: "saved"; label: string; saved: string }
  | { kind: "error"; label: string; error: string };

/** Parse the `pages:` prop into page entries. Not-a-list (or an empty list)
    means no tabs — the dashboard renders exactly as before. */
export function parsePages(props: Record<string, unknown>): PageEntry[] {
  // config keys fold like every prop read (SUB-921) — cased YAML still counts
  const raw = byFoldedKey(props, "pages");
  if (!Array.isArray(raw)) return [];
  const out: PageEntry[] = [];
  for (const [i, p] of raw.entries()) {
    if (typeof p !== "object" || p === null) {
      out.push({ kind: "error", label: `Page ${i + 1}`, error: "not a map — want label + note/view/saved" });
      continue;
    }
    const o = p as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() !== "" ? (o[k] as string).trim() : undefined);
    const note = str("note");
    const view = str("view");
    const saved = str("saved");
    const label = str("label") ?? note ?? view ?? saved ?? `Page ${i + 1}`;
    const targets = [note, view, saved].filter((t) => t !== undefined).length;
    if (targets === 0) {
      out.push({ kind: "error", label, error: "add a note:, view:, or saved: line" });
    } else if (targets > 1) {
      out.push({ kind: "error", label, error: "pick ONE of note:, view:, saved:" });
    } else if (note !== undefined) {
      out.push({ kind: "note", label, note });
    } else if (view !== undefined) {
      out.push({ kind: "view", label, view, query: str("query") });
    } else {
      out.push({ kind: "saved", label, saved: saved! });
    }
  }
  return out;
}
