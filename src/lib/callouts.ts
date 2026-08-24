/* Callout header completion: the pure half of the `> [!` popup — which slot
   the cursor is in, what each slot offers, and the text an accept writes.
   Kept free of CodeMirror so it runs under node --test; Editor.tsx wraps
   these in a CompletionSource.

   The grammar is the one the editor already renders and hub.ts already reads
   (vault-format.md §5.3a): `> [!kind] Title`, with an optional `|accent`
   naming one of the ten roster hues. Both halves were memory-only — the
   Turn-into menu writes bare kinds and nothing ever names an accent. */

import { NO_MATCH, fuzzyScore } from "./fuzzy.ts";
import { ACCENT_NAMES } from "./styletokens.ts";

/** The three callout kinds, in the order the Turn-into menu lists them —
    one source for what a kind may be, mirroring CALLOUT_HEADER_RE in
    Editor.tsx and the same list hub.ts parses. */
const CALLOUT_KINDS: { name: string; detail: string }[] = [
  { name: "note", detail: "an aside" },
  { name: "warn", detail: "a caution" },
  { name: "idea", detail: "a suggestion" },
];

export interface CalloutQuery {
  /** `kind` — after `> [!`; `accent` — after a kind's `|` */
  slot: "kind" | "accent";
  /** what was typed in this slot: the span a popup replaces */
  query: string;
}

/** Cursor after `> [!` on a blockquote line, with only the kind typed. */
const KIND_RE = /(?:^|\n)[ \t]*>[ \t]*\[!([A-Za-z]*)$/;
/** …and after a complete kind's `|`, with only the accent name typed. */
const ACCENT_RE = /(?:^|\n)[ \t]*>[ \t]*\[!(?:note|warn|idea)\|([A-Za-z]*)$/i;

/** Which callout slot `textBefore` (doc text up to the cursor) ends in, or
    null for neither. The accent test runs first: `[!note|te` satisfies
    neither pattern's other reading, but ordering says out loud that a typed
    `|` has left the kind slot for good. */
export function calloutQuery(textBefore: string): CalloutQuery | null {
  const accent = ACCENT_RE.exec(textBefore);
  if (accent) return { slot: "accent", query: accent[1] };
  const kind = KIND_RE.exec(textBefore);
  if (kind) return { slot: "kind", query: kind[1] };
  return null;
}

/** The kinds a `> [!` popup offers, roster order kept — three items rank
    themselves. */
export function calloutKindOptions(query: string): { name: string; detail: string }[] {
  return CALLOUT_KINDS.filter((kind) => fuzzyScore(query, kind.name) !== NO_MATCH);
}

/** The accents a `> [!note|` popup offers: the ten roster names, roster
    order kept (it is a palette, and alphabetising a palette hides that gray
    is the quiet one). Nothing else is offered because nothing else is
    honoured — an off-roster name leaves the callout unaccented. */
export function calloutAccentOptions(query: string): string[] {
  return ACCENT_NAMES.filter((name) => fuzzyScore(query, name) !== NO_MATCH);
}

/** Insert text for an accepted kind or accent: close the header unless the
    rest of it is already there (don't double-close, and never strand the
    accent of a kind being retyped), and leave a space after the `]` because a
    title comes next.

    A kind accept deliberately stops at the `]` rather than writing `|` too:
    an accent is optional decoration, and the popup for it is one keystroke
    away for anyone who wants it. */
export function calloutInsert(name: string, following: string): string {
  return following.startsWith("]") || following.startsWith("|") ? name : `${name}] `;
}
