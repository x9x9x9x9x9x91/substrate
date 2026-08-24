/** Pipe-table surgery as plain strings: every edit a rendered table needs
 * (one more row or column, one fewer, a column's alignment, one cell's text)
 * plus the row splitter both the renderer and the edits parse cells with. No
 * DOM, no editor — the widget applies the result as a single document change,
 * so an added row lands in the same ⌘Z stack as typing the pipes by hand
 * would.
 *
 * Growing appends and so can build its rows from scratch; every other edit
 * splices the source in place, because a table someone has been typing in by
 * hand carries their spacing and an edit that reflowed it would read as the
 * app rewriting their file. `cellSpans` is what makes that possible: the same
 * scan `splitRow` reads cells with, but keeping where each one sat. */

/** One cell as the row scanner sees it: the text it holds (escapes already
 * resolved, so `\\|` is a plain pipe) and the span it occupies in the line,
 * `to` sitting on the `|` that closes it (or at the line's end for a row that
 * omits its closing pipe). */
export interface CellSpan {
  text: string;
  from: number;
  to: number;
}

/** Every chunk between pipes, outer edges included — the shared scan. */
function scanRow(line: string): CellSpan[] {
  const out: CellSpan[] = [];
  let start = 0;
  let text = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      text += "|";
      i++;
    } else if (ch === "|") {
      out.push({ text, from: start, to: i });
      text = "";
      start = i + 1;
    } else {
      text += ch;
    }
  }
  out.push({ text, from: start, to: line.length });
  return out;
}

/** The cells of a row with their spans, plus whether the row closed itself
 * with a pipe — the two facts an in-place splice needs. Outer pipes produce
 * empty edge chunks, which are the pipes rather than cells and drop out. */
export function cellSpans(line: string): { cells: CellSpan[]; closed: boolean } {
  const cells = scanRow(line);
  if (cells.length && cells[0].text.trim() === "") cells.shift();
  let closed = false;
  if (cells.length && cells[cells.length - 1].text.trim() === "") {
    cells.pop();
    closed = true;
  }
  return { cells, closed };
}

export function splitRow(line: string): string[] {
  return cellSpans(line).cells.map((c) => c.text.trim());
}

/** A rewritten table plus where the cursor belongs in it — always the first
 * cell of whatever was just added, because the only reason to add one is to
 * type in it. Offsets are relative to the table's own first character. */
export interface TableEdit {
  source: string;
  cursor: number;
}

/** The blockquote marker run opening a line (`> `, nested `> > `, each mark
 * indented up to three spaces, per CommonMark). A quoted table keeps these
 * marks on every line of its source slice. */
const QUOTE_PREFIX_RE = /^(?: {0,3}> ?)+/;

export function quotePrefix(line: string): string {
  return QUOTE_PREFIX_RE.exec(line)?.[0] ?? "";
}

/** A table line without its blockquote markers — what the cell scanner has
 * to read, or the quote marker lands as a phantom first cell and every
 * column index is off by one from what the reader sees. */
export function stripQuotes(line: string): string {
  return line.slice(quotePrefix(line).length);
}

/** Run a table edit behind the quote markers: strip each line's prefix,
 * edit, then put the prefixes back. A line the edit appends borrows the last
 * original line's prefix, so a new row stays inside the quote, and the
 * cursor shifts by every prefix re-inserted at or before it. Unquoted
 * sources pass straight through. */
export function editQuoted(source: string, edit: (source: string) => TableEdit): TableEdit {
  const lines = source.split("\n");
  const prefixes = lines.map(quotePrefix);
  if (prefixes.every((p) => p === "")) return edit(source);
  const inner = edit(lines.map((l, i) => l.slice(prefixes[i].length)).join("\n"));
  const outLines = inner.source.split("\n");
  const rebuilt: string[] = [];
  let cursor = inner.cursor;
  let lineStart = 0;
  for (let i = 0; i < outLines.length; i++) {
    const p = prefixes[Math.min(i, prefixes.length - 1)];
    rebuilt.push(p + outLines[i]);
    if (inner.cursor >= lineStart) cursor += p.length;
    lineStart += outLines[i].length + 1;
  }
  return { source: rebuilt.join("\n"), cursor };
}

