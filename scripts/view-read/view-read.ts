#!/usr/bin/env node
/** Read a saved view the way the app renders it, without the app.
 *
 *  ```
 *  node scripts/view-read/view-read.ts "Releases — in review"
 *  node scripts/view-read/view-read.ts --list --vault ~/Vault
 *  node scripts/view-read/view-read.ts "Overdue" --format md --today 2026-08-18
 *  ```
 *
 *  The rows, their order and every cell come from `src/lib/vieweval.ts` —
 *  the same function the database pane paints from, called with the same
 *  arguments. This file only turns a folder into that function's inputs and
 *  its result into text: it holds no filter, no sort, no cell rule of its
 *  own, because the moment it held one it would be a second implementation
 *  of the view and would drift from the screen.
 *
 *  Read-only, by construction: nothing here opens a file for writing.
 */

import { realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readVault, type VaultRead } from "./vaultread.ts";
import { evaluateSavedView, type EvaluatedView } from "../../src/lib/vieweval.ts";
import {
  DEFAULT_NUMBER_LOCALE,
  numberLocaleSetting,
  type NumberLocale,
} from "../../src/lib/numberLocale.ts";
import { todayIso } from "../../src/lib/dates.ts";
import { byFoldedKey, typeSchemaFor } from "../../src/lib/schemalookup.ts";
import { pickView, UsageError } from "./pickview.ts";

// re-exported so a caller of this verb keeps reaching them where they were
export { pickView, UsageError };

export interface CliOptions {
  name: string | null;
  vault: string | null;
  format: "json" | "md";
  today: string | null;
  db: string | null;
  list: boolean;
  help: boolean;
}

/** No vault to read: none named, or the named path is not a folder. Its own
    error because the CLI door already draws that line — a script can tell "I
    asked wrong" from "there is no vault here" without parsing prose, and
    there is no reason for two headless entries to spell that differently
    (`docs/mcp-door.md`, "Headless callers"). */
export class NoVaultError extends Error {}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    name: null,
    vault: null,
    format: "json",
    today: null,
    db: null,
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      // `--vault --list` is a forgotten path, not a vault named `--list`:
      // swallowing the next option would send the reader looking for a
      // folder nobody meant and report "no vault there"
      if (v.startsWith("-")) throw new UsageError(`${arg} needs a value, not ${v}`);
      return v;
    };
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--vault") opts.vault = value();
    else if (arg === "--db") opts.db = value();
    else if (arg === "--today") opts.today = value();
    else if (arg === "--view") opts.name = value();
    else if (arg === "--format") {
      const v = value();
      if (v !== "json" && v !== "md") throw new UsageError(`--format takes json or md, not ${v}`);
      opts.format = v;
    } else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else if (opts.name === null) opts.name = arg;
    else throw new UsageError(`unexpected argument ${arg}`);
  }
  if (opts.today !== null && !/^\d{4}-\d{2}-\d{2}$/.test(opts.today)) {
    throw new UsageError("--today takes an ISO day, e.g. 2026-08-18");
  }
  return opts;
}

export const USAGE = `substrate view — read a saved table view headless

  node scripts/view-read/view-read.ts <view name> [options]

  --vault <dir>     vault folder (default: $VAULT_DIR)
  --db <type>       disambiguate when two databases share a view name
  --format json|md  output shape (default: json)
  --today <ISO day> reference day for relative date filters (default: today)
  --list            list the vault's saved views and exit
  --help            this text

Exit codes follow the CLI door: 0 answered, 1 asked wrong, 3 no vault there.
`;

/** What the reader itself contributed, stated next to the payload rather
    than folded into it: which vault was read, which day the relative date
    filters were measured against, which number dialect the cells were
    written in, and every note whose frontmatter this reader could only
    partly parse. `fx: "none"` is the honest name for having no live rates
    (§ the contract chapter in docs/vault-format.md). */
export interface ReaderEnvelope {
  vault: string;
  today: string;
  numberLocale: NumberLocale;
  fx: "none";
  warnings: { path: string; reason: string }[];
}

/** The reader's own warnings, under the table rather than nowhere. JSON
    carries them in `reader.warnings`; markdown used to drop them entirely, so
    a table shortened by an unreadable note read as the whole answer. */
function warningsFooter(warnings: ReaderEnvelope["warnings"]): string[] {
  if (warnings.length === 0) return [];
  return [
    "---",
    "",
    `**${warnings.length} note${warnings.length === 1 ? "" : "s"} this reader could not fully read** — the table above may be short or missing cells:`,
    "",
    ...warnings.map((w) => `- \`${w.path}\`: ${w.reason}`),
    "",
  ];
}

