#!/usr/bin/env node
/**
 * Infotip coverage gate for the dashboard kinds.
 *
 * The info view explains whatever the pointer is over, resolving through the
 * registry in src/lib/infotips.ts. Every dashboard kind renders its own
 * controls, but the registry only ever HAD to know about the shared chrome
 * (`dash-inner`, `dash-card`, `dash-foot`) — so a kind could ship a whole pane
 * of buttons and still answer every hover with "A purpose-built view assembled
 * from live vault data". Seven of sixteen kinds were in that state when this
 * script was written, and nothing failed: coverage has no compiler.
 *
 * Same shape as scripts/check-kinds.ts, and it borrows that file's parsers:
 * re-derive the inventories mechanically from the checked-in tree, compare,
 * and fail `npm test` on any divergence. What it compares:
 *
 *   1. Every kind in `BUILT_IN_KINDS` has a `PANE_CONTROLS` entry below —
 *      the declaration of which controls on that pane deserve prose. A new
 *      kind therefore cannot land without someone answering "what on this
 *      pane needs explaining?", and the answer is reviewable in one place.
 *   2. Every declared control is named by a registry selector, so the
 *      declaration is a promise the registry keeps.
 *   3. Every declared control is still rendered by the pane's own component
 *      (or a component it renders), so a renamed class fails here rather than
 *      leaving a tip aimed at markup that no longer exists. This one is
 *      weakest for the two kinds whose renderer is a function inside
 *      DashboardPane.tsx rather than its own module: their "pane" is that file
 *      plus every component it imports, which is most of the dashboard code,
 *      so the check there proves the class exists somewhere rather than that
 *      it exists on that board.
 *   4. PRIVACY matches, as in check-kinds: a machine-specific kind's tips sit
 *      between share-mirror strip markers exactly as its pane does, and a
 *      public kind's tips do not — a tip stripped from the mirror leaves a
 *      shipped pane unexplained, and one that isn't leaks a private surface's
 *      vocabulary.
 *
 * What it deliberately does not do is decide whether the PROSE is any good, or
 * whether the control it names is the one worth explaining. Those are review
 * questions. This gate only holds the mechanical half still.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBuiltInKinds, parseDispatch, stripFlags, type KindMap } from "./check-kinds.ts";
import { RESERVED_KINDS } from "../src/lib/kinds.ts";
import { TIPS } from "../src/lib/infotips.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/check-infotips.ts";

/**
 * Per kind: the classes on its pane whose controls the info view must be able
 * to explain in that pane's own words. One or two per kind — this is not an
 * inventory of the markup, it is the shortlist a reader would actually point
 * at, and the checks above hold it honest in both directions.
 *
 * Machine-specific kinds sit between strip markers, like their panes and their
 * tips: in the public mirror the kind, the pane, the tips and this line all
 * leave together, and the coverage check still balances.
 */
export const PANE_CONTROLS: ReadonlyMap<string, readonly string[]> = new Map([
  ["metrics", ["metrics-strip"]],
  // the hero is shared chrome three surfaces render, so it is not this
  // board's own control; the armed claim is
  ["yield-apr", ["dash-claim"]],
  ["hub", ["hub-task", "hub-view"]],
  ["food", ["food-hero", "food-daynav-btn", "food-del"]],
  ["feed", ["feed-item", "feed-vote"]],
  ["music-work", ["mw-job", "mw-filter"]],
  ["tasks", ["tasks-row", "tasks-compose"]],
  ["charts", ["chart-line-slot", "chart-legend"]],
]);

/* ── 1. the registry ────────────────────────────────────────────────────── */

/** One registry entry as the source spells it: its selector and whether it is
    mirror-private where it sits. */
export interface TipEntryInfo {
  selector: string;
  private: boolean;
}

/**
 * The `selector:` lines of the TIPS array, with their privacy.
 *
 * Parsed from the text rather than read off the imported array because the
 * privacy flag exists only in the source — a stripped region is a comment
 * marker at runtime. `collect` cross-checks the count against the imported
 * `TIPS`, so a selector written in a shape this misses is caught rather than
 * silently dropped from the coverage set.
 */
export function parseTipSelectors(src: string, label = "src/lib/infotips.ts"): TipEntryInfo[] {
  const priv = stripFlags(src, label);
  const out: TipEntryInfo[] = [];
  // both quote styles: a selector carrying a double-quoted attribute value is
  // written in single quotes ('.note-tool[aria-label="History"]')
  const re = /^\s*selector:\s*(?:"([^"]+)"|'([^']+)'),\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ selector: m[1] ?? m[2], private: priv[m.index] });
  if (out.length === 0) throw new Error(`${label}: no tip selectors parsed — the registry shape changed`);
  return out;
}