/** An empty cell is two spaces, so `| a |  |` keeps the pipes apart and the
 * cursor has somewhere to sit. */
const EMPTY = "  ";
const DELIM = " --- ";

/** The column count comes off the delimiter row: the one row markdown requires
 * to be well formed, and the one the parser itself counts columns from. */
function width(lines: string[]): number {
  return Math.max(1, splitRow(lines[1] ?? "").length);
}

/** `\|` inside a cell is a literal pipe, not a delimiter, so a row ending in
 * one (`| a | b \|`) is an unclosed row and needs its closing pipe before the
 * new cell. Same boundary rule `splitRow` reads by — a backslash immediately
 * before a pipe escapes it — so the two halves of this module agree on where
 * a row ends. */
function endsWithClosingPipe(line: string): boolean {
  return line.endsWith("|") && line[line.length - 2] !== "\\";
}

function appendCell(line: string, cell: string): string {
  const trimmed = line.trimEnd();
  // a row may legally omit its closing pipe (`| a | b`) — give it one before
  // the new cell, or the new cell would merge into the last one
  const base = endsWithClosingPipe(trimmed) ? trimmed : trimmed + " |";
  return base + cell + "|";
}

/** One more body row at the bottom, as wide as the table already is. */
export function tableWithRow(source: string): TableEdit {
  const lines = source.split("\n");
  // a table nested in a list keeps its indent, or the new row would fall out
  // of the list item the rest of the table sits in
  const indent = /^[ \t]*/.exec(lines[0] ?? "")![0];
  const row = indent + "|" + (EMPTY + "|").repeat(width(lines));
  const body = source.replace(/\s+$/, "");
  // past the newline, the indent and the row's opening pipe, one space in
  return { source: body + "\n" + row, cursor: body.length + 1 + indent.length + "|".length + 1 };
}

/** One more column on the right, on every row — header, delimiter and body —
 * so the table stays rectangular and keeps parsing as a table. */
export function tableWithColumn(source: string): TableEdit {
  const lines = source.replace(/\s+$/, "").split("\n");
  const grown = lines.map((line, i) => {
    if (line.trim() === "") return line;
    return appendCell(line, i === 1 ? DELIM : EMPTY);
  });
  // the cursor goes in the new header cell — one space back from the closing
  // pipe the header line just grew
  const cursor = grown[0].length - "|".length - 1;
  return { source: grown.join("\n"), cursor };
}

/** Where a table's body starts: line 0 is the header, line 1 the delimiter
 * markdown requires, and both are the table's shape rather than its data —
 * deleting either stops it parsing as a table at all. */
const FIRST_BODY_LINE = 2;

/** A body row lifted out. Refuses the header and the delimiter (see
 * `FIRST_BODY_LINE`), and refuses a line index the table doesn't have, so a
 * stale hit from a table that changed under the menu is a no-op rather than a
 * mangled table. */
export function tableWithoutRow(source: string, line: number): string | null {
  const lines = source.split("\n");
  if (line < FIRST_BODY_LINE || line >= lines.length) return null;
  lines.splice(line, 1);
  return lines.join("\n");
}

/** One cell spliced out of a row, leaving every other character where it was.
 * The last cell of a closed row takes the closing pipe with it — the pipe
 * before it becomes the new closer — and the last cell of an unclosed row
 * takes the pipe that opened it instead. */
function dropCell(line: string, col: number): string {
  const { cells, closed } = cellSpans(line);
  // a row narrower than the column being dropped is already short; leaving it
  // alone keeps the damage to what the user asked for
  if (col < 0 || col >= cells.length || cells.length < 2) return line;
  const cell = cells[col];
  if (col === cells.length - 1 && !closed) {
    return (line.slice(0, cell.from - 1) + line.slice(cell.to)).trimEnd();
  }
  return line.slice(0, cell.from) + line.slice(cell.to + 1);
}