export function markdown(view: EvaluatedView, warnings: ReaderEnvelope["warnings"] = []): string {
  const head = [`# ${view.view.name}`, "", `${view.total} row${view.total === 1 ? "" : "s"} · database \`${view.view.db}\``];
  if (view.view.query.trim() !== "") head.push(`filter \`${view.view.query}\``);
  const lines = [...head, ""];

  const table = (rows: EvaluatedView["rows"]): string[] => {
    const cols = ["Name", ...view.columns];
    const cells = rows.map((r) => [r.title, ...view.columns.map((c) => r.cells[c]?.display ?? "")]);
    // a carriage return ends the row for a markdown renderer just as a
    // newline does, so both become the space they read as
    const escape = (s: string) => s.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
    return [
      `| ${cols.map(escape).join(" | ")} |`,
      `| ${cols.map(() => "---").join(" | ")} |`,
      ...cells.map((row) => `| ${row.map(escape).join(" | ")} |`),
    ];
  };

  const footer = warningsFooter(warnings);
  if (view.rows.length === 0) return [...lines, "_No rows._", "", ...footer].join("\n");
  if (view.group_by === null) return [...lines, ...table(view.rows), "", ...footer].join("\n");
  for (const group of view.groups) {
    lines.push(`## ${group.label} (${group.count})`, "", ...table(group.rows), "");
  }
  return [...lines, ...footer].join("\n");
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function run(argv: string[], env: NodeJS.ProcessEnv): string {
  const opts = parseArgs(argv);
  if (opts.help) return USAGE;

  const vault = opts.vault ?? env.VAULT_DIR ?? null;
  if (vault === null) throw new NoVaultError("no vault: pass --vault <dir> or set VAULT_DIR");
  // A folder that is not there reads as a folder with nothing in it, so
  // without this a typo'd path answers "no saved views in this vault" and
  // exits 0 — the one answer a caller must never get wrong.
  if (!isDir(vault)) throw new NoVaultError(`not a vault folder: ${vault}`);

  const read: VaultRead = readVault(vault);
  if (opts.list) {
    if (read.views.length === 0) return "no saved views in this vault\n";
    return `${read.views.map((v) => `${v.name}\t${v.db}\t${v.id}`).join("\n")}\n`;
  }
  if (opts.name === null) throw new UsageError(`no view named\n\n${USAGE}`);

  const view = pickView(read.views, opts.name, opts.db);
  const typeSchema = typeSchemaFor(read.schema, view.db) ?? {};
  // the vault decides the dialect, never the machine: the app falls back to
  // the operating system's locale for a vault that never chose one, but a
  // reader whose output is diffed and piped has to answer the same on every
  // machine, so the keyless fallback is pinned to the shipped default.
  const locale = numberLocaleSetting(read.settings, DEFAULT_NUMBER_LOCALE);
  const today = opts.today ?? todayIso();

  const evaluated = evaluateSavedView(view, read.notes, typeSchema, {
    // the database's own layout preference under the pin. It contributes the
    // presentation the pin does not carry — grouping, aggregations, widths,
    // wrap, grid — and NOT its hidden set, its column order or its sorts: a
    // pin names its own columns and its own sort keys, and answers with the
    // same table wherever it is opened from (`savedViewPref`, §7b).
    pref: byFoldedKey(read.prefs, view.db),
    today,
    locale,
    // no live rates headless: a currency cell renders as it was typed rather
    // than converted, which is what the app shows before its rates land too
    fx: undefined,
  });

  if (opts.format === "md") return markdown(evaluated, read.warnings);
  const envelope: ReaderEnvelope = {
    vault,
    today,
    numberLocale: locale,
    fx: "none",
    warnings: read.warnings,
  };
  return `${JSON.stringify({ ...evaluated, reader: envelope }, null, 2)}\n`;
}

/** Run, as opposed to imported by a test.
 *
 *  `pathToFileURL` because `file://${path}` leaves a space (or any other
 *  character a URL escapes) raw, so a vault checkout under `~/My Notes/`
 *  never matched its own module URL and the CLI printed nothing at all.
 *  `realpathSync` because a launcher hands over the path it was given while
 *  `import.meta.url` is the resolved one — invoked through a symlink (macOS
 *  `/tmp` is one) the two differ, and the verb exits 0 having printed
 *  nothing. */
function invokedDirectly(): boolean {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  try {
    process.stdout.write(run(process.argv.slice(2), process.env));
  } catch (error) {
    // the CLI door's codes, for the cases this verb shares with it:
    // 1 asked wrong, 3 no vault here (`docs/mcp-door.md`)
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof NoVaultError ? 3 : 1);
  }
}
