/* Wikilink completion: the pure half of the [[ popup — query
   detection, title ranking, insert text — kept free of CodeMirror so it runs
   under node --test. Editor.tsx wraps these in a CompletionSource. */

import { NO_MATCH, fuzzyScore } from "./fuzzy.ts";

/** Cursor inside an open wikilink: an optional `!` (an embed), `[[`, then
    anything but a bracket or newline. */
const WIKI_OPEN_RE = /(!?)\[\[([^\]\n]*)$/;

/** Which half of the grammar the cursor is in — each one completes from a
    different vocabulary:

    - `target` — the note (or, in an embed, the file) being named.
    - `anchor` — a `#` tail on a wikilink: a heading in the target note, or a
      `^id` block ref. An EMPTY target here means the note the link sits in.
    - `alias` — past the first `|` of a wikilink: the author's display text.
      Prose, so this is a suggestion of the obvious labels, never a roster.
    - `modifier` — past a `|` of an EMBED: the size/layout hint. An embed has
      no anchor semantics (a filename may contain `#`), so `#` never gets here. */
export type WikiSlot = "target" | "anchor" | "alias" | "modifier";

export interface WikiContext {
  slot: WikiSlot;
  /** the name before any `#`/`|`, trimmed — "" for a same-note anchor */
  target: string;
  /** the anchor typed so far, without its `#`; null when none was */
  anchor: string | null;
  /** what was typed in THIS slot — the fragment a popup filters on, and
      exactly the span it replaces, so it is never trimmed */
  query: string;
  /** `![[…` rather than `[[…` */
  embed: boolean;
}

/** Where the cursor sits inside an open `[[…`/`![[…`, or null when it sits in
    neither. The split rules are {@link parseWikiLink}'s and
    {@link embedTarget}'s, read from the left instead of a finished link — so
    the popup a slot opens completes the same text the parser will read back. */
export function wikiLinkContext(textBefore: string): WikiContext | null {
  const m = WIKI_OPEN_RE.exec(textBefore);
  if (!m) return null;
  const embed = m[1] === "!";
  const inner = m[2];
  const pipe = inner.indexOf("|");
  if (pipe >= 0) {
    const head = inner.slice(0, pipe);
    const hash = embed ? -1 : head.indexOf("#");
    // a modifier is a `|`-separated list (`|300|left`) — the LAST segment is
    // the one being typed; an alias is prose, and all of it is the label
    const rest = inner.slice(pipe + 1);
    const seg = embed ? rest.slice(rest.lastIndexOf("|") + 1) : rest;
    return {
      slot: embed ? "modifier" : "alias",
      target: (hash < 0 ? head : head.slice(0, hash)).trim(),
      anchor: hash < 0 ? null : head.slice(hash + 1).trim(),
      query: seg,
      embed,
    };
  }
  const hash = embed ? -1 : inner.indexOf("#");
  if (hash < 0) return { slot: "target", target: inner.trim(), anchor: null, query: inner, embed };
  return {
    slot: "anchor",
    target: inner.slice(0, hash).trim(),
    anchor: inner.slice(hash + 1).trim(),
    query: inner.slice(hash + 1),
    embed,
  };
}

export interface WikiOption {
  title: string;
  score: number;
}

/** keep the popup snappy on large vaults — the fuzzy tail past this is noise */
const MAX_OPTIONS = 100;

/** Titles ranked for the [[ popup: fuzzy score descending, alphabetical
    tiebreak; misses and duplicate titles dropped. An empty query lists
    every title A→Z (fuzzyScore("") is a flat 1, the tiebreak sorts). */
export function wikiLinkOptions(query: string, titles: string[]): WikiOption[] {
  const seen = new Set<string>();
  const out: WikiOption[] = [];
  for (const raw of titles) {
    const title = raw.trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const score = fuzzyScore(query, title);
    if (score === NO_MATCH) continue;
    out.push({ title, score });
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return out.slice(0, MAX_OPTIONS);
}

/** Insert text for an accepted completion: close the link unless the link is
    ALREADY closed further along (don't double-close).

    `following` is the text after the accepted span, and the closer may sit
    past an alias the author wrote first — completing the anchor of
    `[[Welcome|Alias]]` reads `|Alias]]` here, and appending a second `]]`
    would write `[[Welcome#Anchor]]|Alias]]`. So the scan runs to the link's
    end: the first `]]` closes it, while a newline or the `[[` of the NEXT
    link means this one is still open and the closer is ours to write. A `|`
    on its own decides nothing — in a table row (`| [[Alp | next |`) it is
    the cell wall, not this link's alias. */
export function wikiLinkInsert(title: string, following: string): string {
  const stop = /\n|\[\[|\]\]/.exec(following);
  return stop && stop[0] === "]]" ? title : `${title}]]`;
}

export interface WikiLinkParts {
  /** the note name — what resolution matches on ("" for a same-note anchor) */
  target: string;
  /** heading (or `^block`) inside the target note, without the `#` */
  anchor: string | null;
  /** the author's display text, without the `|` */
  alias: string | null;
}

/** The three parts of a wikilink's inner text, `[[target#anchor|alias]]`.
    The alias is everything past the FIRST `|`; the anchor is a
    `#` tail on what's left. Every piece is trimmed; an absent one is null,
    and an empty target (`[[#Notes]]`) points inside the note it sits in.

    Twin of `split_wikilink` in `src-tauri/src/vault/mod.rs` — the two must
    agree, or the frontend follows a link the engine never indexed. */
export function parseWikiLink(inner: string): WikiLinkParts {
  const pipe = inner.indexOf("|");
  const head = pipe < 0 ? inner : inner.slice(0, pipe);
  const alias = pipe < 0 ? null : inner.slice(pipe + 1).trim();
  const hash = head.indexOf("#");
  const target = (hash < 0 ? head : head.slice(0, hash)).trim();
  const anchor = hash < 0 ? null : head.slice(hash + 1).trim();
  return { target, anchor, alias };
}

/** The file an `![[…]]` embed names, with any display modifier dropped.
    The modifier is everything past the FIRST `|` — a size or
    layout hint (`|300`, `|300x200`, `|left`) in the Obsidian dialect these
    vaults are written in. `![[cover.png|300]]` names `cover.png`; without this
    split every reader looks for a file literally called `cover.png|300` and
    renders a present image as missing.

    Substrate HONOURS the size half of the modifier (see `embedSize`) and
    ignores layout hints like `|left`; either way the hint never reaches the
    filename.

    Unlike `parseWikiLink` this does NOT split on `#`: an embed target is a
    filename or a path, both of which may legally contain `#`, and an embed has
    no anchor semantics to spend it on.

    Twin of `embed_target` in `src-tauri/src/vault/mod.rs` — the two must
    agree, or the app renders an asset the engine reports orphaned. */
export function embedTarget(inner: string): string {
  const pipe = inner.indexOf("|");
  return (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
}

/** The display size an embed's modifier asks for, in CSS pixels. `width`
    caps the rendered width; `height`, when the author wrote `WxH`, caps the
    height too — together they BOX the image, which scales to fit inside
    without distorting. */
export interface EmbedSize {
  width: number;
  height: number | null;
}

/** Nothing sane renders wider than this, and a typo (`![[a.png|30000]]`)
    should not blow the layout out — clamp rather than reject, so the embed
    still shows at a usable size. */
const MAX_EMBED_PX = 4096;

const WIDTH_RE = /^(\d+)$/;
const BOX_RE = /^(\d+)[xX](\d+)$/;

/** The size an `![[file|modifier]]` embed asks to render at, or null when the
    modifier names none.

    The grammar is Obsidian's, and it is deliberately tiny:
      - `|300`      → max width 300px, aspect ratio preserved
      - `|300x200`  → fit inside a 300×200 box, aspect ratio preserved
      - anything else — `|left`, `|right`, `|axb`, `|300x`, `|0`, `|-3`, an
        empty modifier — is PARSED AND IGNORED, never an error. Float hints in
        particular are recognised syntax Substrate declines to act on: no
        text-wrap layout is committed to.

    A multi-part modifier (`|300|left`) is read segment by segment, first size
    wins, so a float sitting beside a width does not cost the width. Values are
    clamped to [1, {@link MAX_EMBED_PX}] — a garbage number degrades to a big
    image, never to a broken or absent one.

    Twin of `embed_size` in `src-tauri/src/vault/mod.rs` — the two must agree,
    or a note renders at one size in the app and another everywhere else. */
export function embedSize(inner: string): EmbedSize | null {
  const pipe = inner.indexOf("|");
  if (pipe < 0) return null;
  for (const raw of inner.slice(pipe + 1).split("|")) {
    const seg = raw.trim();
    const box = BOX_RE.exec(seg);
    if (box) {
      const w = clampPx(box[1]);
      const h = clampPx(box[2]);
      if (w && h) return { width: w, height: h };
      continue;
    }
    const wide = WIDTH_RE.exec(seg);
    if (wide) {
      const w = clampPx(wide[1]);
      if (w) return { width: w, height: null };
    }
  }
  return null;
}

/** A digit run as a usable pixel count, or 0 when it names none (`0`, or a
    number so long it overflows). Negatives never reach here — the `-` fails
    the digits-only match, which is what makes `|-3` an ignored hint. */
function clampPx(digits: string): number {
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(Math.round(n), MAX_EMBED_PX);
}

/** {@link embedSize} as the CSS an `<img>` needs to honour it: caps, never
    fixed dimensions, so the image scales down inside its container and keeps
    its aspect ratio. Empty for an unsized embed, which then falls back to the
    stylesheet's defaults. */
export function embedSizeStyle(size: EmbedSize | null): {
  maxWidth?: string;
  maxHeight?: string;
} {
  if (!size) return {};
  return size.height === null
    ? { maxWidth: `${size.width}px` }
    : { maxWidth: `${size.width}px`, maxHeight: `${size.height}px` };
}

/** What a wikilink SHOWS: the alias when the author wrote one, else the
    target with its anchor (`Piranesi#Notes` reads as one label). Never the
    raw inner text — the pipe is syntax, not prose. */
export function wikiLinkDisplay(inner: string): string {
  const { target, anchor, alias } = parseWikiLink(inner);
  if (alias) return alias;
  return anchor ? `${target}#${anchor}` : target;
}

/** One thing a `#anchor` can name inside a note. */
export interface AnchorTarget {
  /** what an author writes after the `#` — a heading's text, or `^id` */
  anchor: string;
  kind: "heading" | "block";
  /** heading depth, 1-6; absent for a block ref */
  level?: number;
  /** 1-based line the anchor lands on */
  line: number;
}

/** A trailing `^id` is a block ref, and it sits at the end of the block's
    last line. The caret must open a word — `x^2` at the end of a line is an
    exponent, and offering "^2" as a jump target (or resolving one) reads
    prose as syntax. */
const BLOCK_REF_RE = /(?:^|\s)\^([^\s^]+)\s*$/;

/** Every anchor a note answers to, in document order: its headings, and the
    blocks carrying a `^id` ref. This is the LIST behind the `[[Target#`
    popup, and {@link anchorLine} resolves against the same scan — so the
    popup can never offer an anchor that then fails to scroll, nor hide one
    that would have worked.

    Fences are skipped for headings: a `# comment` inside a code block is
    code, not a heading. A block ref is matched anywhere, fences included,
    because that is where a `^id` is legal to sit. */
export function anchorTargets(text: string): AnchorTarget[] {
  const out: AnchorTarget[] = [];
  const lines = text.split("\n");
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const block = BLOCK_REF_RE.exec(line);
    if (block) out.push({ anchor: `^${block[1]}`, kind: "block", line: i + 1 });
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    // a trailing run of #'s is closing punctuation, not part of the text
    const heading = m[2].replace(/\s*#*\s*$/, "").trim();
    if (heading) out.push({ anchor: heading, kind: "heading", level: m[1].length, line: i + 1 });
  }
  return out;
}

/** Where a `#anchor` lands inside a note's text: the 1-based line of the
    heading it names, or of the block carrying a `^id` ref when the anchor
    starts with `^`. Heading text matches literally, case-insensitively —
    the same rule the wikilink autocomplete offers, because both read
    {@link anchorTargets}. Null when nothing in the note answers to that name,
    which is a broken link, not a scroll to the top. */
export function anchorLine(text: string, anchor: string): number | null {
  const want = anchor.trim().toLowerCase();
  if (!want) return null;
  const wantBlock = want.startsWith("^");
  for (const target of anchorTargets(text)) {
    if ((target.kind === "block") !== wantBlock) continue;
    if (target.anchor.toLowerCase() === want) return target.line;
  }
  return null;
}

/** An anchor the link grammar can actually spell. `[[…]]` is
    `\[\[([^\[\]]+)\]\]` and the alias is everything past the first `|`
    (vault-format.md §3) — with no escape for any of the three, so a heading
    carrying `|`, `[` or `]` cannot be named after a `#`: `# Sales | 2026`
    would write `[[Note#Sales | 2026]]`, which parses as anchor `Sales` plus
    alias `2026` and scrolls nowhere, and a `]` breaks the link outright.
    Such a heading is dropped from the POPUP only — {@link anchorLine} still
    resolves one if a vault written elsewhere carries it. */
const ANCHOR_NAMEABLE = /^[^|[\]]+$/;

/** {@link anchorTargets} ranked for the `[[Target#` popup: fuzzy score
    descending, DOCUMENT order as the tiebreak — a note's outline is the
    order its author chose, and an empty query (`fuzzyScore("")` is a flat 1)
    should read as that outline rather than as an alphabetised pile. */
export function anchorOptions(query: string, targets: AnchorTarget[]): AnchorTarget[] {
  const seen = new Set<string>();
  const scored: { target: AnchorTarget; score: number; index: number }[] = [];
  targets.forEach((target, index) => {
    if (!ANCHOR_NAMEABLE.test(target.anchor)) return;
    const key = `${target.kind}:${target.anchor.toLowerCase()}`;
    // two headings with the same text resolve to the first one either way
    if (seen.has(key)) return;
    seen.add(key);
    const score = fuzzyScore(query, target.anchor);
    if (score === NO_MATCH) return;
    scored.push({ target, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, MAX_OPTIONS).map((s) => s.target);
}

/** What an embed's display modifier can say, in the order the popup lists
    them. The grammar is Obsidian's and {@link embedSize} is what honours it:
    the numbers are acted on, the float hints are recognised and declined —
    which the detail says out loud, so picking one is never a silent no-op.
    The numbers are TEMPLATES: 300 is a sane starting width to edit, not a
    value the vault believes in. */
const EMBED_MODIFIERS: { name: string; detail: string }[] = [
  { name: "300", detail: "max width, px" },
  { name: "300x200", detail: "fit inside a box, px" },
  { name: "left", detail: "float hint — not honoured" },
  { name: "right", detail: "float hint — not honoured" },
];

/** The modifier roster filtered by what's typed, roster order kept — a
    four-item list has no ranking worth doing. */
export function embedModifierOptions(query: string): { name: string; detail: string }[] {
  return EMBED_MODIFIERS.filter((mod) => fuzzyScore(query, mod.name) !== NO_MATCH);
}

/** What to offer past a wikilink's `|`. An alias is PROSE — there is no
    roster to complete from — so this offers only the labels already implied
    by the link: the target, and the anchor when one was typed. Anything else
    the author means, they type over the top of. */
export function aliasSuggestions(query: string, target: string, anchor: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const both = target && anchor ? `${target}#${anchor}` : "";
  for (const candidate of [target, anchor ?? "", both]) {
    const name = candidate.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (fuzzyScore(query, name) !== NO_MATCH) out.push(name);
  }
  return out;
}
