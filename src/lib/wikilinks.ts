/* Wikilink completion: the pure half of the [[ popup — query
   detection, title ranking, insert text — kept free of CodeMirror so it runs
   under node --test. Editor.tsx wraps these in a CompletionSource. */

import { NO_MATCH, fuzzyScore } from "./fuzzy.ts";

/** Cursor inside an open wikilink: `[[` + anything but a bracket or newline. */
const WIKI_OPEN_RE = /\[\[([^\]\n]*)$/;

/** The typed fragment when `textBefore` (doc text up to the cursor) ends
    inside an open `[[…` wikilink, else null. Mirrors the editor's
    matchBefore so ranking stays testable without an EditorState. */
export function wikiLinkQuery(textBefore: string): string | null {
  const m = WIKI_OPEN_RE.exec(textBefore);
  return m ? m[1] : null;
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

/** Insert text for an accepted completion: close the link unless `]]`
    already follows the cursor (don't double-close). */
export function wikiLinkInsert(title: string, following: string): string {
  return following.startsWith("]]") ? title : `${title}]]`;
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

/** Where a `#anchor` lands inside a note's text: the 1-based line of the
    heading it names, or of the block carrying a `^id` ref when the anchor
    starts with `^`. Heading text matches literally, case-insensitively —
    the same rule the wikilink autocomplete offers. Null when nothing in the
    note answers to that name, which is a broken link, not a scroll to the
    top. Fences are skipped: a `# comment` inside a code block is
    code, not a heading. */
export function anchorLine(text: string, anchor: string): number | null {
  const want = anchor.trim().toLowerCase();
  if (!want) return null;
  const lines = text.split("\n");
  if (want.startsWith("^")) {
    const id = want.slice(1);
    for (let i = 0; i < lines.length; i++) {
      // a block ref sits at the end of the block's last line
      if (new RegExp(`\\^${escapeRe(id)}\\s*$`, "i").test(lines[i])) return i + 1;
    }
    return null;
  }
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    // a trailing run of #'s is closing punctuation, not part of the text
    if (m && m[1].replace(/\s*#*\s*$/, "").trim().toLowerCase() === want) return i + 1;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
