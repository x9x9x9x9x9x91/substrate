#!/usr/bin/env node
/** Evaluate one view for a caller that is not the app and not a shell.
 *
 *  The MCP door is a Rust sidecar; the thing that decides what a view SHOWS
 *  is TypeScript — `evaluateSavedView` for a saved pin, `parseViewSpec` +
 *  `embedQueryFor` for a ```view fence — and it is the same TypeScript the
 *  database pane and the note widget paint from. Rather than spell those
 *  rules a second time in Rust, where they would drift from the screen the
 *  first time either side gains a step, the door runs this file and reads
 *  its answer. One request object in on stdin, one payload out on stdout.
 *
 *  This file holds no filter, no sort, no cell rule of its own — the same
 *  design rule `view-read.ts` keeps, for the same reason. What it does hold
 *  is the door's half of the bargain: it opens ONLY the notes the request's
 *  `allow` list names. The door decides that list from its grants before it
 *  spawns anything, so an ungranted folder cannot reach the evaluator at
 *  all — not as a row, not as a rollup target, not as a group count.
 *
 *  Read-only, by construction: nothing here opens a file for writing.
 */

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readVault, splitFrontmatter, type VaultRead } from "./vaultread.ts";
import {
  evaluateSavedView,
  VIEW_EVAL_SCHEMA,
  type EvaluatedView,
  type ViewCell,
  type ViewRow,
} from "../../src/lib/vieweval.ts";
import { embedQueryFor, parseViewSpec, type EmbedSpec } from "../../src/lib/embeds.ts";
import { scanMdBlocks } from "../../src/lib/mdblocks.ts";
import {
  DEFAULT_NUMBER_LOCALE,
  numberLocaleSetting,
  type NumberLocale,
} from "../../src/lib/numberLocale.ts";
import { todayIso } from "../../src/lib/dates.ts";
import { byFoldedKey, typeSchemaFor } from "../../src/lib/schemalookup.ts";
import { foldedPropStr, type SavedView } from "../../src/lib/types.ts";
import { pickView } from "./pickview.ts";

/** What the door asks for. Every path is vault-relative; the absolute vault
    root is the one host path in here, and it never travels back out. */
export interface EngineRequest {
  vault: string;
  /** The note paths the caller's grants reach, sealed ones already dropped.
      Absent means "no narrowing" — the CLI verb's own reading of the vault. */
  allow?: string[];
  /** A saved view by name or id. Mutually exclusive with `path`. */
  view?: string;
  /** Settles a view name two databases both carry. */
  db?: string;
  /** A note holding ```view fences. Mutually exclusive with `view`. */
  path?: string;
  /** Which fence in that note, 1-based. Defaults to the first. */
  fence?: number;
  /** Reference day for relative date filters. Defaults to the machine's. */
  today?: string;
}

export type EngineResponse =
  | { ok: true; payload: DoorPayload }
  | { ok: false; error: string };

/** What the door contributed, stated beside the payload rather than folded
    into it (`docs/vault-format.md` §7b, `reader`). The door's version omits
    the CLI's `vault` key — a client that reached the vault through grants
    was never told where on the host it sits — and adds `scope`, because a
    table narrowed by grants and a table narrowed by a filter must not read
    the same way. */
export interface DoorEnvelope {
  scope: "granted folders" | "whole vault";
  notes_read: number;
  /** How many of the notes read belong to this view's database, before the
      view's own filter narrows them. Not a view rule and not part of the
      answer: it is what lets the door tell "the filter matched nothing" from
      "this caller was never given the database", which are the same empty
      table and must not read the same way. */
  members: number;
  today: string;
  numberLocale: NumberLocale;
  fx: "none";
  warnings: { path: string; reason: string }[];
}

/** Where the answer came from: a saved pin, or one fence in one note. An
    additive key on the `substrate.view/1` payload, so a reader that only
    knows saved views can ignore it. */
export type ViewSource =
  | { kind: "saved" }
  | { kind: "fence"; path: string; fence: number };

export type DoorPayload = EvaluatedView & { source: ViewSource; reader: DoorEnvelope };

/** A fence body's rows, projected into the payload every reader of a view
    already knows.
 *
 *  Not a second evaluation: the membership, the filter, the sort, the row
 *  cut and every display string come back from `embedQueryFor` — the widget's
 *  own resolver — and this only re-keys its column-aligned cells by name and
 *  puts the stored value beside each painted one. `kind` and `values` are
 *  absent on a fence row: the fence resolver paints joined and freshness
 *  columns that stand for no stored property, so a kind claimed here would be
 *  claimed for cells that have none. Both keys are optional in the contract. */
function fenceRows(
  columns: string[],
  rows: { path: string; title: string; props: Record<string, unknown>; cells: string[] }[],
  folderOf: Map<string, string>
): ViewRow[] {
  return rows.map((r) => {
    const cells: Record<string, ViewCell> = {};
    columns.forEach((col, i) => {
      cells[col] = { raw: foldedPropStr(r.props, col) ?? "", display: r.cells[i] ?? "" };
    });
    return { path: r.path, title: r.title, folder: folderOf.get(r.path) ?? "", cells };
  });
}

/** The `inner` of the note's Nth ```view fence, 1-based. Top-level fences
    only and the same scan the static surfaces use, so "the second fence" here
    counts what a reader of the note counts. */
export function nthViewFence(body: string, n: number): string | null {
  let seen = 0;
  for (const block of scanMdBlocks(body, { splitListsOnMarkerFlip: false })) {
    if (block.kind !== "fence" || block.lang.toLowerCase() !== "view") continue;
    seen++;
    if (seen === n) return block.inner;
  }
  return null;
}

