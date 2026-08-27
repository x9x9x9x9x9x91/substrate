/**
 * `substrate://view/<name>` — the name half of a deep link, resolved to the
 * view the app opens.
 *
 * The URL itself is parsed in Rust (`src-tauri/src/deeplink.rs`), which is
 * where the scheme arrives and where the traversal and escaping rules for the
 * note route live. What it cannot do is decide what a *name* means: the `View`
 * union is a frontend type, and the destinations a build offers are the
 * palette's own catalogue. So Rust hands the decoded name across untouched and
 * this resolves it — one table, shared with the everywhere palette, rather
 * than a second list of destination names that would drift the first time a
 * surface is added.
 *
 * DOM-free and vault-free on purpose: a link either names a destination this
 * build has or it does not, and that answer never depends on what is loaded.
 */
import { FIXED_VIEW_COMMANDS } from "./palette.ts";
import type { View } from "./types.ts";

/**
 * The spelling two names are compared in: case-folded, trimmed, and with runs
 * of whitespace collapsed. A link is typed by hand into a note or pasted out
 * of a script, so `Vault Doctor`, `vault doctor` and `vault  doctor` are one
 * destination; anything finer would make the feature a spelling test.
 */
export function normalizeViewName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Every fixed destination this build can be linked to, under both spellings
 * it answers to: the words the palette shows ("Scratch") and the view kind
 * behind them ("notes"). The kind is the stable one — a script writing links
 * wants a name that survives a relabel — and the words are the one a person
 * types without looking anything up. Kinds register first, so on the one
 * collision the relabel created ("Notes", the vault-wide list's label,
 * normalizes to the kind token "notes") the kind wins and the vault-wide
 * list answers to its kind, "all".
 *
 * Machine-gated destinations stay out, exactly as they do in the palette's
 * own row set: with the switch off the surface does not exist, and a link to
 * it could only open a pane that reports "not here".
 */
function linkableViews(): { name: string; view: View }[] {
  const out: { name: string; view: View }[] = [];
  for (const c of FIXED_VIEW_COMMANDS) {
    const available =
      !c.when ||
      c.when({
        proxyAvailable: false,
      });
    if (!available) continue;
    out.push({ name: normalizeViewName(c.view.kind), view: c.view });
    if (c.dest) {
      const dest = normalizeViewName(c.dest);
      if (dest !== normalizeViewName(c.view.kind)) out.push({ name: dest, view: c.view });
    }
  }
  return out;
}

/**
 * Resolve a `substrate://view/<name>` name, or `null` when this build has no
 * destination by that name. Null is a message, never a crash and never
 * silence — the caller says so out loud, because "the link did nothing" is the
 * outcome the deeplink contract rules out.
 */
export function resolveViewName(raw: string): View | null {
  const wanted = normalizeViewName(raw);
  if (!wanted) return null;
  return linkableViews().find((v) => v.name === wanted)?.view ?? null;
}

/** What to show when a link named a destination that isn't here. */
export function unknownViewMessage(raw: string): string {
  return `Substrate has no view called “${raw.trim()}”.`;
}