/** Whether a line still holds a pipe that ends a cell. `\|` is a literal pipe
 * in the text, so it doesn't count — the same boundary rule the row scanner
 * reads by. */
function hasCellPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "|") return true;
  }
  return false;
}

/** A row given its outer pipes back. Markdown lets a table omit them
 * (`Track | Length`), which is fine until a column goes and the row that is
 * left holds no pipe at all — at that point it has stopped being a table row
 * and the header would silently become a setext heading. Re-piping is the
 * smaller surprise: the user asked for one column fewer, not for the table to
 * dissolve. */
function repipe(line: string, indent: string): string {
  const body = line.trim();
  return indent + "| " + (body === "" ? " " : body + " ") + "|";
}

/** One column out of every row — header, delimiter and body — so the table
 * stays rectangular. The last column can't go: a table with no columns is not
 * a table, and the source would have to be deleted instead of edited. */
export function tableWithoutColumn(source: string, col: number): string | null {
  const lines = source.split("\n");
  const width = splitRow(lines[1] ?? "").length;
  if (col < 0 || col >= width || width < 2) return null;
  return lines
    .map((line) => {
      if (line.trim() === "") return line;
      const dropped = dropCell(line, col);
      // the indent is the original row's: dropping the first column can leave
      // the space that used to sit after the pipe at the front of the line
      return hasCellPipe(dropped) ? dropped : repipe(dropped, /^[ \t]*/.exec(line)![0]);
    })
    .join("\n");
}

/** What a delimiter cell says about its column. `null` is the unmarked
 * `---`: markdown's default, which is left in every renderer but not the same
 * text as an explicit `:---`, so the menu can tell "left" from "unset". */
export type CellAlign = "left" | "center" | "right" | null;

function alignOf(cell: string): CellAlign {
  const m = /^(:)?-+(:)?$/.exec(cell.trim());
  if (!m) return null;
  if (m[1] && m[2]) return "center";
  if (m[2]) return "right";
  if (m[1]) return "left";
  return null;
}

/** Each column's alignment, read off the delimiter row — the same row the
 * parser counts columns from. */
export function tableAlignments(source: string): CellAlign[] {
  return splitRow(source.split("\n")[1] ?? "").map(alignOf);
}

/** A column's alignment rewritten in place: only the delimiter cell changes,
 * and it keeps however many dashes it already had (three at minimum, which is
 * what markdown needs to see a delimiter). `null` clears the marks back to a
 * plain `---`. */
export function tableWithAlignment(source: string, col: number, align: CellAlign): string | null {
  const lines = source.split("\n");
  if (lines.length < 2) return null;
  const { cells } = cellSpans(lines[1]);
  if (col < 0 || col >= cells.length) return null;
  const cell = cells[col];
  const dashes = Math.max(3, (cell.text.match(/-/g) ?? []).length);
  const marked =
    (align === "left" || align === "center" ? ":" : "") +
    "-".repeat(dashes) +
    (align === "right" || align === "center" ? ":" : "");
  lines[1] = lines[1].slice(0, cell.from) + " " + marked + " " + lines[1].slice(cell.to);
  return lines.join("\n");
}

/** Cell text on its way back into the source: a pipe would end the cell, and a
 * newline would end the row, so both are neutralised rather than allowed to
 * reshape the table from inside a cell editor. */
export function escapeCell(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/** One cell's text replaced, every other character of the table left alone.
 * Refuses a row or column the table doesn't have — an editor left open across
 * a change that shrank the table must not write into whatever now sits at
 * those coordinates. */
export function tableWithCell(
  source: string,
  row: number,
  col: number,
  text: string
): string | null {
  const lines = source.split("\n");
  if (row < 0 || row >= lines.length || row === 1) return null;
  const { cells } = cellSpans(lines[row]);
  if (col < 0 || col >= cells.length) return null;
  const cell = cells[col];
  const body = escapeCell(text);
  lines[row] =
    lines[row].slice(0, cell.from) + " " + (body === "" ? " " : body + " ") + lines[row].slice(cell.to);
  return lines.join("\n");
}