/** The pins a caller may resolve a name against.
 *
 *  A narrowed request only ever gets the pins over a database its own notes
 *  are members of. Resolving over all of them would leak the pin list back
 *  out through the refusals: a name the caller was never given would fail
 *  differently from a name this vault does not have, and a name two
 *  databases carry would answer with the ungranted one's type in the
 *  "pass --db" line. Filtering first makes both of those read exactly like
 *  a vault where the ungranted view does not exist — which, for this
 *  caller, it does not. A request with no `allow` list is the CLI verb
 *  reading a vault it already holds, and keeps every pin. */
function eligibleViews(req: EngineRequest, read: VaultRead): SavedView[] {
  if (req.allow === undefined) return read.views;
  const dbs = new Set(
    read.notes
      .map((n) => foldedPropStr(n.props, "type")?.trim().toLowerCase())
      .filter((t): t is string => t !== undefined && t !== "")
  );
  return read.views.filter((v) => dbs.has(v.db.trim().toLowerCase()));
}

/** Evaluate the request against a vault already read. Split from `main` so a
    test can drive it without a subprocess. */
export function evaluate(req: EngineRequest, read: VaultRead): DoorPayload {
  const locale = numberLocaleSetting(read.settings, DEFAULT_NUMBER_LOCALE);
  const today = req.today ?? todayIso();
  const envelope = (db: string): DoorEnvelope => ({
    scope: req.allow === undefined ? "whole vault" : "granted folders",
    notes_read: read.notes.length,
    members: read.notes.filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === db.toLowerCase())
      .length,
    today,
    numberLocale: locale,
    fx: "none",
    warnings: read.warnings,
  });

  if (req.path !== undefined) {
    const fenceNo = req.fence ?? 1;
    if (!Number.isSafeInteger(fenceNo) || fenceNo < 1) {
      throw new Error(`fence is a 1-based position, not ${req.fence}`);
    }
    let raw: string;
    try {
      raw = readFileSync(join(req.vault, req.path), "utf8");
    } catch {
      throw new Error(`note unavailable: ${req.path}`);
    }
    const inner = nthViewFence(splitFrontmatter(raw).body, fenceNo);
    if (inner === null) {
      throw new Error(
        fenceNo === 1
          ? `no view fence in ${req.path}`
          : `${req.path} has fewer than ${fenceNo} view fences`
      );
    }
    const spec = parseViewSpec(inner);
    if ("error" in spec) throw new Error(`view fence: ${spec.error}`);
    // The widget's caps keep a note page from painting four thousand rows;
    // they are a drawing limit, not part of what the fence SAYS. A caller
    // reading the answer wants the fence's own `limit:` applied and nothing
    // else cutting silently, so the caps are opened and `limit` still bites.
    const wide = { cols: Number.MAX_SAFE_INTEGER, rows: Number.MAX_SAFE_INTEGER };
    const result = embedQueryFor(spec, read.notes, read.schema, read.views, wide);
    if ("error" in result) throw new Error(`view fence: ${result.error}`);
    const folderOf = new Map(read.notes.map((n) => [n.path, n.folder]));
    const sort = (spec as EmbedSpec).sort;
    return {
      schema: VIEW_EVAL_SCHEMA,
      view: {
        id: result.savedId ?? "",
        name: result.savedName ?? "",
        db: result.dbType,
        query: result.query,
      },
      columns: result.columns,
      sorts: sort ? [sort] : [],
      group_by: null,
      total: result.total,
      groups: [],
      rows: fenceRows(result.columns, result.rows, folderOf),
      source: { kind: "fence", path: req.path, fence: fenceNo },
      reader: envelope(result.dbType),
    };
  }

  if (req.view === undefined) throw new Error("a view name or a note path is required");
  const view = pickView(eligibleViews(req, read), req.view, req.db ?? null, { nameKnown: false });
  const typeSchema = typeSchemaFor(read.schema, view.db) ?? {};
  const evaluated = evaluateSavedView(view, read.notes, typeSchema, {
    pref: byFoldedKey(read.prefs, view.db),
    today,
    locale,
    // no live rates outside the app: a currency cell renders as it was typed
    // rather than converted, which is what the app shows before its rates land
    fx: undefined,
  });
  return { ...evaluated, source: { kind: "saved" }, reader: envelope(view.db) };
}

export function run(requestJson: string): EngineResponse {
  let req: EngineRequest;
  try {
    req = JSON.parse(requestJson) as EngineRequest;
  } catch (error) {
    return { ok: false, error: `unreadable request: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    if (typeof req.vault !== "string" || req.vault === "") throw new Error("vault is required");
    if (req.view !== undefined && req.path !== undefined) {
      throw new Error("ask for a saved view or a note's fence, not both");
    }
    const allow = req.allow === undefined ? undefined : new Set(req.allow);
    const read = readVault(req.vault, {
      allow: allow === undefined ? undefined : (rel) => allow.has(rel),
    });
    return { ok: true, payload: evaluate(req, read) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Run, as opposed to imported by a test. `realpathSync` because a launcher
    hands over the path it was given and `import.meta.url` is the resolved one
    — a bundle sitting under a symlinked folder is otherwise read as imported,
    and the door waits on a script that answers nothing. */
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
  const request = readFileSync(0, "utf8");
  process.stdout.write(`${JSON.stringify(run(request))}\n`);
}
