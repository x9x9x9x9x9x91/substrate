/** Pipe-table surgery as plain strings: the two edits a rendered table needs
 * (one more row, one more column) plus the row splitter both the renderer and
 * the edits parse cells with. No DOM, no editor — the widget applies the
 * result as a single document change, so an added row lands in the same ⌘Z
 * stack as typing the pipes by hand would. */

export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  // outer pipes produce empty edge chunks — drop one from each end
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** A rewritten table plus where the cursor belongs in it — always the first
 * cell of whatever was just added, because the only reason to add one is to
 * type in it. Offsets are relative to the table's own first character. */
export interface TableEdit {
  source: string;
  cursor: number;
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