/** The class names a selector mentions anywhere in it, so `.a .b` and
    `.a, .b` both count as naming `a` and `b`. */
export function selectorClasses(selector: string): string[] {
  return [...selector.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]);
}

/** class name → the parsed entries that name it. */
export function tipsByClass(entries: TipEntryInfo[]): Map<string, TipEntryInfo[]> {
  const out = new Map<string, TipEntryInfo[]>();
  for (const entry of entries) {
    for (const cls of selectorClasses(entry.selector)) {
      const list = out.get(cls);
      if (list) list.push(entry);
      else out.set(cls, [entry]);
    }
  }
  return out;
}

/* ── 2. the declaration, as the source spells it ────────────────────────── */

/** One kind's declaration: the controls it names, and whether the line
    naming them is mirror-private. */
export interface PaneControls {
  classes: string[];
  private: boolean;
}

/**
 * `PANE_CONTROLS` re-read from this file's own text, for its privacy flags —
 * the same reason parseTipSelectors exists. Cross-checked against the constant
 * itself in `collect`, so the parser cannot quietly disagree with the value it
 * describes.
 */
export function parsePaneControls(src: string, label = SELF): Map<string, PaneControls> {
  const anchor = "export const PANE_CONTROLS";
  const from = src.indexOf(anchor);
  if (from === -1) throw new Error(`${label}: ${anchor} not found — the declaration moved or was renamed`);
  const to = src.indexOf("\n]);", from);
  if (to === -1) throw new Error(`${label}: no closing ]); after ${anchor}`);
  const priv = stripFlags(src, label);
  const out = new Map<string, PaneControls>();
  const re = /^\s*\["([a-z0-9][a-z0-9-]*)",\s*\[([^\]]*)\]\],?$/gm;
  let m: RegExpExecArray | null;
  const region = src.slice(from, to);
  while ((m = re.exec(region))) {
    if (out.has(m[1])) throw new Error(`${label}: "${m[1]}" declared twice in PANE_CONTROLS`);
    const classes = [...m[2].matchAll(/"([A-Za-z][A-Za-z0-9_-]*)"/g)].map((c) => c[1]);
    if (classes.length === 0) throw new Error(`${label}: "${m[1]}" declares no controls`);
    out.set(m[1], { classes, private: priv[from + m.index] });
  }
  if (out.size === 0) throw new Error(`${label}: PANE_CONTROLS parsed as empty`);
  return out;
}

/* ── 3. what a pane actually renders ────────────────────────────────────── */

const COMPONENTS = "src/components";

/**
 * The file a dispatch component lives in. Nearly every one is its own module,
 * but the accrual board and the chart-fence wrapper are functions inside
 * DashboardPane.tsx, so a missing file falls back to searching for the
 * declaration. Not finding it throws: a component this cannot locate would
 * otherwise pass every class check by vacuum.
 */
export function componentFile(name: string, files: string[], read: (p: string) => string): string {
  const own = `${COMPONENTS}/${name}.tsx`;
  if (files.includes(own)) return own;
  const re = new RegExp(`function ${name}\\(`);
  const found = files.find((f) => re.test(read(f)));
  if (!found) throw new Error(`${SELF}: no component file declares ${name}`);
  return found;
}

/**
 * The text a pane's markup can come from: its own module plus the sibling
 * components it imports. One level deep on purpose — the card strip and the
 * chart renderer are children of the panes that declare them, while a full
 * walk would drag in the shared chrome every pane imports and make the check
 * mean nothing.
 */
export function paneSource(file: string, files: string[], read: (p: string) => string): string {
  const src = read(file);
  const parts = [src];
  for (const m of src.matchAll(/from "\.\/([A-Za-z0-9_]+)"/g)) {
    const sibling = `${COMPONENTS}/${m[1]}.tsx`;
    if (files.includes(sibling)) parts.push(read(sibling));
  }
  return parts.join("\n");
}

/** Whether a class name is rendered in that text. A hyphen counts as part of
    the name rather than as a boundary, so `grid-tile` is not satisfied by a
    file that only renders `grid-tile-err` — class names here are built by
    suffixing, which is exactly where a word boundary would wave a rename
    through. */
export function rendersClass(src: string, cls: string): boolean {
  return new RegExp(`(?<![\\w-])${cls}(?![\\w-])`).test(src);
}

/* ── driver ─────────────────────────────────────────────────────────────── */

const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

