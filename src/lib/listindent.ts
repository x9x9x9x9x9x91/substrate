/* Hanging indent for list lines: the pure half — which lines hang, what
   spans of leading text set the hang width, and how a span's advance is
   walked when tabs are in it. Kept free of CodeMirror so it runs under
   node --test; Editor.tsx measures the runs in the content font and applies
   the result as a line decoration.

   Scope is deliberately the plain, unquoted list line. Quoted lists
   (`> - x`) are left alone: callout lines hide their quote prefix behind a
   glyph and carry their own CSS padding, so a measured indent there would
   be wrong twice (over-wide by the hidden `> `, and clobbering the
   callout's padding with an inline style). Tabs in the prefix ARE in scope
   — walkSpan below lays them out on the stops an unpadded line would use,
   and the measuring half pins each one to that advance so the browser's own
   stops never get a say. (A tab in a hung line's CONTENT still lands on
   padding-shifted stops — narrow enough that vetoing every tab-bearing line
   would be the greater wrong.) */

/** A list line's leading spans: indent in group 1, the bullet/number marker
    in group 2, a task's checkbox — when one follows — in group 3. */
const LIST_PREFIX_RE = /^([ \t]*)((?:[-*+]|\d+[.)])[ \t]+)(\[[ xX]\][ \t]+)?/;

/** A thematic break spelled with spaces (`* * *`, `- - -`) satisfies the
    marker grammar above but is a rule, not a list — the veto mirrors how
    the markdown parser reads it. Tabs count in the lead too, so a
    tab-indented rule stays a rule now that tab prefixes hang. */
const HR_RE = /^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

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
  if (!m) return null;
  return { text: m[0], indent: m[1], task: m[3] !== undefined };
}

/** A tab met while walking a span: its offset in the line, and the width it
    has to render at for the walk's arithmetic to hold. */
export interface TabPin {
  at: number;
  width: number;
}

/** The advance of `span` laid out from `from` px, tabs snapping to the next
    multiple of `stop`. Runs of ordinary text are handed to `measure` (the
    caller owns the font); every tab is appended to `pins` at its offset in
    the line, `at` being where `span` itself starts.

    Walking rather than measuring the prefix whole is what lets a tab-indented
    line hang at all: a text-measuring API has no notion of a tab stop, and a
    fixed per-tab advance mismeasures the moment spaces and tabs are mixed. */
export function walkSpan(
  span: string,
  at: number,
  from: number,
  stop: number,
  measure: (run: string) => number,
  pins: TabPin[]
): number {
  let x = from;
  let run = 0;
  for (let i = 0; i < span.length; i++) {
    if (span[i] !== "\t") continue;
    if (i > run) x += measure(span.slice(run, i));
    // the NEXT stop, strictly: a tab already sitting on one advances a whole
    // stop rather than rendering as nothing. "Sitting on one" is decided at
    // the measuring grain: run widths and the stop round to 0.01px
    // independently, so a run that is exactly on a stop in the browser can
    // read a hundredth or two short of it here — a bare floor would then
    // hand the tab that sliver instead of a whole stop. Anything within the
    // epsilon of a stop counts as on it.
    const next = stop > 0 ? Math.floor((x + 0.05) / stop) * stop + stop : x;
    pins.push({ at: at + i, width: Math.round((next - x) * 100) / 100 });
    x = next;
    run = i + 1;
  }
  if (run < span.length) x += measure(span.slice(run));
  return x;
}
