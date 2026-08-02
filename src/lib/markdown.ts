/** List-marker shapes shared by the editor's task decorations. Both allow
 *  blockquote markers (`> `) between the indent and the bullet so quoted
 *  tasks (`> - [ ]`) position and toggle like plain ones; the quote markers
 *  are part of the capture, so replacing from the capture's end leaves them
 *  in place. */

/** Text between line start and a task's `[ ]` marker: indent + any quote
 *  markers in group 1, the bullet/number marker with trailing space in 2. */
export const TASK_PREFIX_RE = /^([ \t]*(?:>[ \t]*)*)((?:[-*+]|\d+[.)])[ \t]+)$/;

/** A task line's prefix through the checkbox state character: everything up
 *  to `[` in group 1, the state (` `/`x`) in 2. */
export const TASK_RE = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\]/;
