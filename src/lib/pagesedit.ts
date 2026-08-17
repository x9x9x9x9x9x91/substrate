// Adding a workbook page from the tab strip — the text half of it.
//
// `pages:` is a list of maps, which `vault_set_prop` refuses (it writes
// scalars), so the add-tab control edits the raw frontmatter block through
// `vault_fm_raw` / `vault_fm_write`. That makes this a text edit on someone's
// hand-written YAML, so the rules here are conservative: append one entry in
// the indentation the block already uses, touch no other line, and refuse
// outright — with a sentence a person can act on — whenever the block is in a
// shape this cannot append to safely (a flow-style `pages: [...]`, a scalar).
//
// Pure TS, no DOM imports: runs in the app and under `node --test`.

/** A new page, as the tab strip's control describes it: a label plus the one
    key that says what the page points at. */
export interface NewPage {
  label: string;
  /** `note` for a sheet/dashboard page, `view` for a database page */
  key: "note" | "view";
  value: string;
}

export type PagesEditResult = { fm: string } | { error: string };

/** A plain scalar YAML would hand back as something other than a string: a
    number, a boolean, a null. A note titled `2026` or `true` is a perfectly
    ordinary note, but `note: 2026` round-trips as an int and `parsePages`
    only accepts strings — so these get quoted like any other awkward title. */
const YAML_RETYPES = /^([-+]?\d[\d_]*(\.\d*)?([eE][-+]?\d+)?|true|false|null|~|y|n|yes|no|on|off)$/i;

/** YAML-safe scalar: plain when it can be, double-quoted when it can't.
    Titles carry colons, leading `#`, quotes and brackets often enough that
    guessing is not an option. */
export function yamlScalar(raw: string): string {
  const v = raw.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9 _./-]*$/.test(v) && !/\s$/.test(v) && !YAML_RETYPES.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Is this line the start of a new top-level key (ending the block above)? */
const isTopLevelKey = (line: string) => /^[^\s#-][^:]*:/.test(line);

/** Append `page` to the note's `pages:` list, returning the whole frontmatter
    block to write back. A note with no `pages:` key at all gets one — that is
    how the second page of a brand-new workbook lands, and the strip that
    hosts this control only renders once a first page exists. */
export function appendPage(fmRaw: string, page: NewPage): PagesEditResult {
  const entry = (indent: string) => [
    `${indent}- label: ${yamlScalar(page.label)}`,
    `${indent}  ${page.key}: ${yamlScalar(page.value)}`,
  ];
  const lines = fmRaw.replace(/\s+$/, "").split("\n");
  const at = lines.findIndex((l) => /^pages\s*:/i.test(l));
  if (at === -1) {
    return { fm: `${[...lines, "pages:", ...entry("  ")].join("\n")}\n` };
  }
  if (lines[at].slice(lines[at].indexOf(":") + 1).trim() !== "") {
    return {
      error: "pages: is written on one line — add this page in the frontmatter instead",
    };
  }
  // the block runs to the next top-level key; blank lines inside it belong to
  // it, a blank line before the next key does not
  let end = at;
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (isTopLevelKey(lines[i])) break;
    end = i;
  }
  const dash = lines.slice(at + 1, end + 1).find((l) => /^\s*- /.test(l));
  if (!dash && lines.slice(at + 1, end + 1).some((l) => l.trim() !== "")) {
    return {
      error: "pages: is not a plain list — add this page in the frontmatter instead",
    };
  }
  const indent = dash ? (dash.match(/^\s*/)?.[0] ?? "  ") : "  ";
  const out = [...lines.slice(0, end + 1), ...entry(indent), ...lines.slice(end + 1)];
  return { fm: `${out.join("\n")}\n` };
}