export interface Inventories {
  builtIn: KindMap;
  declared: Map<string, PaneControls>;
  tips: TipEntryInfo[];
  /** kind → the text its pane's markup may come from */
  paneSources: Map<string, string>;
}

/** The declaration flattened to one comparable line per kind, so the parsed
    and the imported copy are checked as values rather than by shape. */
function flatten(controls: Map<string, PaneControls> | ReadonlyMap<string, readonly string[]>): string {
  const rows: string[] = [];
  for (const [kind, value] of controls) {
    rows.push(`${kind}=${(Array.isArray(value) ? value : (value as PaneControls).classes).join("+")}`);
  }
  return rows.sort().join(" ");
}

export function collect(): Inventories {
  const tips = parseTipSelectors(read("src/lib/infotips.ts"));
  if (tips.length !== TIPS.length) {
    throw new Error(
      `src/lib/infotips.ts: parsed ${tips.length} selectors but the registry exports ${TIPS.length} entries — a selector is written in a shape the parser misses`
    );
  }

  const declared = parsePaneControls(read(SELF));
  const fromSource = flatten(declared);
  const fromValue = flatten(PANE_CONTROLS);
  if (fromSource !== fromValue) {
    throw new Error(`${SELF}: the PANE_CONTROLS parser and the constant disagree — ${fromSource} vs ${fromValue}`);
  }

  const files = readdirSync(resolve(ROOT, COMPONENTS))
    .filter((n) => n.endsWith(".tsx"))
    .map((n) => `${COMPONENTS}/${n}`)
    .sort();
  const dispatch = parseDispatch(read("src/components/DashboardPane.tsx"));
  const paneSources = new Map<string, string>();
  for (const kind of PANE_CONTROLS.keys()) {
    const component = dispatch.kinds.get(kind)?.component ?? (RESERVED_KINDS.has(kind) ? dispatch.fallback : null);
    // a kind that is neither dispatched nor reserved has no renderer at all,
    // which is check-kinds' catch and not this one's; there is no markup to
    // read, so it simply has no source here and its class check is skipped
    if (component === null) continue;
    paneSources.set(kind, paneSource(componentFile(component, files, read), files, read));
  }

  return { builtIn: parseBuiltInKinds(read("src/lib/kinds.ts")), declared, tips, paneSources };
}

export function crossCheck(inv: Inventories): string[] {
  const problems: string[] = [];
  const byClass = tipsByClass(inv.tips);

  for (const [kind, isPrivate] of inv.builtIn) {
    const declared = inv.declared.get(kind);
    if (!declared) {
      problems.push(
        `"${kind}" is a built-in dashboard kind with no PANE_CONTROLS entry — name the controls on its pane that the info view should explain (${SELF})`
      );
      continue;
    }
    if (declared.private !== isPrivate) {
      problems.push(
        `"${kind}" is ${isPrivate ? "private" : "public"} in BUILT_IN_KINDS but ${declared.private ? "private" : "public"} in PANE_CONTROLS`
      );
    }

    const pane = inv.paneSources.get(kind);
    for (const cls of declared.classes) {
      if (pane !== undefined && !rendersClass(pane, cls)) {
        problems.push(`"${kind}" declares the control ".${cls}", which its pane no longer renders`);
      }
      const entries = byClass.get(cls) ?? [];
      if (entries.length === 0) {
        problems.push(
          `"${kind}" has no infotip entry for ".${cls}" — its pane answers that hover with the generic dashboard tip`
        );
        continue;
      }
      for (const entry of entries) {
        if (entry.private !== isPrivate) {
          problems.push(
            `the tip for "${entry.selector}" is ${entry.private ? "inside" : "outside"} a strip region, but "${kind}" is ${isPrivate ? "private" : "public"} — a private pane's tips ship with it or not at all`
          );
        }
      }
    }
  }

  for (const kind of inv.declared.keys()) {
    if (!inv.builtIn.has(kind)) {
      problems.push(`PANE_CONTROLS names "${kind}", which is not a built-in dashboard kind any more`);
    }
  }

  return problems;
}

function main(): void {
  let inv: Inventories;
  try {
    inv = collect();
  } catch (e) {
    console.error(`check-infotips: could not build the inventories — ${(e as Error).message}`);
    console.error("This is a parse failure, not a clean tree. Fix the parser or the source.");
    process.exit(2);
  }

  const problems = crossCheck(inv);
  console.log(
    `check-infotips: ${inv.builtIn.size} dashboard kinds, ${inv.tips.length} registry entries`
  );
  if (problems.length === 0) {
    console.log("check-infotips: every dashboard kind has tips of its own ✓");
    return;
  }
  console.error(`\ncheck-infotips: ${problems.length} coverage problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
