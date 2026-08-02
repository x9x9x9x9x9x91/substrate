/* Extract-selection-into-note (SUB-591): the pure half of the editor's
   selection context menu — deriving a note title from the selected text and
   the link that replaces the selection in the source note. CodeMirror-free
   so it runs under node --test; Editor.tsx wires it to the view. */

/** Block marks stripped from a candidate title line: ATX hashes, list bullets
    (task checkboxes included), ordered markers, quote chevrons and callout
    headers — repeating, so `> ## Title` strips clean too. Same shapes as the
    editor's BLOCK_PREFIX_RE. */
const BLOCK_MARKS_RE =
  /^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*(?:\[!(?:note|warn|idea)\]\s*)?)+/i;

/** Inline marks carry no meaning in a title: links collapse to their label,
    emphasis/code ticks drop. The outline's strip (Editor.tsx), mirrored. */
function stripInline(text: string): string {
  return text
    .replace(/!?(?:\[\[|\[)([^\]]+)(?:\]\]|\]\([^)]*\))/g, "$1")
    .replace(/[*_~`]/g, "");
}

/** Long enough to name the chunk, short enough to live in a wikilink and a
    file list; the cut prefers a word boundary. */
const MAX_TITLE = 60;

/** The new note's proposed title: the selection's first non-blank line with
    block and inline marks stripped, whitespace collapsed, sentence-final
    punctuation dropped (it belongs to the prose, not the name), truncated at
    a word boundary. The engine's create-time sanitize/dedupe may still
    adjust it — callers link with the created meta's title, not this one.
    An empty or all-marks selection falls back to "Untitled". */
export function extractTitle(selected: string): string {
  const line = selected.split("\n").find((l) => l.trim() !== "") ?? "";
  let title = stripInline(line.replace(BLOCK_MARKS_RE, "")).replace(/\s+/g, " ").trim();
  title = title.replace(/[.,;:!?]+$/g, "");
  // the engine refuses both outright (vault.rs validate_note_title), and both
  // are ordinary prose: footnote refs, `array[0]`, `[beta]` tags, `.env`.
  // Stripping here keeps the user off an engine-voiced error for a title they
  // never typed. Before the fallback, so an all-brackets line lands on Untitled.
  title = title.replace(/[[\]]/g, "").replace(/^\.+/, "").replace(/\s+/g, " ").trim();
  if (title.length > MAX_TITLE) {
    // slice by code point at the cut edge — a plain slice can halve a surrogate
    // pair and leave a lone half in the filename
    const cut = Array.from(title).slice(0, MAX_TITLE).join("");
    const word = cut.lastIndexOf(" ");
    title = (word >= MAX_TITLE / 2 ? cut.slice(0, word) : cut).trimEnd();
  }
  return title || "Untitled";
}

/** What replaces the selection in the source note — the vault's wikilink. */
export function extractLink(title: string): string {
  return `[[${title}]]`;
}
