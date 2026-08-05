import { historyFacts, historySheets, vaultList, vaultRead, vaultResolve } from "./ipc";
import { foldedPropStr } from "./types";
import {
  evaluateSheet,
  makeHistorySheetValue,
  parseSheet,
  sheetHistoryRefs,
  sheetHistorySheetDates,
  sheetUsesHistory,
  type SheetEval,
  type SheetModel,
} from "./sheet";
import {
  collectCrossRefs,
  ferr,
  isErr,
  type FErr,
  type FxResolver,
  type HistoryResolver,
} from "./formula";
import { endOfLocalDay, historySheetSnapshots, makeHistoryResolver } from "./history-facts";
import { makeFxResolver, type FxRatesState } from "./fx";

export type DashboardSheetState =
  | { model: SheetModel; ev: SheetEval }
  | { error: string };

const cache = new Map<string, Promise<Map<string, DashboardSheetState>>>();

/** The whole rate table keys the cache, not just USD→EUR (SUB-834): a sheet
    may convert any quoted pair, so two tables that agree on that one pair
    while differing elsewhere are NOT interchangeable evaluations. */
function ratesKey(rates: FxRatesState | null): string {
  if (!rates) return "none";
  const pairs = Object.entries(rates.rates)
    .map(([code, rate]) => `${code.toUpperCase()}=${rate}`)
    .sort();
  return `${rates.base}|${rates.asOf}|${pairs.join(",")}`;
}

function cacheKey(sheetNames: string[], vaultEpoch: number, rates: FxRatesState | null): string {
  const names = [...new Set(sheetNames.map((name) => name.toLowerCase()))].sort();
  return `${vaultEpoch}\u0000${ratesKey(rates)}\u0000${names.join("\u0000")}`;
}

/** The history resolver for a loaded set of sheets, or undefined when none of
    them reads a frontmatter fact. One `history_facts` call for the whole set:
    a dashboard showing five views of the same weight lane builds it once —
    though a chart on the same dashboard prefetches through `useHistory`
    instead, so the two paths fetch the same lanes separately (SUB-832; the
    cost is stated in docs/sheets-spec.md). A failed fetch does not fail the
    pass: it yields a resolver that reports every fact as not loaded yet, which
    is what a transient IPC failure means — dropping the resolver entirely
    would instead tell the reader history is not available here, i.e. that the
    dashboard cannot do time travel at all.

    `AT(date, Sheet.member)` needs whole sheets rather than a fact lane (§3.2),
    so the days those reads name are collected in the same pass and fetched
    alongside — one `history_sheets` call, one repository walk, however many
    sheets read a given day. */
async function loadHistory(
  models: Map<string, SheetModel | FErr>,
  fx: FxResolver
): Promise<HistoryResolver | undefined> {
  const sheets = [...models.values()].filter(
    (m): m is SheetModel => !isErr(m) && sheetUsesHistory(m)
  );
  if (sheets.length === 0) return undefined;
  const refs = new Map<string, { path: string; key: string }>();
  const days = new Set<string>();
  for (const m of sheets) {
    for (const r of sheetHistoryRefs(m)) refs.set(`${r.path}\t${r.key}`, { path: r.path, key: r.key });
    for (const d of sheetHistorySheetDates(m)) days.add(d);
  }
  const dates = [...days];
  const instants = dates.map(endOfLocalDay).filter((i): i is number => i !== null);
  try {
    const [notes, lanes, ats] = await Promise.all([
      vaultList(),
      refs.size ? historyFacts([...refs.values()]) : Promise.resolve([]),
      instants.length ? historySheets(instants) : Promise.resolve([]),
    ]);
    const hist = makeHistoryResolver(notes, lanes);
    if (ats.length) {
      hist.sheetValue = makeHistorySheetValue(historySheetSnapshots(dates, ats), hist, fx);
    }
    return hist;
  } catch {
    // undefined would mean "this surface has no history at all"; the truthful
    // answer to a failed fetch is "not loaded yet", for present-tense reads too
    return () => ({ kind: "pending" });
  }
}

/** Load and evaluate a set of sheet roots plus their transitive cross-sheet
    references. Dashboard surfaces share the in-flight/result promise for the
    SAME root set at one vault epoch and FX rate, so composing five views of
    one sheet remains one IPC/BFS/evaluation pass rather than five. The key is
    the whole deduped set — surfaces bound to different (even overlapping)
    sets load independently. The sheet-type check folds the frontmatter key
    and value (`Type: Sheet` counts), matching the cards path. */
export function dashboardSheets(
  sheetNames: string[],
  vaultEpoch: number,
  rates: FxRatesState | null,
): Promise<Map<string, DashboardSheetState>> {
  const key = cacheKey(sheetNames, vaultEpoch, rates);
  const hit = cache.get(key);
  if (hit) return hit;

  // Epoch/rate keys make stale reuse impossible. Bound retained history so a
  // long-running app does not keep every old evaluated sheet graph forever.
  if (cache.size >= 64) cache.clear();

  const pending = (async () => {
    const models = new Map<string, SheetModel | FErr>();
    const queue = [...sheetNames];
    const queued = new Set(queue.map((name) => name.toLowerCase()));
    while (queue.length > 0) {
      const name = queue.shift()!;
      try {
        const resolved = await vaultResolve(name);
        if (!resolved) {
          models.set(name.toLowerCase(), ferr(`no note named “${name}”`));
          continue;
        }
        if (foldedPropStr(resolved.props, "type")?.toLowerCase() !== "sheet") {
          models.set(name.toLowerCase(), ferr(`“${name}” is not a sheet`));
          continue;
        }
        const content = await vaultRead(resolved.path);
        const model = parseSheet(content.body);
        models.set(name.toLowerCase(), model);
        for (const formula of model.formulas) {
          if (isErr(formula.expr)) continue;
          for (const ref of collectCrossRefs(formula.expr)) {
            if (!queued.has(ref.sheet)) {
              queued.add(ref.sheet);
              queue.push(ref.sheet);
            }
          }
        }
      } catch (error) {
        models.set(name.toLowerCase(), ferr(String(error)));
      }
    }

    // One shared resolver over the whole quoted table (SUB-834) — the same
    // one sheets, cards and charts use, so a GBP column converts here exactly
    // as it does in the grid.
    const fxResolver: FxResolver = makeFxResolver(rates);
    // Past facts, prefetched before evaluation (SUB-832): here the load is
    // already async, so the sheets' history rides the same pass as their
    // cross-sheet BFS rather than needing a store. Gated on a sheet actually
    // asking — a dashboard of plain sheets never lists the vault. The cache
    // key already carries the vault epoch, which is what moves a lane.
    const histResolver = await loadHistory(models, fxResolver);
    const load = (name: string) =>
      models.get(name.toLowerCase()) ?? ferr(`no sheet named “${name}”`);
    const result = new Map<string, DashboardSheetState>();
    for (const name of sheetNames) {
      const model = models.get(name.toLowerCase());
      if (!model || isErr(model)) {
        result.set(name.toLowerCase(), { error: model ? model.err : "not loaded" });
        continue;
      }
      result.set(name.toLowerCase(), {
        model,
        ev: evaluateSheet(model, fxResolver, { self: name, load }, undefined, histResolver),
      });
    }
    return result;
  })();
  // A rejected pass must not stay cached for the rest of the epoch — one
  // thrown evaluation would poison every surface bound to these roots with
  // no retry until the next vault refresh. Evict so the next render retries.
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  cache.set(key, pending);
  return pending;
}
