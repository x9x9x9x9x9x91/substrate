/* Hanging indent for list lines: the pure half — which lines hang and what
   spans of leading text set the hang width. Kept free of CodeMirror so it
   runs under node --test; Editor.tsx measures the spans in the content font
   and applies them as a line decoration.

   Scope is deliberately the plain, space-indented, unquoted list line.
   Quoted lists (`> - x`) are left alone: callout lines hide their quote
   prefix behind a glyph and carry their own CSS padding, so a measured
   indent there would be wrong twice (over-wide by the hidden `> `, and
   clobbering the callout's padding with an inline style). Tab-indented
   lines are left alone too: the browser renders tabs to positional stops
   (`tab-size` on the content), so a fixed per-tab advance mismeasures any
   mixed space+tab indent. (A tab in a hung line's CONTENT still lands on
   padding-shifted stops — narrow enough that vetoing every tab-bearing
   line would be the greater wrong.) */

/** A list line's leading spans: indent in group 1, the bullet/number marker
    in group 2, a task's checkbox — when one follows — in group 3. */
const LIST_PREFIX_RE = /^([ \t]*)((?:[-*+]|\d+[.)])[ \t]+)(\[[ xX]\][ \t]+)?/;

/** A thematic break spelled with spaces (`* * *`, `- - -`) satisfies the
    marker grammar above but is a rule, not a list — the veto mirrors how
    the markdown parser reads it. */
const HR_RE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

export interface ListLinePrefix {
  /** Indent + marker + checkbox, exactly as typed — the hang of a line
      showing its raw source. */
  text: string;
  /** The indent alone. A resting task line renders its marker and checkbox
      as one widget, so its hang is this plus the widget's advance. */
  indent: string;
  /** Whether a task checkbox follows the marker. */
  task: boolean;
}

/** The spans that set `text`'s hanging indent, or null when the line is not
    a plain list line. */
export function listLinePrefix(text: string): ListLinePrefix | null {
  if (HR_RE.test(text)) return null;
  const m = LIST_PREFIX_RE.exec(text);
  if (!m || m[0].includes("\t")) return null;
  return { text: m[0], indent: m[1], task: m[3] !== undefined };
}
