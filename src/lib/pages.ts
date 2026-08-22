// Workbook pages: a `pages:` frontmatter list turns any dashboard
// into a multi-page workbook with an Excel-style tab strip at the bottom of
// the pane. Tab 0 is always the note itself, rendered by its own dashboard:
// kind; each entry adds one tab:
//
//   pages:
//     - label: Statements
//       note: Label Statements       # a sheet (editable) or dashboard note
//     - label: Releases
//       view: release                # a database type…
//       query: status:live           # …optionally filtered
//     - label: Unreleased
//       saved: umbra-unreleased      # or a pinned view by id/name
//
// Parsing is tolerant the way cards: parsing is — a malformed entry becomes
// an error page in place (the chart-fence convention: it never breaks its
// siblings), and unknown keys are ignored for forward compat.
//
// Pure TS, no DOM imports: runs in the app and under `node --test`.

import { parseViewSpec, type EmbedSpec } from "./embeds.ts";
import { byFoldedKey } from "./schemalookup.ts";

export type PageEntry =
  | { kind: "note"; label: string; note: string }
  | { kind: "view"; label: string; spec: EmbedSpec }
  | { kind: "saved"; label: string; spec: EmbedSpec }
  | { kind: "error"; label: string; error: string };

const PAGE_VIEW_KEYS = ["query", "sort", "limit", "columns"] as const;

/** Adapt a workbook page map into the same parser used by ```view fences.
    YAML naturally decodes an unquoted limit as a number and a conventional
    columns list as string[]; scalar options stay strings. Unknown page keys
    remain ignored for the workbook's forward-compat contract. */
function pageViewSpec(
  o: Record<string, unknown>,
  target: { key: "type" | "saved"; value: string }
): EmbedSpec | { error: string } {
  if (/[\r\n]/.test(target.value)) {
    return { error: `${target.key}: must stay on one line` };
  }
  const lines = [`${target.key}: ${target.value}`];
  for (const key of PAGE_VIEW_KEYS) {
    const raw = o[key];
    if (raw === undefined) continue;
    // query predates the validating options and non-string values were
    // historically ignored; preserve that tolerant workbook behavior.
    if (key === "query" && typeof raw !== "string") continue;
    if (key === "limit" && typeof raw === "number") {
      lines.push(`${key}: ${raw}`);
    } else if (key === "columns" && Array.isArray(raw)) {
      if (!raw.every((item) => typeof item === "string")) {
        return { error: "columns: list items must be text" };
      }
      if (raw.some((item) => /[\r\n]/.test(item))) {
        return { error: "columns: must stay on one line" };
      }
      // Keep one source of syntax truth: the adapter only serializes the
      // natural YAML shape, then the shared fence parser validates it.
      lines.push(`${key}: ${raw.join(", ")}`);
    } else if (typeof raw === "string") {
      if (/[\r\n]/.test(raw)) return { error: `${key}: must stay on one line` };
      lines.push(`${key}: ${raw}`);
    } else {
      return {
        error:
          key === "limit"
            ? "limit: must be a positive whole number"
            : `${key}: must be quoted text`,
      };
    }
  }
  return parseViewSpec(lines.join("\n"));
}

/** Parse the `pages:` prop into page entries. An absent `pages:` means no
    tabs — the dashboard renders exactly as before. A `pages:` that is PRESENT
    but is not a list used to mean the same thing, so a note carrying
    `pages: Statements` rendered as though it had never asked for pages at all,
    with nothing anywhere to say the line had been read and discarded. That
    one becomes an error page, which is what a malformed entry inside the list
    already becomes. */
export function parsePages(props: Record<string, unknown>): PageEntry[] {
  // config keys fold like every prop read — cased YAML still counts
  const raw = byFoldedKey(props, "pages");
  if (!Array.isArray(raw)) {
    if (raw === undefined || raw === null) return [];
    return [
      {
        kind: "error",
        label: "Pages",
        error: `pages: is not a list — write each page as a "- label:" entry`,
      },
    ];
  }
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
      const spec = pageViewSpec(o, { key: "type", value: view });
      out.push(
        "error" in spec
          ? { kind: "error", label, error: spec.error }
          : { kind: "view", label, spec }
      );
    } else {
      const spec = pageViewSpec(o, { key: "saved", value: saved! });
      out.push(
        "error" in spec
          ? { kind: "error", label, error: spec.error }
          : { kind: "saved", label, spec }
      );
    }
  }
  return out;
}
