// Property-key suggestions for the note pane's `+ property` chip.
//
// The chip is a free-text `key: value` field, and the editor below it never
// sees frontmatter — so every frontmatter-keyed capability the app has is
// reachable only by already knowing the key's name. These suggestions are
// that vocabulary, offered while the KEY half is being typed:
//
//   1. the schema keys of the note's own database, which is what a note of
//      that type is overwhelmingly likely to want next, and
//   2. the keys the app itself reads out of any note's frontmatter, each with
//      a one-line hint saying what setting it does.
//
// Keys the note already carries are dropped — the chip adds properties, and a
// second chip for a key that is already a chip writes over it.
//
// Pure TS, no DOM imports: runs in the app and under `node --test`.

import { isReservedSchemaName } from "./schemalookup.ts";
import type { PropKind, PropSchema } from "./types.ts";

export interface KeySuggestion {
  key: string;
  /** one line, shown muted beside the key — what setting this key is */
  hint: string;
}

/** The kind of a schema prop, in the words the schema editor uses for it.
    A prop with its own `description:` shows that instead — the author's
    sentence beats the type name. */
const KIND_HINT: Record<PropKind, string> = {
  text: "Text",
  date: "Date",
  file: "File on disk",
  relation: "Links entries of another database",
  multi: "Several options per entry",
  url: "Web link",
  email: "Email address",
  phone: "Phone number",
  checkbox: "Checkbox",
  number: "Number",
  rollup: "Folds a linked database's values",
};

/** Frontmatter keys the app reads on any note, with what each one does.
    Documented vocabulary only (`docs/vault-format.md` §5.2, §5.4, §5.6a, §5.7
    and §4) — this list is a door into the docs, so a key that has no written
    contract does not belong in it. */
export const APP_KEYS: readonly KeySuggestion[] = [
  { key: "type", hint: "Which database this note is in" },
  { key: "tags", hint: "Tags for search and tag folders" },
  { key: "dashboard", hint: "Render this note as a dashboard" },
  { key: "cards", hint: "A row of bound stat cards" },
  { key: "pages", hint: "Extra pages, as tabs below" },
  { key: "repeat", hint: "Repeat this dated note" },
  { key: "repeat_until", hint: "Last day of the repeat" },
  { key: "repeat_skip", hint: "Dates the repeat skips" },
];

/** Suggestions for a `+ property` draft. Empty while the draft has moved on
    to the VALUE half (a colon has been typed) — the key is settled by then,
    and the value pickers are the chip's own job. */
export function suggestPropKeys(
  draft: string,
  schema: Record<string, PropSchema | undefined> | undefined,
  present: Record<string, unknown>,
  limit = 8
): KeySuggestion[] {
  if (draft.includes(":")) return [];
  const q = draft.trim().toLowerCase();
  const taken = new Set(Object.keys(present).map((k) => k.toLowerCase()));
  const out: KeySuggestion[] = [];
  const seen = new Set<string>();
  const add = (s: KeySuggestion) => {
    const folded = s.key.toLowerCase();
    if (taken.has(folded) || seen.has(folded)) return;
    seen.add(folded);
    out.push(s);
  };
  for (const [key, ps] of Object.entries(schema ?? {})) {
    // the schema's own housekeeping keys are not note properties — folded,
    // like every other reserved-identity read, because schema JSON is
    // hand-authored and a `Icon:` is the same key
    if (isReservedSchemaName(key)) continue;
    add({
      key,
      hint: ps?.description?.trim() || (ps?.kind ? KIND_HINT[ps.kind] : "Text"),
    });
  }
  for (const s of APP_KEYS) add(s);
  // a prefix match is what was meant; a mid-word match still finds
  // `repeat_until` from "until", so it rides behind rather than being dropped
  const hit = (s: KeySuggestion) => (!q ? 0 : s.key.toLowerCase().startsWith(q) ? 0 : 1);
  return out
    .filter((s) => !q || s.key.toLowerCase().includes(q))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => hit(a.s) - hit(b.s) || a.i - b.i)
    .slice(0, limit)
    .map(({ s }) => s);
}
